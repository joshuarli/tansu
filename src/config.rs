use std::fs;
use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, OptionalExtension, params};

use crate::api_types::{AppSettings, PathValidationReason};
use crate::auth::AuthPolicy;
use crate::{Error, Result};

#[derive(Debug, Clone)]
pub struct Config {
    pub vaults: Vec<VaultConfig>,
    pub auth: Option<AuthConfig>,
}

#[derive(Debug, Clone)]
pub struct AuthConfig {
    policy: AuthPolicy,
    state_directory: PathBuf,
}

impl AuthConfig {
    pub fn policy(&self) -> &AuthPolicy {
        &self.policy
    }

    pub fn state_directory(&self) -> &Path {
        &self.state_directory
    }
}

#[derive(Debug, Clone)]
pub struct VaultConfig {
    pub name: String,
    pub path: PathBuf,
    pub state_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct ConfigStore {
    path: PathBuf,
}

impl ConfigStore {
    pub fn open_default() -> Result<Self> {
        Self::open(&settings_database_path()?)
    }

    pub fn open(path: &Path) -> Result<Self> {
        let parent = path.parent().ok_or_else(|| Error::BadRequest("settings database needs a parent".to_string()))?;
        let file_name = path.file_name().ok_or_else(|| Error::BadRequest("settings database needs a file name".to_string()))?;
        fs::create_dir_all(parent)?;
        let metadata = fs::symlink_metadata(parent)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(Error::BadRequest("settings directory must be a real directory".to_string()));
        }
        let canonical_parent = parent.canonicalize()?;
        let path = canonical_parent.join(file_name);
        if let Ok(metadata) = fs::symlink_metadata(&path)
            && (metadata.file_type().is_symlink() || !metadata.is_file())
        {
            return Err(Error::BadRequest("settings database must be a regular file".to_string()));
        }
        let connection = open_settings_database(&path)?;
        let version: u32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version > 1 {
            return Err(Error::BadRequest(format!("settings database version {version} is newer than supported")));
        }
        connection.execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;
             CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )?;
        if version == 0 {
            connection.pragma_update(None, "user_version", 1)?;
        }
        Ok(Self { path })
    }

    pub fn settings(&self) -> Result<Option<AppSettings>> {
        let connection = open_settings_database(&self.path)?;
        let value = connection
            .query_row("SELECT value FROM settings WHERE key='app'", [], |row| row.get::<_, String>(0))
            .optional()?;
        value.map(|value| serde_json::from_str(&value).map_err(Into::into)).transpose()
    }

    pub fn config(&self) -> Result<Option<Config>> {
        self.settings()?.map(config_from_settings).transpose()
    }

    pub fn save_settings(&self, settings: &AppSettings) -> Result<()> {
        config_from_settings(settings.clone())?;
        let mut connection = open_settings_database(&self.path)?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "INSERT INTO settings(key, value) VALUES('app', ?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![serde_json::to_string(settings)?],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn initialize_settings(&self, settings: &AppSettings) -> Result<()> {
        config_from_settings(settings.clone())?;
        let mut connection = open_settings_database(&self.path)?;
        let transaction = connection.transaction()?;
        let existing = transaction
            .query_row("SELECT 1 FROM settings WHERE key='app'", [], |_| Ok(()))
            .optional()?;
        if existing.is_some() {
            return Err(Error::BadRequest("application settings are already initialized".to_string()));
        }
        transaction.execute("INSERT INTO settings(key, value) VALUES('app', ?1)", params![serde_json::to_string(settings)?])?;
        transaction.commit()?;
        Ok(())
    }
}

fn open_settings_database(path: &Path) -> Result<Connection> {
    Ok(Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?)
}

