use std::collections::VecDeque;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const DEFAULT_MAX_EVENTS: usize = 100_000;
const DEFAULT_MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_EVENT_BYTES: usize = 16 * 1024;
const MAX_STRING_BYTES: usize = 2048;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogMode {
    Off,
    Buffer,
    Pretty,
}

impl LogMode {
    pub fn from_env() -> Self {
        match std::env::var("TANSU_LOGS").as_deref() {
            Ok("buffer") => Self::Buffer,
            Ok("pretty") => Self::Pretty,
            _ => Self::Off,
        }
    }

    fn prints(self) -> bool {
        matches!(self, Self::Pretty)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogSource {
    Server,
    Client,
    Harness,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEvent {
    pub seq: u64,
    pub ts: u64,
    pub source: LogSource,
    pub level: LogLevel,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(flatten)]
    pub fields: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingLogEvent {
    pub source: LogSource,
    pub level: LogLevel,
    pub kind: String,
    pub request_id: Option<String>,
    #[serde(flatten)]
    pub fields: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingLogBatch {
    pub events: Vec<IncomingLogEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogSnapshot {
    pub events: Vec<LogEvent>,
}

#[derive(Clone)]
pub struct LogHub {
    #[cfg(debug_assertions)]
    inner: Arc<LogHubInner>,
}

#[cfg(debug_assertions)]
struct LogHubInner {
    mode: LogMode,
    max_events: usize,
    max_bytes: usize,
    state: Mutex<LogState>,
}

#[cfg(debug_assertions)]
struct LogState {
    next_seq: u64,
    bytes: usize,
    events: VecDeque<StoredLogEvent>,
    subscribers: Vec<Sender<LogEvent>>,
}

#[cfg(debug_assertions)]
struct StoredLogEvent {
    bytes: usize,
    event: LogEvent,
}

impl LogHub {
    pub fn from_env() -> Self {
        Self::new(LogMode::from_env())
    }

    pub fn new(mode: LogMode) -> Self {
        #[cfg(debug_assertions)]
        {
            Self {
                inner: Arc::new(LogHubInner {
                    mode,
                    max_events: DEFAULT_MAX_EVENTS,
                    max_bytes: DEFAULT_MAX_BYTES,
                    state: Mutex::new(LogState {
                        next_seq: 1,
                        bytes: 0,
                        events: VecDeque::new(),
                        subscribers: Vec::new(),
                    }),
                }),
            }
        }
        #[cfg(not(debug_assertions))]
        {
            let _ = mode;
            Self {}
        }
    }

    pub fn enabled(&self) -> bool {
        #[cfg(debug_assertions)]
        {
            !matches!(self.inner.mode, LogMode::Off)
        }
        #[cfg(not(debug_assertions))]
        {
            false
        }
    }

    pub fn ingest(&self, incoming: IncomingLogEvent) {
        #[cfg(debug_assertions)]
        {
            if matches!(self.inner.mode, LogMode::Off) {
                return;
            }
            let event = sanitize_event(LogEvent {
                seq: 0,
                ts: now_ms(),
                source: incoming.source,
                level: incoming.level,
                kind: truncate_string(incoming.kind, 128),
                request_id: incoming.request_id.map(|value| truncate_string(value, 128)),
                fields: sanitize_map(incoming.fields),
            });
            self.push(event);
        }
        #[cfg(not(debug_assertions))]
        {
            let _ = incoming;
        }
    }

    pub fn server_event(
        &self,
        level: LogLevel,
        kind: &str,
        request_id: Option<String>,
        fields: Map<String, Value>,
    ) {
        self.ingest(IncomingLogEvent {
            source: LogSource::Server,
            level,
            kind: kind.to_string(),
            request_id,
            fields,
        });
    }

    pub fn snapshot(&self) -> LogSnapshot {
        #[cfg(debug_assertions)]
        {
            let state = self.inner.state.lock().expect("log hub mutex poisoned");
            LogSnapshot {
                events: state
                    .events
                    .iter()
                    .map(|stored| stored.event.clone())
                    .collect(),
            }
        }
        #[cfg(not(debug_assertions))]
        {
            LogSnapshot { events: Vec::new() }
        }
    }

    pub fn subscribe(&self) -> Option<Receiver<LogEvent>> {
        #[cfg(debug_assertions)]
        {
            if !self.enabled() {
                return None;
            }
            let (tx, rx) = mpsc::channel();
            let mut state = self.inner.state.lock().expect("log hub mutex poisoned");
            state.subscribers.push(tx);
            Some(rx)
        }
        #[cfg(not(debug_assertions))]
        {
            None
        }
    }

    #[cfg(debug_assertions)]
    fn push(&self, mut event: LogEvent) {
        {
            let mut state = self.inner.state.lock().expect("log hub mutex poisoned");
            event.seq = state.next_seq;
            state.next_seq += 1;
            let bytes = serialized_len(&event);
            state.bytes += bytes;
            state.events.push_back(StoredLogEvent {
                bytes,
                event: event.clone(),
            });
            while state.events.len() > self.inner.max_events || state.bytes > self.inner.max_bytes {
                if let Some(removed) = state.events.pop_front() {
                    state.bytes = state.bytes.saturating_sub(removed.bytes);
                } else {
                    break;
                }
            }
            state
                .subscribers
                .retain(|tx| tx.send(event.clone()).is_ok());
        }
        if self.inner.mode.prints() {
            print_event(&event);
        }
    }
}

pub fn fields(items: impl IntoIterator<Item = (&'static str, Value)>) -> Map<String, Value> {
    items
        .into_iter()
        .map(|(key, value)| (key.to_string(), value))
        .collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn sanitize_event(mut event: LogEvent) -> LogEvent {
    let bytes = serialized_len(&event);
    if bytes <= MAX_EVENT_BYTES {
        return event;
    }
    let summary = Value::String(truncate_string(
        serde_json::to_string(&event.fields).unwrap_or_default(),
        MAX_EVENT_BYTES / 2,
    ));
    event.fields = fields([
        ("truncated", Value::Bool(true)),
        ("originalBytes", Value::from(bytes as u64)),
        ("summary", summary),
    ]);
    event
}

fn sanitize_map(map: Map<String, Value>) -> Map<String, Value> {
    map.into_iter()
        .map(|(key, value)| (truncate_string(key, 128), sanitize_value(value)))
        .collect()
}

fn sanitize_value(value: Value) -> Value {
    match value {
        Value::String(value) => Value::String(truncate_string(value, MAX_STRING_BYTES)),
        Value::Array(values) => {
            Value::Array(values.into_iter().take(32).map(sanitize_value).collect())
        }
        Value::Object(map) => Value::Object(sanitize_map(map.into_iter().take(32).collect())),
        other => other,
    }
}

fn truncate_string(mut value: String, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
    value.push_str("...");
    value
}

fn serialized_len<T: Serialize>(value: &T) -> usize {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .unwrap_or(0)
}

#[cfg(debug_assertions)]
fn print_event(event: &LogEvent) {
    println!("{}", serde_json::to_string(event).expect("log event is serializable"));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assigns_order_and_keeps_snapshot() {
        let hub = LogHub::new(LogMode::Buffer);
        hub.server_event(
            LogLevel::Info,
            "system.event",
            None,
            fields([("one", Value::from(1))]),
        );
        hub.server_event(
            LogLevel::Warn,
            "system.event",
            None,
            fields([("two", Value::from(2))]),
        );

        let events = hub.snapshot().events;
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].seq, 1);
        assert_eq!(events[1].seq, 2);
        assert_eq!(events[0].fields["one"], Value::from(1));
    }

    #[test]
    fn fans_out_to_subscribers() {
        let hub = LogHub::new(LogMode::Buffer);
        let rx = hub.subscribe().unwrap();
        hub.server_event(LogLevel::Error, "system.event", None, Map::new());

        let event = rx.recv().unwrap();
        assert_eq!(event.seq, 1);
        assert_eq!(event.level, LogLevel::Error);
    }

    #[test]
    fn truncates_large_fields() {
        let hub = LogHub::new(LogMode::Buffer);
        hub.server_event(
            LogLevel::Info,
            "system.event",
            None,
            fields([("large", Value::String("x".repeat(MAX_STRING_BYTES + 100)))]),
        );

        let mut events = hub.snapshot().events;
        let event = events.remove(0);
        assert!(event.fields["large"].as_str().unwrap().len() <= MAX_STRING_BYTES + 3);
    }

    #[test]
    fn bounds_nested_values_and_oversized_events() {
        let hub = LogHub::new(LogMode::Buffer);
        let mut nested = Map::new();
        nested.insert(
            "long-key-".to_string() + &"x".repeat(140),
            Value::String("三".repeat(1000)),
        );
        nested.insert(
            "items".to_string(),
            Value::Array((0..40).map(Value::from).collect()),
        );
        let mut fields = Map::new();
        fields.insert("nested".to_string(), Value::Object(nested));
        for index in 0..10 {
            fields.insert(
                format!("large-{index}"),
                Value::String("x".repeat(MAX_STRING_BYTES)),
            );
        }
        hub.ingest(IncomingLogEvent {
            source: LogSource::Harness,
            level: LogLevel::Info,
            kind: "k".repeat(140),
            request_id: Some("r".repeat(140)),
            fields,
        });

        let event = hub.snapshot().events.remove(0);
        assert!(event.kind.len() <= 131);
        assert!(event.request_id.as_deref().unwrap().len() <= 131);
        assert!(event.fields.get("truncated").unwrap().as_bool().unwrap());
        assert!(event.fields.get("summary").unwrap().as_str().unwrap().len() <= MAX_EVENT_BYTES / 2 + 3);

        let nested_event = sanitize_map(Map::from_iter([(
            "nested".to_string(),
            Value::Object(Map::from_iter([
                ("key-".to_string() + &"x".repeat(140), Value::String("三".repeat(1000))),
                ("items".to_string(), Value::Array((0..40).map(Value::from).collect())),
            ])),
        )]));
        let nested = nested_event["nested"].as_object().unwrap();
        let (key, value) = nested.iter().find(|(key, _)| key.starts_with("key-")).unwrap();
        assert!(key.len() <= 131);
        assert_eq!(value.as_str().unwrap().len(), 2049);
        assert_eq!(nested["items"].as_array().unwrap().len(), 32);
    }

    #[test]
    fn off_mode_neither_stores_events_nor_subscribes() {
        let hub = LogHub::new(LogMode::Off);
        assert!(!hub.enabled());
        assert!(hub.subscribe().is_none());
        hub.server_event(LogLevel::Error, "system.event", None, Map::new());
        assert!(hub.snapshot().events.is_empty());
    }

    #[test]
    fn removes_subscribers_after_receivers_are_dropped() {
        let hub = LogHub::new(LogMode::Buffer);
        let receiver = hub.subscribe().unwrap();
        drop(receiver);
        hub.server_event(LogLevel::Info, "system.event", None, Map::new());
        assert!(hub.inner.state.lock().unwrap().subscribers.is_empty());
    }

    #[test]
    fn accepts_structured_client_payload_fields() {
        let batch: IncomingLogBatch = serde_json::from_value(serde_json::json!({
            "events": [
                {
                    "source": "client",
                    "level": "info",
                    "kind": "client.api",
                    "requestId": "cli-1",
                    "client": { "seq": 1, "url": "http://127.0.0.1:3000/" },
                    "http": { "method": "GET", "path": "/api/v2/bootstrap", "status": 200 }
                }
            ]
        }))
        .unwrap();

        let hub = LogHub::new(LogMode::Buffer);
        hub.ingest(batch.events.into_iter().next().unwrap());
        let event = hub.snapshot().events.remove(0);

        assert_eq!(event.source, LogSource::Client);
        assert_eq!(event.request_id.as_deref(), Some("cli-1"));
        assert_eq!(event.fields["client"]["seq"], Value::from(1));
        assert_eq!(event.fields["http"]["path"], Value::from("/api/v2/bootstrap"));
    }

}
