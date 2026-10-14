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
    Json,
}

impl LogMode {
    pub fn from_env() -> Self {
        match std::env::var("TANSU2_LOGS").as_deref() {
            Ok("buffer") => Self::Buffer,
            Ok("pretty") => Self::Pretty,
            Ok("json") => Self::Json,
            _ => Self::Off,
        }
    }

    fn prints(self) -> bool {
        matches!(self, Self::Pretty | Self::Json)
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
            print_event(self.inner.mode, &event);
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
fn print_event(mode: LogMode, event: &LogEvent) {
    match mode {
        LogMode::Json => {
            if let Ok(json) = serde_json::to_string(event) {
                println!("{json}");
            }
        }
        LogMode::Pretty => {
            let timestamp = format_timestamp(event.ts);
            let level = format_level(event.level);
            let source = color(source_color(event.source), log_source_label(event.source));
            let kind = color(kind_color(event.level), &event.kind);
            let summary = style_detail(event.level, &pretty_summary(event));
            let payload = pretty_payload(event);
            let request = event
                .request_id
                .as_deref()
                .map(|value| format!(" {}", color(CYAN, &format!("req={value}"))))
                .unwrap_or_default();
            println!(
                "{} {} {} {}{}{}{}",
                color(DIM, &timestamp),
                level,
                source,
                kind,
                request,
                summary,
                payload,
            );
        }
        LogMode::Off | LogMode::Buffer => {}
    }
}

#[cfg(debug_assertions)]
const RESET: &str = "\x1b[0m";
#[cfg(debug_assertions)]
const BOLD: &str = "\x1b[1m";
#[cfg(debug_assertions)]
const DIM: &str = "\x1b[2m";
#[cfg(debug_assertions)]
const RED: &str = "\x1b[31m";
#[cfg(debug_assertions)]
const YELLOW: &str = "\x1b[33m";
#[cfg(debug_assertions)]
const BLUE: &str = "\x1b[34m";
#[cfg(debug_assertions)]
const MAGENTA: &str = "\x1b[35m";
#[cfg(debug_assertions)]
const CYAN: &str = "\x1b[36m";
#[cfg(debug_assertions)]
const GRAY: &str = "\x1b[90m";

#[cfg(debug_assertions)]
fn color(code: &str, text: &str) -> String {
    format!("{code}{text}{RESET}")
}

#[cfg(debug_assertions)]
fn format_level(level: LogLevel) -> String {
    let (code, label) = match level {
        LogLevel::Debug => (GRAY, "DEBUG"),
        LogLevel::Info => (GRAY, "INFO "),
        LogLevel::Warn => (YELLOW, "WARN "),
        LogLevel::Error => (RED, "ERROR"),
    };
    color(code, label)
}

#[cfg(debug_assertions)]
fn source_color(source: LogSource) -> &'static str {
    match source {
        LogSource::Server => BLUE,
        LogSource::Client => MAGENTA,
        LogSource::Harness => CYAN,
    }
}

#[cfg(debug_assertions)]
fn kind_color(level: LogLevel) -> &'static str {
    match level {
        LogLevel::Debug | LogLevel::Info => GRAY,
        LogLevel::Warn | LogLevel::Error => BOLD,
    }
}

#[cfg(debug_assertions)]
fn style_detail(level: LogLevel, text: &str) -> String {
    match level {
        LogLevel::Debug | LogLevel::Info => color(DIM, text),
        LogLevel::Warn | LogLevel::Error => text.to_string(),
    }
}

#[cfg(debug_assertions)]
fn log_source_label(source: LogSource) -> &'static str {
    match source {
        LogSource::Server => "server",
        LogSource::Client => "client",
        LogSource::Harness => "harness",
    }
}