pub fn initialize_state_layout(vaults: &[VaultConfig]) -> Result<(String, Vec<VaultConfig>)> {
    let first = vaults
        .first()
        .ok_or_else(|| Error::BadRequest("config must contain at least one vault".to_string()))?;
    let data_root = first
        .state_path
        .parent()
        .ok_or_else(|| Error::BadRequest("vault state path needs a parent".to_string()))?
        .to_path_buf();
    for vault in vaults.iter().skip(1) {
        if vault.state_path.parent() != Some(data_root.as_path()) {
            return Err(Error::BadRequest(
                "vault state paths must share one data root".to_string(),
            ));
        }
    }
    fs::create_dir_all(&data_root)?;
    let metadata = fs::symlink_metadata(&data_root)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(Error::BadRequest("application data root must be a real directory".to_string()));
    }
    let data_root = data_root.canonicalize()?;
    let identity = data_root.join("identity");
    ensure_real_directory(&identity)?;
    ensure_real_directory(&identity.join("relocations"))?;
    ensure_real_directory(&data_root.join("vaults"))?;
    let server_instance_id = persistent_id(&identity.join("server-instance-id"))?;
    let mapping_path = identity.join("vault-roots.json");
    let mut mappings = read_root_mappings(&mapping_path)?;
    let mut canonical_roots = Vec::with_capacity(vaults.len());
    for vault in vaults {
        fs::create_dir_all(&vault.path)?;
        let metadata = fs::symlink_metadata(&vault.path)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(Error::BadRequest(format!(
                "vault root must be a real directory: {}",
                vault.path.display()
            )));
        }
        canonical_roots.push(vault.path.canonicalize()?);
    }
    for (index, root) in canonical_roots.iter().enumerate() {
        for other in canonical_roots.iter().skip(index + 1) {
            if root == other || root.starts_with(other) || other.starts_with(root) {
                return Err(Error::BadRequest(format!(
                    "duplicate or nested vault roots are not allowed: {} and {}",
                    root.display(),
                    other.display()
                )));
            }
        }
    }
    let mut resolved = Vec::with_capacity(vaults.len());
    let mut ids = std::collections::HashSet::new();
    for (vault, root) in vaults.iter().zip(canonical_roots) {
        let root_key = root
            .to_str()
            .ok_or_else(|| Error::BadRequest("vault root path must be valid UTF-8".to_string()))?
            .to_string();
        let vault_id = match mappings.get(&root_key) {
            Some(vault_id) => vault_id.clone(),
            None => {
                let vault_id = generate_opaque_id();
                mappings.insert(root_key, vault_id.clone());
                write_json_atomic(&mapping_path, &mappings)?;
                vault_id
            }
        };
        if !valid_opaque_id(&vault_id) || !ids.insert(vault_id.clone()) {
            return Err(Error::BadRequest("vault identity mapping is invalid or colliding".to_string()));
        }
        let state_path = data_root.join("vaults").join(&vault_id);
        relocate_state(&identity, &vault_id, &vault.state_path, &state_path)?;
        let mut config = vault.clone();
        config.path = root;
        config.state_path = state_path;
        resolved.push(config);
    }
    Ok((server_instance_id, resolved))
}

fn read_root_mappings(path: &Path) -> Result<std::collections::BTreeMap<String, String>> {
    if let Ok(metadata) = fs::symlink_metadata(path)
        && (metadata.file_type().is_symlink() || !metadata.is_file())
    {
        return Err(Error::BadRequest(
            "vault identity mapping must be a regular file".to_string(),
        ));
    }
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(Into::into),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(std::collections::BTreeMap::new()),
        Err(error) => Err(Error::Io(error)),
    }
}

fn persistent_id(path: &Path) -> Result<String> {
    if let Ok(metadata) = fs::symlink_metadata(path)
        && (metadata.file_type().is_symlink() || !metadata.is_file())
    {
        return Err(Error::BadRequest(
            "server identity must be a regular file".to_string(),
        ));
    }
    match fs::read_to_string(path) {
        Ok(value) if valid_opaque_id(value.trim()) => Ok(value.trim().to_string()),
        Ok(_) => Err(Error::Internal("server identity file is invalid".to_string())),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            let id = generate_opaque_id();
            write_new_atomic(path, id.as_bytes())?;
            fs::read_to_string(path)
                .map(|value| value.trim().to_string())
                .map_err(Into::into)
        }
        Err(error) => Err(Error::Io(error)),
    }
}

