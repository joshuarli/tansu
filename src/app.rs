use std::sync::Arc;

use crate::api_types::V2BootstrapResponse;
use crate::api_types::AppSettings;
use crate::config::{Config, ConfigStore, initialize_state_layout};
use crate::logging::{LogHub, LogLevel, fields};
use crate::vault::{EventSubscription, VaultRuntime};
use crate::{Error, Result};

#[derive(Clone)]
pub struct App {
    vaults: Arc<Vec<Arc<VaultRuntime>>>,
    server_instance_id: Arc<String>,
    logs: LogHub,
    config_store: Option<ConfigStore>,
}

impl App {
    pub fn new(config: Config) -> Result<Self> {
        Self::from_config(config, LogHub::from_env(), None)
    }

    pub fn from_settings(config: Config, config_store: ConfigStore) -> Result<Self> {
        Self::from_config(config, LogHub::from_env(), Some(config_store))
    }

    pub fn setup_only(config_store: ConfigStore) -> Self {
        Self {
            vaults: Arc::new(Vec::new()),
            server_instance_id: Arc::new("setup".to_string()),
            logs: LogHub::from_env(),
            config_store: Some(config_store),
        }
    }

    fn from_config(config: Config, logs: LogHub, config_store: Option<ConfigStore>) -> Result<Self> {
        let (server_instance_id, vault_configs) = initialize_state_layout(&config.vaults)?;
        let mut runtimes = Vec::new();
        for (index, vault) in vault_configs.iter().enumerate() {
            runtimes.push(Arc::new(VaultRuntime::open(index, vault, logs.clone())?));
        }
        let app = Self {
            vaults: Arc::new(runtimes),
            server_instance_id: Arc::new(server_instance_id),
            logs,
            config_store,
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
            vault.start_search_worker()?;
            vault.start_watcher()?;
        }
        Ok(app)
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

    pub fn setup_mode(&self) -> bool {
        self.vaults.is_empty()
    }

    pub fn app_settings(&self) -> Result<Option<AppSettings>> {
        self.config_store
            .as_ref()
            .map(ConfigStore::settings)
            .unwrap_or(Ok(None))
    }

    pub fn save_app_settings(&self, settings: &AppSettings) -> Result<()> {
        self.config_store
            .as_ref()
            .ok_or_else(|| Error::Internal("application settings store is unavailable".to_string()))?
            .save_settings(settings)
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

    pub fn shutdown(&self) {
        for vault in self.vaults.iter() {
            vault.shutdown();
        }
    }

    pub fn logs(&self) -> &LogHub {
        &self.logs
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logging::LogMode;
    use tempfile::TempDir;

    fn config(root: &TempDir) -> Config {
        Config {
            vaults: vec![crate::config::VaultConfig {
                name: "Notes".to_string(),
                path: root.path().join("notes"),
                state_path: root.path().join("state"),

            }],
            auth: None,
        }
    }

    #[test]
    fn app_records_startup_and_resolves_v2_event_subscriptions_by_vault_id() {
        let root = tempfile::tempdir().unwrap();
        let logs = LogHub::new(LogMode::Buffer);
        let app = App::from_config(config(&root), logs.clone(), None).unwrap();
        let startup = logs.snapshot();
        assert!(startup.events.iter().any(|event| {
            event.fields["system"]["component"] == "startup"
                && event.fields["system"]["action"] == "app_open"
        }));

        let vault_id = app.v2_bootstrap().vaults[0].vault_id.clone();
        let subscription = app.subscribe_v2_events(&vault_id, None).unwrap();
        assert_eq!(subscription.current_version, 0);
        assert!(subscription.replay.is_empty());
        assert!(!subscription.resync_required);
        assert!(app.subscribe_v2_events("missing", None).is_err());
    }
}