#[cfg(debug_assertions)]
fn pretty_summary(event: &LogEvent) -> String {
    let mut parts = Vec::new();
    match event.kind.as_str() {
        "http.request" | "client.api" | "http.request_failed" => {
            if let Some(http) = object_field(event, "http") {
                push_string(http, &mut parts, "method");
                push_string(http, &mut parts, "path");
                push_string(http, &mut parts, "url");
                push_u64(http, &mut parts, "status");
                push_u64_with_suffix(http, &mut parts, "durationMs", "ms");
                push_u64_with_name(http, &mut parts, "vault", "vault");
                push_string(http, &mut parts, "failure");
            }
        }
        "note.mutation"
        | "note.read"
        | "note.pin"
        | "note.create"
        | "note.save"
        | "note.rename"
        | "note.delete"
        | "note.apply_mutation" => {
            if let Some(mutation) = object_field(event, "mutation") {
                push_string_named(mutation, &mut parts, "action", "action");
            }
            if let Some(read) = object_field(event, "read") {
                push_string_named(read, &mut parts, "action", "action");
            }
            if let Some(note) = object_field(event, "note") {
                push_string_named(note, &mut parts, "path", "path");
                push_string_named(note, &mut parts, "id", "note");
                push_u64_with_name(note, &mut parts, "vault", "vault");
            }
        }
        "client.command" => {
            if let Some(command) = object_field(event, "command") {
                push_string_named(command, &mut parts, "id", "cmd");
                push_string_named(command, &mut parts, "action", "action");
            }
        }
        "client.editor" => {
            if let Some(editor) = object_field(event, "editor") {
                push_string_named(editor, &mut parts, "action", "editor");
                push_bool(editor, &mut parts, "sourceMode");
                push_bool_named(editor, &mut parts, "reading", "reading");
            }
        }
        "client.search" | "search.query" => {
            if let Some(search) = object_field(event, "search") {
                push_string_named(search, &mut parts, "surface", "surface");
                push_string_named(search, &mut parts, "action", "action");
                push_u64_with_name(search, &mut parts, "hits", "hits");
                push_u64_with_name(search, &mut parts, "queryLength", "qlen");
            }
        }
        "system.event" => {
            if let Some(system) = object_field(event, "system") {
                let component = string_value(system, "component");
                let action = string_value(system, "action");
                if let (Some(component), Some(action)) = (component, action) {
                    parts.push(format!("{component}/{action}"));
                }
            }
        }
        "client.error" => {
            if let Some(error) = object_field(event, "error") {
                push_string_named(error, &mut parts, "name", "error");
                push_string_named(error, &mut parts, "message", "msg");
            }
        }
        _ => {}
    }
    if let Some(error) = event.fields.get("error")
        && !error.is_null()
    {
        parts.push(format!("error={}", compact_value(error)));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!(" {}", parts.join(" "))
    }
}

#[cfg(debug_assertions)]
fn pretty_payload(event: &LogEvent) -> String {
    if event.fields.is_empty() {
        return String::new();
    }
    let Ok(json) = serde_json::to_string(&event.fields) else {
        return String::new();
    };
    format!(" {}", color(DIM, &json))
}

#[cfg(debug_assertions)]
fn object_field<'a>(event: &'a LogEvent, key: &str) -> Option<&'a Map<String, Value>> {
    event.fields.get(key)?.as_object()
}

#[cfg(debug_assertions)]
fn string_value<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key)?.as_str()
}

#[cfg(debug_assertions)]
fn push_string(object: &Map<String, Value>, parts: &mut Vec<String>, key: &str) {
    if let Some(value) = string_value(object, key) {
        parts.push(value.to_string());
    }
}

#[cfg(debug_assertions)]
fn push_string_named(object: &Map<String, Value>, parts: &mut Vec<String>, key: &str, name: &str) {
    if let Some(value) = string_value(object, key) {
        parts.push(format!("{name}={value}"));
    }
}

#[cfg(debug_assertions)]
fn push_u64(object: &Map<String, Value>, parts: &mut Vec<String>, key: &str) {
    if let Some(value) = object.get(key).and_then(Value::as_u64) {
        parts.push(value.to_string());
    }
}

#[cfg(debug_assertions)]
fn push_u64_with_name(object: &Map<String, Value>, parts: &mut Vec<String>, key: &str, name: &str) {
    if let Some(value) = object.get(key).and_then(Value::as_u64) {
        parts.push(format!("{name}={value}"));
    }
}

#[cfg(debug_assertions)]
fn push_u64_with_suffix(
    object: &Map<String, Value>,
    parts: &mut Vec<String>,
    key: &str,
    suffix: &str,
) {
    if let Some(value) = object.get(key).and_then(Value::as_u64) {
        parts.push(format!("{value}{suffix}"));
    }
}

#[cfg(debug_assertions)]
fn push_bool(object: &Map<String, Value>, parts: &mut Vec<String>, key: &str) {
    if let Some(value) = object.get(key).and_then(Value::as_bool) {
        parts.push(format!("{key}={value}"));
    }
}

#[cfg(debug_assertions)]
fn push_bool_named(object: &Map<String, Value>, parts: &mut Vec<String>, key: &str, name: &str) {
    if let Some(value) = object.get(key).and_then(Value::as_bool) {
        parts.push(format!("{name}={value}"));
    }
}

