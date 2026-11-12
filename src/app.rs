use std::sync::Arc;

use crate::api_types::{V2BootstrapResponse, V2VaultMeta};
use crate::api_types::AppSettings;
use crate::config::{Config, ConfigStore, initialize_state_layout};
use crate::logging::{LogHub, LogLevel, fields};
use crate::vault::{EventSubscription, VaultRuntime};
use crate::{Error, Result};

#[derive(Clone)]
enum VaultEntry {
    Open(Arc<VaultRuntime>),
    Degraded {
        vault_id: String,
        name: String,
        message: String,
    },
}

impl VaultEntry {
    fn meta(&self) -> V2VaultMeta {
        match self {
            Self::Open(vault) => vault.vault_meta(),
            Self::Degraded {
                vault_id,
                name,
                message,
            } => V2VaultMeta {
                vault_id: vault_id.clone(),
                name: name.clone(),
                error: Some(message.clone()),
            },
        }
    }

    fn runtime(&self) -> Option<&Arc<VaultRuntime>> {
        match self {
            Self::Open(vault) => Some(vault),
            Self::Degraded { .. } => None,
        }
    }
}

#[derive(Clone)]
pub struct App {
    vaults: Arc<Vec<VaultEntry>>,
    server_instance_id: Arc<String>,
    release: Option<Arc<str>>,
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
            release: release_from_env(),
            logs: LogHub::from_env(),
            config_store: Some(config_store),
        }
    }

    fn from_config(config: Config, logs: LogHub, config_store: Option<ConfigStore>) -> Result<Self> {
        let (server_instance_id, vault_configs) = initialize_state_layout(&config.data_root, &config.vaults)?;
        let mut entries = Vec::with_capacity(vault_configs.len());
        for (index, vault) in vault_configs.iter().enumerate() {
            match VaultRuntime::open(index, vault, logs.clone()) {
                Ok(runtime) => entries.push(VaultEntry::Open(Arc::new(runtime))),
                Err(error) => {
                    if logs.enabled() {
                        logs.server_event(
                            LogLevel::Error,
                            "system.event",
                            None,
                            fields([
                                (
                                    "system",
                                    deser_value::value!({
                                        "component": "startup",
                                        "action": "vault_open_failed",
                                    }),
                                ),
                                ("vault", deser_value::value!(vault.vault_id.clone())),
                                ("name", deser_value::value!(vault.name.clone())),
                                ("error", deser_value::value!(error.to_string())),
                            ]),
                        );
                    }
                    entries.push(VaultEntry::Degraded {
                        vault_id: vault.vault_id.clone(),
                        name: vault.name.clone(),
                        message: vault_open_error_message(&error),
                    });
                }
            }
        }
        let app = Self {
            vaults: Arc::new(entries),
            server_instance_id: Arc::new(server_instance_id),
            release: release_from_env(),
            logs,
            config_store,
        };
        if app.logs.enabled() {
            let open_vaults = app.vaults.iter().filter(|entry| entry.runtime().is_some()).count();
            let degraded_vaults = app.vaults.len().saturating_sub(open_vaults);
            app.logs.server_event(
                LogLevel::Info,
                "system.event",
                None,
                fields([
                    (
                        "system",
                        deser_value::value!({ "component": "startup", "action": "app_open" }),
                    ),
                    ("vaultCount", deser_value::value!(app.vaults.len())),
                    ("openVaultCount", deser_value::value!(open_vaults)),
                    ("degradedVaultCount", deser_value::value!(degraded_vaults)),
                ]),
            );
        }
        for vault in app.vaults.iter().filter_map(VaultEntry::runtime) {
            vault.start_search_worker()?;
            vault.start_watcher()?;
        }
        Ok(app)
    }

    pub fn vault_by_id(&self, vault_id: &str) -> Result<Arc<VaultRuntime>> {
        match self
            .vaults
            .iter()
            .find(|entry| entry.meta().vault_id == vault_id)
        {
            Some(VaultEntry::Open(vault)) => Ok(vault.clone()),
            Some(VaultEntry::Degraded { message, .. }) => Err(Error::VaultUnavailable {
                vault_id: vault_id.to_string(),
                message: message.clone(),
            }),
            None => Err(Error::NotFound(format!("unknown vault ID {vault_id}"))),
        }
    }

    pub fn server_instance_id(&self) -> &str {
        self.server_instance_id.as_str()
    }

    pub fn release(&self) -> Option<&str> {
        self.release.as_deref()
    }

    pub fn with_release(mut self, release: Option<String>) -> Self {
        self.release = release.map(Arc::from);
        self
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
            vaults: self.vaults.iter().map(VaultEntry::meta).collect(),
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
        for vault in self.vaults.iter().filter_map(VaultEntry::runtime) {
            vault.shutdown();
        }
    }

    pub fn logs(&self) -> &LogHub {
        &self.logs
    }
}

