use std::fs::{self, File, OpenOptions};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use tansu2::config::{Config, VaultConfig, initialize_state_layout, load_config_from_path};

pub fn run_migration(config_path: &Path, dry_run: bool) -> tansu2::Result<String> {
    let config = load_config_from_path(config_path)?;
    if dry_run {
        return migration_report(config_path, &config);
    }
    apply_migration(&config)
}

fn apply_migration(config: &Config) -> tansu2::Result<String> {
    let data_root = data_root(&config.vaults)?;
    let backup = backup_state_root(&data_root)?;
    let (_, vaults) = initialize_state_layout(&config.vaults)?;
    let mut report = String::from("Migration complete.\n");
    match backup {
        Some(path) => report.push_str(&format!("Application state backup: {}\n", path.display())),
        None => report.push_str("Application state backup: no existing state to copy\n"),
    }
    for (source, migrated) in config.vaults.iter().zip(vaults) {
        report.push_str(&format!(
            "Vault {}: {} -> {} (original state preserved)\n",
            source.name,
            source.state_path.display(),
            migrated.state_path.display(),
        ));
    }
    Ok(report)
}

fn migration_report(config_path: &Path, config: &Config) -> tansu2::Result<String> {
    let data_root = data_root(&config.vaults)?;
    let mut report = format!(
        "Migration dry run for {}\nApplication state root: {}\n",
        config_path.display(),
        data_root.display(),
    );
    for vault in &config.vaults {
        report.push_str(&format!(
            "Vault {}\n  Content root: {}\n  Current state: {}\n  Destination: a stable vault-ID directory under {}/vaults\n",
            vault.name,
            vault.path.display(),
            vault.state_path.display(),
            data_root.display(),
        ));
    }
    report.push_str(
        "Backup-first migration: existing application state is copied to a unique sibling backup before relocation. Original name-based state is preserved.\nNo files were changed.\n",
    );
    Ok(report)
}

fn data_root(vaults: &[VaultConfig]) -> tansu2::Result<PathBuf> {
    vaults
        .first()
        .and_then(|vault| vault.state_path.parent())
        .map(Path::to_path_buf)
        .ok_or_else(|| tansu2::Error::BadRequest("vault state path needs a parent".to_string()))
}

fn backup_state_root(data_root: &Path) -> tansu2::Result<Option<PathBuf>> {
    match fs::symlink_metadata(data_root) {
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(tansu2::Error::BadRequest(
                "application data root must be a real directory".to_string(),
            ));
        }
        Ok(_) => {}
    }
    let parent = data_root
        .parent()
        .ok_or_else(|| tansu2::Error::BadRequest("application data root needs a parent".to_string()))?;
    for _ in 0..8 {
        let suffix = random_backup_id();
        let staging = parent.join(format!(".tansu-backup-{suffix}.pending"));
        let destination = parent.join(format!("tansu-backup-{suffix}"));
        match create_private_directory(&staging) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
        if let Err(error) = copy_backup_contents(data_root, &staging) {
            fs::remove_dir_all(&staging)?;
            return Err(error);
        }
        match fs::rename(&staging, &destination) {
            Ok(()) => {
                File::open(parent)?.sync_all()?;
                return Ok(Some(destination));
            }
            Err(error) => {
                fs::remove_dir_all(&staging)?;
                if error.kind() == ErrorKind::AlreadyExists {
                    continue;
                }
                return Err(error.into());
            }
        }
    }
    Err(tansu2::Error::Internal(
        "could not allocate an application state backup".to_string(),
    ))
}

fn copy_backup_contents(source: &Path, destination: &Path) -> tansu2::Result<()> {
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_path)?;
        if metadata.file_type().is_symlink() {
            return Err(tansu2::Error::BadRequest(
                "application state backup cannot contain symlinks".to_string(),
            ));
        }
        if metadata.is_dir() {
            create_private_directory(&destination_path)?;
            copy_backup_contents(&source_path, &destination_path)?;
        } else if metadata.is_file() {
            let mut source_file = File::open(&source_path)?;
            if !source_file.metadata()?.is_file() {
                return Err(tansu2::Error::BadRequest(
                    "application state backup source changed type".to_string(),
                ));
            }
            let mut destination_file = new_private_file(&destination_path)?;
            std::io::copy(&mut source_file, &mut destination_file)?;
            destination_file.sync_all()?;
        } else {
            return Err(tansu2::Error::BadRequest(
                "application state backup contains a special file".to_string(),
            ));
        }
    }
    File::open(destination)?.sync_all()?;
    Ok(())
}