#[cfg(debug_assertions)]
fn compact_value(value: &Value) -> String {
    match value {
        Value::Object(object) => {
            if let Some(code) = object.get("code").and_then(Value::as_str) {
                return code.to_string();
            }
            if let Some(message) = object.get("message").and_then(Value::as_str) {
                return message.to_string();
            }
            serde_json::to_string(value).unwrap_or_default()
        }
        Value::String(value) => value.clone(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

#[cfg(debug_assertions)]
fn format_timestamp(ms: u64) -> String {
    let seconds = ms / 1000;
    let millis = ms % 1000;
    let days = (seconds / 86_400) as i64;
    let seconds_of_day = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3600;
    let minute = (seconds_of_day % 3600) / 60;
    let second = seconds_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

#[cfg(debug_assertions)]
fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if month <= 2 { 1 } else { 0 };
    (year, month as u32, day as u32)
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

    #[test]
    fn formats_standard_utc_timestamps() {
        assert_eq!(format_timestamp(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            format_timestamp(1_717_777_777_123),
            "2024-06-07T16:29:37.123Z"
        );
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
    }

    #[test]
    fn pretty_summaries_cover_log_event_shapes() {
        let http = event(
            "http.request",
            serde_json::json!({
                "http": {
                    "method": "GET",
                    "path": "/notes",
                    "url": "https://notes.example/notes",
                    "status": 200,
                    "durationMs": 3,
                    "vault": 2,
                    "failure": "timeout"
                },
                "error": {"code": "io_error"}
            }),
        );
        let http_summary = pretty_summary(&http);
        for value in ["GET", "/notes", "200", "3ms", "vault=2", "timeout", "error=io_error"] {
            assert!(http_summary.contains(value));
        }

        let note = event(
            "note.save",
            serde_json::json!({
                "mutation": {"action": "save"},
                "read": {"action": "open"},
                "note": {"path": "A.md", "id": "n1", "vault": 1}
            }),
        );
        let note_summary = pretty_summary(&note);
        for value in ["action=save", "action=open", "path=A.md", "note=n1", "vault=1"] {
            assert!(note_summary.contains(value));
        }

        let command = event("client.command", serde_json::json!({"command": {"id": "save", "action": "run"}}));
        assert!(pretty_summary(&command).contains("cmd=save action=run"));
        let editor = event("client.editor", serde_json::json!({"editor": {"action": "change", "sourceMode": true, "reading": false}}));
        assert!(pretty_summary(&editor).contains("editor=change sourceMode=true reading=false"));
        let search = event("search.query", serde_json::json!({"search": {"surface": "vault", "action": "submit", "hits": 4, "queryLength": 7}}));
        assert!(pretty_summary(&search).contains("surface=vault action=submit hits=4 qlen=7"));
        let system = event("system.event", serde_json::json!({"system": {"component": "watcher", "action": "restart"}}));
        assert!(pretty_summary(&system).contains("watcher/restart"));
        let client_error = event("client.error", serde_json::json!({"error": {"name": "TypeError", "message": "failed"}}));
        assert!(pretty_summary(&client_error).contains("error=TypeError msg=failed"));
        assert!(pretty_summary(&event("other", serde_json::json!({}))).is_empty());

        let pretty_event = LogEvent {
            seq: 1,
            ts: 0,
            source: LogSource::Harness,
            level: LogLevel::Warn,
            kind: "system.event".to_string(),
            request_id: Some("req-1".to_string()),
            fields: Map::new(),
        };
        assert!(pretty_payload(&pretty_event).is_empty());
        assert!(pretty_payload(&event("other", serde_json::json!({"value": 1}))).contains("value"));
        assert_eq!(compact_value(&serde_json::json!({"code": "blocked", "message": "ignored"})), "blocked");
        assert_eq!(compact_value(&serde_json::json!({"message": "details"})), "details");
        assert_eq!(compact_value(&serde_json::json!({"other": 1})), "{\"other\":1}");
        assert_eq!(compact_value(&Value::String("plain".to_string())), "plain");
        assert_eq!(compact_value(&Value::Bool(true)), "true");

        for level in [LogLevel::Debug, LogLevel::Info, LogLevel::Warn, LogLevel::Error] {
            assert!(!format_level(level).is_empty());
            print_event(LogMode::Pretty, &LogEvent { level, ..pretty_event.clone() });
        }
        for source in [LogSource::Server, LogSource::Client, LogSource::Harness] {
            assert!(!source_color(source).is_empty());
            assert!(!log_source_label(source).is_empty());
            print_event(LogMode::Json, &LogEvent { source, ..pretty_event.clone() });
        }
        assert_eq!(kind_color(LogLevel::Debug), GRAY);
        assert_eq!(kind_color(LogLevel::Info), GRAY);
        assert_eq!(kind_color(LogLevel::Warn), BOLD);
        assert_eq!(kind_color(LogLevel::Error), BOLD);
        assert_eq!(style_detail(LogLevel::Info, "detail"), color(DIM, "detail"));
        assert_eq!(style_detail(LogLevel::Error, "detail"), "detail");
        assert!(!LogMode::Off.prints());
        assert!(!LogMode::Buffer.prints());
        assert!(LogMode::Pretty.prints());
        assert!(LogMode::Json.prints());
    }

    fn event(kind: &str, fields: Value) -> LogEvent {
        LogEvent {
            seq: 1,
            ts: 0,
            source: LogSource::Server,
            level: LogLevel::Info,
            kind: kind.to_string(),
            request_id: None,
            fields: fields.as_object().unwrap().clone(),
        }
    }
}