fn write_json_atomic(path: &Path, value: &impl serde::Serialize) -> Result<()> {
    write_atomic(path, &serde_json::to_vec(value)?)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| Error::Internal("identity file needs a parent".to_string()))?;
    if let Ok(metadata) = fs::symlink_metadata(path)
        && (metadata.file_type().is_symlink() || !metadata.is_file())
    {
        return Err(Error::BadRequest(
            "identity state must be a regular file".to_string(),
        ));
    }
    for _ in 0..8 {
        let temp = parent.join(format!(".identity-{}", generate_opaque_id()));
        match OpenOptions::new().write(true).create_new(true).open(&temp) {
            Ok(mut file) => {
                let result = (|| {
                    file.write_all(bytes)?;
                    file.sync_all()?;
                    drop(file);
                    fs::rename(&temp, path)?;
                    File::open(parent)?.sync_all()?;
                    Ok(())
                })();
                if result.is_err() {
                    let _ = fs::remove_file(&temp);
                }
                return result;
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(Error::Io(error)),
        }
    }
    Err(Error::Internal("could not allocate an identity temp file".to_string()))
}

fn write_new_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| Error::Internal("identity file needs a parent".to_string()))?;
    fs::create_dir_all(parent)?;
    for _ in 0..8 {
        let temp = parent.join(format!(".identity-{}", generate_opaque_id()));
        match OpenOptions::new().write(true).create_new(true).open(&temp) {
            Ok(mut file) => {
                file.write_all(bytes)?;
                file.sync_all()?;
                match fs::hard_link(&temp, path) {
                    Ok(()) => {
                        fs::remove_file(&temp)?;
                        File::open(parent)?.sync_all()?;
                        return Ok(());
                    }
                    Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                        fs::remove_file(&temp)?;
                        return Ok(());
                    }
                    Err(error) => return Err(Error::Io(error)),
                }
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(Error::Io(error)),
        }
    }
    Err(Error::Internal("could not allocate an identity temp file".to_string()))
}

fn relocate_state(identity: &Path, vault_id: &str, legacy: &Path, target: &Path) -> Result<()> {
    match fs::symlink_metadata(target) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(Error::BadRequest("vault state target must be a real directory".to_string()));
            }
            return Ok(());
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(Error::Io(error)),
    }
    let parent = target
        .parent()
        .ok_or_else(|| Error::Internal("vault state target needs a parent".to_string()))?;
    fs::create_dir_all(parent)?;
    let marker = identity.join("relocations").join(format!("{vault_id}.json"));
    write_json_atomic(
        &marker,
        &serde_json::json!({
            "vaultId": vault_id,
            "legacyStatePath": legacy,
            "targetStatePath": target,
            "state": "prepared"
        }),
    )?;
    let temp = parent.join(format!(".{vault_id}.pending"));
    if temp.exists() {
        fs::remove_dir_all(&temp)?;
    }
    if legacy.exists() {
        copy_state_tree(legacy, &temp)?;
    } else {
        fs::create_dir(&temp)?;
    }
    sync_tree(&temp)?;
    match fs::rename(&temp, target) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::AlreadyExists && target.is_dir() => {
            fs::remove_dir_all(&temp)?;
        }
        Err(error) => return Err(Error::Io(error)),
    }
    File::open(parent)?.sync_all()?;
    write_json_atomic(
        &marker,
        &serde_json::json!({
            "vaultId": vault_id,
            "legacyStatePath": legacy,
            "targetStatePath": target,
            "state": "complete"
        }),
    )?;
    Ok(())
}

fn ensure_real_directory(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => Err(
            Error::BadRequest(format!("state path must be a real directory: {}", path.display())),
        ),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            fs::create_dir(path)?;
            if let Some(parent) = path.parent() {
                File::open(parent)?.sync_all()?;
            }
            Ok(())
        }
        Err(error) => Err(Error::Io(error)),
    }
}