fn vault_open_error_message(error: &Error) -> String {
    match error {
        Error::Io(inner) => inner.to_string(),
        Error::Sql(inner) => inner.to_string(),
        Error::Json(inner) => inner.to_string(),
        Error::VaultAlreadyOwned { root } => {
            format!("vault root {} is already owned by another Tansu server", root.display())
        }
        Error::BadRequest(message)
        | Error::NotFound(message)
        | Error::Internal(message) => message.clone(),
        Error::VaultUnavailable { message, .. } => message.clone(),
        Error::Api(inner) => format!("{inner:?}"),
    }
}

fn release_from_env() -> Option<Arc<str>> {
    std::env::var("TANSU_RELEASE")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(Arc::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logging::LogMode;
    use tempfile::TempDir;

    fn config(root: &TempDir) -> Config {
        Config {
            data_root: root.path().join("data"),
            vaults: vec![crate::config::VaultConfig {
                name: "Notes".to_string(),
                path: root.path().join("notes"),
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
            event.fields.get("system").unwrap()["component"] == "startup"
                && event.fields.get("system").unwrap()["action"] == "app_open"
        }));

        let vault_id = app.v2_bootstrap().vaults[0].vault_id.clone();
        let subscription = app.subscribe_v2_events(&vault_id, None).unwrap();
        assert_eq!(subscription.current_version, 0);
        assert!(subscription.replay.is_empty());
        assert!(!subscription.resync_required);
        assert!(app.subscribe_v2_events("missing", None).is_err());
    }

    #[test]
    fn a_later_vault_open_failure_degrades_that_vault_and_preserves_earlier_ownership() {
        let root = tempfile::tempdir().unwrap();
        let first_root = root.path().join("first-notes");
        let second_root = root.path().join("second-notes");
        std::fs::create_dir_all(&first_root).unwrap();
        std::fs::create_dir_all(&second_root).unwrap();
        let config = Config {
            data_root: root.path().join("data"),
            vaults: vec![
                crate::config::VaultConfig {
                    name: "First".to_string(),
                    path: first_root,
                },
                crate::config::VaultConfig {
                    name: "Second".to_string(),
                    path: second_root,
                },
            ],
            auth: None,
        };
        let (_, resolved_vaults) = initialize_state_layout(&config.data_root, &config.vaults).unwrap();
        std::fs::write(
            resolved_vaults[1].state_path.join("vault.db"),
            b"invalid sqlite database",
        )
        .unwrap();

        let app = App::from_config(config, LogHub::new(LogMode::Off), None).unwrap();
        let bootstrap = app.v2_bootstrap();
        assert_eq!(bootstrap.vaults.len(), 2);
        assert!(bootstrap.vaults[0].error.is_none());
        let degraded = &bootstrap.vaults[1];
        assert_eq!(degraded.vault_id, resolved_vaults[1].vault_id);
        assert_eq!(degraded.name, "Second");
        assert!(degraded.error.as_deref().is_some_and(|error| !error.is_empty()));

        assert!(app.vault_by_id(&resolved_vaults[0].vault_id).is_ok());
        assert!(matches!(
            app.vault_by_id(&resolved_vaults[1].vault_id),
            Err(Error::VaultUnavailable { vault_id, .. }) if vault_id == resolved_vaults[1].vault_id
        ));

        drop(app);
        let reopened = VaultRuntime::open(0, &resolved_vaults[0], LogHub::new(LogMode::Off)).unwrap();
        drop(reopened);
    }


}
