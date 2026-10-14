use std::sync::Arc;

use std::io::Write;
use std::net::TcpStream;

use crate::api_types::{V2BootstrapResponse, VaultEntry};
use crate::config::{Config, initialize_state_layout};
use crate::http::HttpRequest;
use crate::logging::{LogHub, LogLevel, fields};
use crate::vault::{EventSubscription, VaultRuntime};
use crate::{Error, Result};

#[derive(Clone)]
pub struct App {
    vaults: Arc<Vec<Arc<VaultRuntime>>>,
    server_instance_id: Arc<String>,
    logs: LogHub,
}

impl App {
    pub fn new(config: Config) -> Result<Self> {
        let logs = LogHub::from_env();
        let (server_instance_id, vault_configs) = initialize_state_layout(&config.vaults)?;
        let mut runtimes = Vec::new();
        for (index, vault) in vault_configs.iter().enumerate() {
            runtimes.push(Arc::new(VaultRuntime::open(index, vault, logs.clone())?));
        }
        let app = Self {
            vaults: Arc::new(runtimes),
            server_instance_id: Arc::new(server_instance_id),
            logs,
        };
        if app.logs.enabled() {
            app.logs.server_event(
                LogLevel::Info,
                "system.event",
                None,
                fields([
                    (
                        "system",
                        serde_json::json!({ "component": "startup", "action": "app_open" }),
                    ),
                    ("vaultCount", serde_json::json!(app.vaults.len())),
                ]),
            );
        }
        for vault in app.vaults.iter() {
            vault.start_search_worker();
            vault.start_watcher()?;
        }
        Ok(app)
    }

    pub fn vault(&self, index: usize) -> Result<Arc<VaultRuntime>> {
        self.vaults
            .get(index)
            .cloned()
            .ok_or_else(|| Error::BadRequest(format!("unknown vault index {index}")))
    }

    pub fn vault_by_id(&self, vault_id: &str) -> Result<Arc<VaultRuntime>> {
        self.vaults
            .iter()
            .find(|vault| vault.vault_id == vault_id)
            .cloned()
            .ok_or_else(|| Error::NotFound(format!("unknown vault ID {vault_id}")))
    }

    pub fn server_instance_id(&self) -> &str {
        self.server_instance_id.as_str()
    }

    pub fn v2_bootstrap(&self) -> V2BootstrapResponse {
        V2BootstrapResponse {
            api_version: 2,
            server_instance_id: self.server_instance_id().to_string(),
            vaults: self.vaults.iter().map(|vault| vault.vault_meta()).collect(),
        }
    }

    pub fn subscribe_v2_events(
        &self,
        vault_id: &str,
        after_event_version: Option<u64>,
    ) -> Result<EventSubscription> {
        self.vault_by_id(vault_id)?
            .subscribe_v2_events(after_event_version)
    }

    pub fn vault_entries(&self) -> Vec<VaultEntry> {
        self.vaults
            .iter()
            .map(|vault| VaultEntry {
                index: vault.index,
                name: vault.name.clone(),
            })
            .collect()
    }

    pub fn logs(&self) -> &LogHub {
        &self.logs
    }

    pub fn handle_events(&self, request: &HttpRequest, stream: &mut TcpStream) -> Result<()> {
        let vault_index = request
            .path
            .split_once('?')
            .and_then(|(_, query)| {
                query
                    .split('&')
                    .find_map(|pair| pair.split_once("vault=")?.1.parse().ok())
            })
            .unwrap_or(0);
        let vault = self.vault(vault_index)?;
        let rx = vault.subscribe()?;
        if self.logs.enabled() {
            self.logs.server_event(
                LogLevel::Info,
                "system.event",
                None,
                fields([
                    (
                        "system",
                        serde_json::json!({ "component": "sse", "action": "connect" }),
                    ),
                    ("vault", serde_json::json!(vault_index)),
                ]),
            );
        }
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\nX-Accel-Buffering: no\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n\r\nretry: 2000\n\n"
        )?;
        for event in rx {
            let json = serde_json::to_string(&event)?;
            stream.write_all(format!("event: message\ndata: {json}\n\n").as_bytes())?;
            stream.flush()?;
        }
        if self.logs.enabled() {
            self.logs.server_event(
                LogLevel::Info,
                "system.event",
                None,
                fields([
                    (
                        "system",
                        serde_json::json!({ "component": "sse", "action": "disconnect" }),
                    ),
                    ("vault", serde_json::json!(vault_index)),
                ]),
            );
        }
        Ok(())
    }

    pub fn handle_log_stream(&self, stream: &mut TcpStream) -> Result<()> {
        let Some(rx) = self.logs.subscribe() else {
            return Err(Error::NotFound("dev logs".to_string()));
        };
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\nX-Accel-Buffering: no\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n\r\nretry: 2000\n\n"
        )?;
        for event in rx {
            let json = serde_json::to_string(&event)?;
            stream.write_all(format!("event: message\ndata: {json}\n\n").as_bytes())?;
            stream.flush()?;
        }
        Ok(())
    }
}