fn copy_state_tree(source: &Path, target: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(Error::BadRequest("legacy vault state must be a real directory".to_string()));
    }
    fs::create_dir(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_path)?;
        if metadata.file_type().is_symlink() {
            return Err(Error::BadRequest("legacy state cannot contain symlinks".to_string()));
        }
        if metadata.is_dir() {
            copy_state_tree(&source_path, &target_path)?;
        } else if metadata.is_file() {
            fs::copy(&source_path, &target_path)?;
            File::open(&target_path)?.sync_all()?;
        } else {
            return Err(Error::BadRequest("legacy state contains a special file".to_string()));
        }
    }
    File::open(target)?.sync_all()?;
    Ok(())
}

fn sync_tree(path: &Path) -> Result<()> {
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            sync_tree(&entry.path())?;
        }
    }
    File::open(path)?.sync_all()?;
    Ok(())
}

fn generate_opaque_id() -> String {
    let mut bytes = [0_u8; 16];
    fastrand::fill(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn valid_opaque_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub fn settings_database_path() -> Result<PathBuf> {
    let base = xdg_path("XDG_CONFIG_HOME", ".config")?;
    Ok(base.join("tansu").join("settings.sqlite3"))
}

pub fn load_config() -> Result<Option<Config>> {
    ConfigStore::open_default()?.config()
}

pub fn config_from_settings(settings: AppSettings) -> Result<Config> {
    if settings.vaults.is_empty() {
        return Err(Error::BadRequest(
            "config must contain at least one vault".to_string(),
        ));
    }
    let data_root = xdg_path("XDG_DATA_HOME", ".local/share")?.join("tansu");
    let vaults = settings
        .vaults
        .into_iter()
        .map(|vault| {
            if vault.name.trim().is_empty() {
                return Err(Error::BadRequest("vault name cannot be empty".to_string()));
            }
            let path = expand_tilde(&vault.path)?;
            if !path.is_absolute() {
                return Err(Error::BadRequest("vault path must be absolute".to_string()));
            }
            let state_path = data_root.join(state_dir_name(&vault.name));
            Ok(VaultConfig {
                name: vault.name,
                path,
                state_path,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    validate_vaults(&vaults)?;
    let auth = settings
        .auth
        .map(|auth| {
            if auth.rp_name.trim().is_empty() {
                return Err(Error::BadRequest("auth RP name cannot be empty".to_string()));
            }
            let policy = AuthPolicy::authenticated(&auth.external_origin, &auth.rp_id, &auth.rp_name)
                .map_err(|error| Error::BadRequest(error.to_string()))?;
            Ok(AuthConfig {
                policy,
                state_directory: data_root.join("identity").join("auth"),
            })
        })
        .transpose()?;
    Ok(Config { vaults, auth })
}

pub fn prepare_auth_state_directory(auth: &AuthConfig) -> Result<()> {
    let identity = auth
        .state_directory
        .parent()
        .ok_or_else(|| Error::BadRequest("auth state directory needs an identity parent".to_string()))?;
    let data_root = identity
        .parent()
        .ok_or_else(|| Error::BadRequest("auth identity needs a data root".to_string()))?;
    fs::create_dir_all(data_root)?;
    let metadata = fs::symlink_metadata(data_root)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(Error::BadRequest("application data root must be a real directory".to_string()));
    }
    ensure_real_directory(identity)?;
    Ok(())
}

fn expand_tilde(path: &str) -> Result<PathBuf> {
    if path == "~" || path.starts_with("~/") {
        let home = std::env::var_os("HOME")
            .ok_or_else(|| Error::BadRequest("HOME is not set".to_string()))?;
        let suffix = path.strip_prefix("~/").unwrap_or("");
        return Ok(PathBuf::from(home).join(suffix));
    }
    Ok(PathBuf::from(path))
}

fn xdg_path(env_name: &str, home_suffix: &str) -> Result<PathBuf> {
    match std::env::var_os(env_name) {
        Some(value) => Ok(PathBuf::from(value)),
        None => {
            let home = std::env::var_os("HOME")
                .ok_or_else(|| Error::BadRequest("HOME is not set".to_string()))?;
            Ok(PathBuf::from(home).join(home_suffix))
        }
    }
}

fn state_dir_name(name: &str) -> String {
    let sanitized = name
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '\0' => '_',
            ch => ch,
        })
        .collect::<String>();
    let trimmed = sanitized.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        "vault".to_string()
    } else {
        trimmed.to_string()
    }
}

fn validate_vaults(vaults: &[VaultConfig]) -> Result<()> {
    for (index, vault) in vaults.iter().enumerate() {
        for other in vaults.iter().skip(index + 1) {
            if is_nested(&vault.path, &other.path) || is_nested(&other.path, &vault.path) {
                return Err(Error::BadRequest(format!(
                    "nested vaults are not allowed: {} and {} ({:?})",
                    vault.path.display(),
                    other.path.display(),
                    PathValidationReason::NestedVault
                )));
            }
            if normalize_for_compare(&vault.state_path) == normalize_for_compare(&other.state_path)
            {
                return Err(Error::BadRequest(format!(
                    "vault state paths must be unique: {}",
                    vault.state_path.display()
                )));
            }
        }
    }
    Ok(())
}

fn is_nested(child: &Path, parent: &Path) -> bool {
    let child = normalize_for_compare(child);
    let parent = normalize_for_compare(parent);
    child != parent && child.starts_with(parent)
}

fn normalize_for_compare(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_types::{AppAuthSettings, AppVaultSettings};

    #[test]
    fn builds_config_from_sqlite_settings_and_expands_tilde() {
        let config = config_from_settings(AppSettings {
            vaults: vec![AppVaultSettings { name: "Main".into(), path: "~/notes".into() }],
            auth: None,
        }).unwrap();
        assert_eq!(config.vaults[0].name, "Main");
        assert!(config.vaults[0].path.ends_with("notes"));
        assert!(config.vaults[0].state_path.ends_with("tansu/Main"));
        assert!(config.auth.is_none());
    }

    #[test]
    fn builds_authenticated_config_under_stable_identity_directory() {
        let config = config_from_settings(AppSettings {
            vaults: vec![AppVaultSettings { name: "Main".into(), path: "/notes".into() }],
            auth: Some(AppAuthSettings {
                external_origin: "https://notes.example.com".into(),
                rp_id: "example.com".into(),
                rp_name: "Tansu".into(),
            }),
        }).unwrap();
        let auth = config.auth.unwrap();
        assert_eq!(
            auth.policy().rp(),
            Some(("example.com", "https://notes.example.com", "Tansu"))
        );
        assert!(auth.state_directory().ends_with("tansu/identity/auth"));
    }

    #[test]
    fn rejects_invalid_sqlite_settings() {
        let error = config_from_settings(AppSettings { vaults: vec![], auth: None }).unwrap_err();
        assert!(error.to_string().contains("at least one vault"));

        let error = config_from_settings(AppSettings {
            vaults: vec![
                AppVaultSettings { name: "A".into(), path: "/tmp/a".into() },
                AppVaultSettings { name: "B".into(), path: "/tmp/a/b".into() },
            ],
            auth: None,
        }).unwrap_err();
        assert!(error.to_string().contains("nested vaults"));

        let error = config_from_settings(AppSettings {
            vaults: vec![AppVaultSettings { name: "A".into(), path: "relative".into() }],
            auth: None,
        }).unwrap_err();
        assert!(error.to_string().contains("must be absolute"));

        let error = config_from_settings(AppSettings {
            vaults: vec![AppVaultSettings { name: "A".into(), path: "/tmp/a".into() }],
            auth: Some(AppAuthSettings {
                external_origin: "http://notes.example.com".into(),
                rp_id: "example.com".into(),
                rp_name: "Tansu".into(),
            }),
        }).unwrap_err();
        assert!(error.to_string().contains("HTTPS"));
    }

    #[test]
    fn sqlite_settings_round_trip_and_initialize_only_once() {
        let root = tempfile::tempdir().unwrap();
        let store = ConfigStore::open(&root.path().join("settings.sqlite3")).unwrap();
        assert_eq!(store.settings().unwrap(), None);
        let settings = AppSettings {
            vaults: vec![AppVaultSettings { name: "A".into(), path: "/tmp/a".into() }],
            auth: None,
        };
        store.initialize_settings(&settings).unwrap();
        assert_eq!(store.settings().unwrap(), Some(settings.clone()));
        assert_eq!(store.config().unwrap().unwrap().vaults.len(), 1);
        assert!(store.initialize_settings(&settings).is_err());

        let updated = AppSettings {
            vaults: vec![AppVaultSettings { name: "B".into(), path: "/tmp/b".into() }],
            auth: None,
        };
        store.save_settings(&updated).unwrap();
        assert_eq!(store.settings().unwrap(), Some(updated));
    }

    #[test]
    fn settings_database_rejects_unknown_schema_versions_and_symlink_files() {
        let root = tempfile::tempdir().unwrap();
        let future = root.path().join("future.sqlite3");
        let connection = Connection::open(&future).unwrap();
        connection.pragma_update(None, "user_version", 2).unwrap();
        drop(connection);
        assert!(ConfigStore::open(&future).unwrap_err().to_string().contains("newer than supported"));

        {
            use std::os::unix::fs::symlink;
            let target = root.path().join("target.sqlite3");
            let link = root.path().join("link.sqlite3");
            Connection::open(&target).unwrap();
            symlink(&target, &link).unwrap();
            assert!(ConfigStore::open(&link).is_err());
        }
    }

    #[test]
    fn state_ids_survive_restart_reorder_and_vault_rename() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let first_root = root.path().join("notes-a");
        let second_root = root.path().join("notes-b");
        fs::create_dir_all(&first_root).unwrap();
        fs::create_dir_all(&second_root).unwrap();
        let first = VaultConfig {
            name: "First".to_string(),
            path: first_root,
            state_path: data.join("First"),

        };
        let second = VaultConfig {
            name: "Second".to_string(),
            path: second_root,
            state_path: data.join("Second"),

        };

        let (server_id, original) = initialize_state_layout(&[first.clone(), second.clone()]).unwrap();
        let (restarted_server_id, reordered) =
            initialize_state_layout(&[second.clone(), first.clone()]).unwrap();
        let renamed = VaultConfig {
            name: "Renamed".to_string(),
            path: first.path.clone(),
            state_path: data.join("Renamed"),

        };
        let (renamed_server_id, renamed_state) = initialize_state_layout(&[renamed]).unwrap();

        assert_eq!(server_id, restarted_server_id);
        assert_eq!(server_id, renamed_server_id);
        assert_eq!(original[0].state_path, reordered[1].state_path);
        assert_eq!(original[1].state_path, reordered[0].state_path);
        assert_eq!(original[0].state_path, renamed_state[0].state_path);
    }

    #[test]
    fn state_relocation_preserves_legacy_data_and_records_completion() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let vault_root = root.path().join("notes");
        let legacy = data.join("Named");
        fs::create_dir_all(&vault_root).unwrap();
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("vault.db"), b"catalog bytes").unwrap();
        let config = VaultConfig {
            name: "Named".to_string(),
            path: vault_root,
            state_path: legacy.clone(),

        };

        let (_, migrated) = initialize_state_layout(&[config]).unwrap();

        assert_eq!(fs::read(migrated[0].state_path.join("vault.db")).unwrap(), b"catalog bytes");
        assert_eq!(fs::read(legacy.join("vault.db")).unwrap(), b"catalog bytes");
        let marker = data.join("identity/relocations");
        let entry = fs::read_dir(marker).unwrap().next().unwrap().unwrap();
        let value: serde_json::Value = serde_json::from_slice(&fs::read(entry.path()).unwrap()).unwrap();
        assert_eq!(value["state"], "complete");
    }

    #[test]
    fn state_layout_rejects_symlink_aliased_roots() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let real = root.path().join("notes");
        fs::create_dir_all(&real).unwrap();
        let alias = root.path().join("alias");
        symlink(&real, &alias).unwrap();
        let config = |name: &str, path: PathBuf| VaultConfig {
            name: name.to_string(),
            path,
            state_path: data.join(name),

        };

        assert!(initialize_state_layout(&[config("Real", real), config("Alias", alias)]).is_err());
    }
}
