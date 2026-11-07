use stats_producer::{OperationEvent, Producer, ProducerConfig};
use std::sync::OnceLock;

pub struct Telemetry {
    producer: Option<Producer>,
}

impl Telemetry {
    pub fn from_env() -> Self {
        Self { producer: producer_from_env() }
    }

    pub fn new(producer: Producer) -> Self {
        Self { producer: Some(producer) }
    }

    pub fn record(&self, operation: &str, outcome: &str, duration_ms: u64, work: impl IntoIterator<Item = (&'static str, u64)>) {
        let Some(producer) = &self.producer else { return };
        let mut event = OperationEvent::new(operation, outcome, duration_ms);
        for (key, value) in work {
            event.work.insert(key.to_owned(), value);
        }
        producer.record(event);
    }

    pub fn flush(&self) {
        if let Some(producer) = &self.producer {
            let _ = producer.flush();
        }
    }

    pub fn shutdown(&self) {
        if let Some(producer) = &self.producer {
            let _ = producer.shutdown();
        }
    }

    pub fn dropped(&self) -> u64 {
        self.producer.as_ref().map_or(0, |producer| producer.stats().dropped)
    }

    pub fn last_error(&self) -> Option<String> {
        self.producer.as_ref().and_then(|producer| producer.stats().last_error)
    }
}

static TELEMETRY: OnceLock<Telemetry> = OnceLock::new();

pub fn init() {
    let _ = TELEMETRY.set(Telemetry::from_env());
}

pub fn init_with(telemetry: Telemetry) -> bool {
    TELEMETRY.set(telemetry).is_ok()
}

pub fn record(operation: &str, outcome: &str, duration_ms: u64, work: impl IntoIterator<Item = (&'static str, u64)>) {
    if let Some(telemetry) = TELEMETRY.get() {
        telemetry.record(operation, outcome, duration_ms, work);
    }
}

pub fn flush() {
    if let Some(telemetry) = TELEMETRY.get() {
        telemetry.flush();
    }
}

pub fn shutdown() {
    if let Some(telemetry) = TELEMETRY.get() {
        telemetry.shutdown();
    }
}

pub fn dropped() -> u64 {
    TELEMETRY.get().map_or(0, Telemetry::dropped)
}

pub fn last_error() -> Option<String> {
    TELEMETRY.get().and_then(Telemetry::last_error)
}

fn producer_from_env() -> Option<Producer> {
    let endpoint = env_value("TANSU_STATS_ENDPOINT")?;
    let token = env_value("TANSU_STATS_TOKEN")?;
    let service = env_value("TANSU_STATS_SERVICE").unwrap_or_else(|| "tansu".to_owned());
    let release = env_value("TANSU_STATS_RELEASE").or_else(|| env_value("TANSU_RELEASE"))?;
    let mut config = ProducerConfig::new(endpoint, service, token, release);
    config.instance = env_value("TANSU_STATS_INSTANCE").or_else(|| env_value("HOSTNAME"));
    config.host = env_value("TANSU_STATS_HOST");
    Producer::new(config).ok()
}

fn env_value(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|value| value.trim().to_owned()).filter(|value| !value.is_empty())
}