fn random_backup_id() -> String {
    let mut bytes = [0_u8; 16];
    fastrand::fill(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(unix)]
fn create_private_directory(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new().mode(0o700).create(path)
}

#[cfg(not(unix))]
fn create_private_directory(path: &Path) -> std::io::Result<()> {
    fs::create_dir(path)
}

#[cfg(unix)]
fn new_private_file(path: &Path) -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)
}

#[cfg(not(unix))]
fn new_private_file(path: &Path) -> std::io::Result<File> {
    OpenOptions::new().write(true).create_new(true).open(path)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use tansu2::config::{Config, VaultConfig};

    use super::{apply_migration, run_migration};

    #[test]
    fn dry_run_reports_copied_config_without_writing_state() {
        let root = test_root();
        let vault_path = root.path().join("notes");
        fs::create_dir(&vault_path).unwrap();
        let config_path = root.path().join("copied-config.toml");
        fs::write(
            &config_path,
            format!(
                "[[vaults]]\nname='Main'\npath='{}'\n",
                vault_path.display()
            ),
        )
        .unwrap();

        let report = run_migration(&config_path, true).unwrap();

        assert!(report.contains("Migration dry run"));
        assert!(report.contains(config_path.to_str().unwrap()));
        assert!(report.contains(vault_path.to_str().unwrap()));
        assert!(report.contains("No files were changed."));
    }

    #[test]
    fn backup_precedes_relocation_and_preserves_vault_and_legacy_state() {
        let root = test_root();
        let vault_path = root.path().join("notes");
        fs::create_dir(&vault_path).unwrap();
        let note_path = vault_path.join("note.md");
        let note_bytes = b"# Preserved\n\nAuthored content.\n";
        fs::write(&note_path, note_bytes).unwrap();
        let data_home = root.path().join("data");
        let data_root = data_home.join("tansu");
        let legacy_state = data_root.join("Main");
        fs::create_dir_all(&legacy_state).unwrap();
        fs::write(legacy_state.join("vault.db"), b"legacy catalog").unwrap();
        let config = Config {
            vaults: vec![VaultConfig {
                name: "Main".to_string(),
                path: vault_path.clone(),
                state_path: legacy_state.clone(),
                excluded_folders: Vec::new(),
            }],
            auth: None,
        };

        let report = apply_migration(&config).unwrap();

        assert!(report.contains("Migration complete."));
        assert_eq!(fs::read(note_path).unwrap(), note_bytes);
        assert_eq!(fs::read(legacy_state.join("vault.db")).unwrap(), b"legacy catalog");
        let backup = fs::read_dir(&data_home)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| path.file_name().unwrap().to_string_lossy().starts_with("tansu-backup-"))
            .unwrap();
        assert_eq!(fs::read(backup.join("Main/vault.db")).unwrap(), b"legacy catalog");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&backup).unwrap().permissions().mode() & 0o777, 0o700);
            assert_eq!(
                fs::metadata(backup.join("Main/vault.db"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600,
            );
        }
        let target = fs::read_dir(data_root.join("vaults"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(fs::read(target.join("vault.db")).unwrap(), b"legacy catalog");
    }

    #[cfg(unix)]
    #[test]
    fn backup_rejects_symlinks_before_relocating_state() {
        use std::os::unix::fs::symlink;

        let root = test_root();
        let vault_path = root.path().join("notes");
        fs::create_dir(&vault_path).unwrap();
        let data_root = root.path().join("data/tansu");
        let legacy_state = data_root.join("Main");
        fs::create_dir_all(&legacy_state).unwrap();
        let outside = root.path().join("outside");
        fs::write(&outside, b"outside").unwrap();
        symlink(&outside, legacy_state.join("linked")).unwrap();
        let config = Config {
            vaults: vec![VaultConfig {
                name: "Main".to_string(),
                path: vault_path,
                state_path: legacy_state.clone(),
                excluded_folders: Vec::new(),
            }],
            auth: None,
        };

        assert!(apply_migration(&config).is_err());
        assert!(legacy_state.join("linked").is_symlink());
        assert!(!data_root.join("vaults").exists());
        assert_eq!(fs::read(&outside).unwrap(), b"outside");
    }

    fn test_root() -> tempfile::TempDir {
        let work = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".work/tmp");
        fs::create_dir_all(&work).unwrap();
        tempfile::Builder::new().prefix("migration-").tempdir_in(work).unwrap()
    }
}
