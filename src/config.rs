use std::fs;
use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::api_types::PathValidationReason;
use crate::{Error, Result};

#[derive(Debug, Clone)]
pub struct Config {
    pub vaults: Vec<VaultConfig>,
}

#[derive(Debug, Clone)]
pub struct VaultConfig {
    pub name: String,
    pub path: PathBuf,
    pub state_path: PathBuf,
    pub excluded_folders: Vec<String>,
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

#[derive(Debug, Deserialize)]
struct RawConfig {
    vaults: Vec<RawVault>,
}

#[derive(Debug, Deserialize)]
struct RawVault {
    name: String,
    path: String,
    #[serde(default)]
    excluded_folders: Vec<String>,
}

pub fn default_config_path() -> Result<PathBuf> {
    let base = xdg_path("XDG_CONFIG_HOME", ".config")?;
    Ok(base.join("tansu").join("config.toml"))
}

pub fn load_config() -> Result<Config> {
    load_config_from_path(&default_config_path()?)
}

pub fn load_config_from_path(path: &Path) -> Result<Config> {
    let text = fs::read_to_string(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            Error::BadRequest(format!("missing config: {}", path.display()))
        } else {
            Error::Io(error)
        }
    })?;
    parse_config(&text)
}

pub fn parse_config(text: &str) -> Result<Config> {
    let raw: RawConfig = toml::from_str(text)?;
    if raw.vaults.is_empty() {
        return Err(Error::BadRequest(
            "config must contain at least one vault".to_string(),
        ));
    }
    let data_root = xdg_path("XDG_DATA_HOME", ".local/share")?.join("tansu");
    let vaults = raw
        .vaults
        .into_iter()
        .map(|vault| {
            let path = expand_tilde(&vault.path)?;
            let state_path = data_root.join(state_dir_name(&vault.name));
            Ok(VaultConfig {
                name: vault.name,
                path,
                state_path,
                excluded_folders: vault.excluded_folders,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    validate_vaults(&vaults)?;
    Ok(Config { vaults })
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

    #[test]
    fn parses_config_and_expands_tilde() {
        let config = parse_config("[[vaults]]\nname='Main'\npath='~/notes'\n").unwrap();
        assert_eq!(config.vaults[0].name, "Main");
        assert!(config.vaults[0].path.ends_with("notes"));
        assert!(config.vaults[0].state_path.ends_with("tansu/Main"));
    }

    #[test]
    fn rejects_nested_vaults() {
        let error = parse_config(
            "[[vaults]]\nname='A'\npath='/tmp/a'\n[[vaults]]\nname='B'\npath='/tmp/a/b'\n",
        )
        .unwrap_err();
        assert!(error.to_string().contains("nested vaults"));
    }

    #[test]
    fn parses_excluded_folders_and_rejects_empty_vault_list() {
        let config = parse_config(
            "[[vaults]]\nname='Main'\npath='/tmp/notes'\nexcluded_folders=['tmp','.cache']\n",
        )
        .unwrap();
        assert_eq!(config.vaults[0].excluded_folders, vec!["tmp", ".cache"]);

        let error = parse_config("vaults=[]").unwrap_err();
        assert!(error.to_string().contains("at least one vault"));
    }

    #[test]
    fn sanitizes_and_requires_unique_state_paths() {
        let config = parse_config("[[vaults]]\nname='A/B'\npath='/tmp/a'\n").unwrap();
        assert!(config.vaults[0].state_path.ends_with("tansu/A_B"));

        let dot = parse_config("[[vaults]]\nname='..'\npath='/tmp/a'\n").unwrap();
        assert!(dot.vaults[0].state_path.ends_with("tansu/vault"));

        let error = parse_config(
            "[[vaults]]\nname='A/B'\npath='/tmp/a'\n[[vaults]]\nname='A:B'\npath='/tmp/b'\n",
        )
        .unwrap_err();
        assert!(error.to_string().contains("state paths"));
    }

    #[test]
    fn load_config_reports_missing_files_and_keeps_sibling_vaults() {
        let root = tempfile::tempdir().unwrap();
        let missing = load_config_from_path(&root.path().join("missing.toml")).unwrap_err();
        assert!(missing.to_string().contains("missing config"));

        let config = parse_config(
            "[[vaults]]\nname='A'\npath='/tmp/a/../a-one'\n[[vaults]]\nname='B'\npath='/tmp/a-two'\n",
        )
        .unwrap();
        assert_eq!(config.vaults.len(), 2);
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
            excluded_folders: Vec::new(),
        };
        let second = VaultConfig {
            name: "Second".to_string(),
            path: second_root,
            state_path: data.join("Second"),
            excluded_folders: Vec::new(),
        };

        let (server_id, original) = initialize_state_layout(&[first.clone(), second.clone()]).unwrap();
        let (restarted_server_id, reordered) =
            initialize_state_layout(&[second.clone(), first.clone()]).unwrap();
        let renamed = VaultConfig {
            name: "Renamed".to_string(),
            path: first.path.clone(),
            state_path: data.join("Renamed"),
            excluded_folders: Vec::new(),
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
            excluded_folders: Vec::new(),
        };

        let (_, migrated) = initialize_state_layout(&[config]).unwrap();

        assert_eq!(fs::read(migrated[0].state_path.join("vault.db")).unwrap(), b"catalog bytes");
        assert_eq!(fs::read(legacy.join("vault.db")).unwrap(), b"catalog bytes");
        let marker = data.join("identity/relocations");
        let entry = fs::read_dir(marker).unwrap().next().unwrap().unwrap();
        let value: serde_json::Value = serde_json::from_slice(&fs::read(entry.path()).unwrap()).unwrap();
        assert_eq!(value["state"], "complete");
    }

    #[cfg(unix)]
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
            excluded_folders: Vec::new(),
        };

        assert!(initialize_state_layout(&[config("Real", real), config("Alias", alias)]).is_err());
    }
}
