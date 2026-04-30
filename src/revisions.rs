use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::crypto::Vault;

/// Directory for revisions of a given note path.
fn revisions_dir(root: &Path, rel_path: &str) -> PathBuf {
    let stem = Path::new(rel_path)
        .with_extension("")
        .to_string_lossy()
        .into_owned();
    root.join(".tansu/revisions").join(stem)
}

pub fn migrate_revisions(root: &Path, old_rel_path: &str, new_rel_path: &str) {
    let old_dir = revisions_dir(root, old_rel_path);
    let new_dir = revisions_dir(root, new_rel_path);
    if old_dir == new_dir || !old_dir.exists() {
        return;
    }
    if let Some(parent) = new_dir.parent()
        && fs::create_dir_all(parent).is_err()
    {
        return;
    }
    if !new_dir.exists() && fs::rename(&old_dir, &new_dir).is_ok() {
        return;
    }
    if fs::create_dir_all(&new_dir).is_err() {
        return;
    }

    let Ok(entries) = fs::read_dir(&old_dir) else {
        return;
    };
    let mut counter = 0u64;
    for entry in entries.filter_map(|e| e.ok()) {
        if !entry.path().is_file() {
            continue;
        }
        let mut dest = new_dir.join(entry.file_name());
        while dest.exists() {
            counter += 1;
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0)
                + counter;
            dest = new_dir.join(format!("{ts}.md"));
        }
        let _ = fs::rename(entry.path(), dest);
    }
    let _ = fs::remove_dir_all(old_dir);
}

/// Save the current content of a note as a revision.
/// In encrypted mode, the file is already encrypted on disk, so we copy raw bytes
/// (the revision file will be encrypted too).
/// Does nothing if the file doesn't exist or can't be read.
pub fn save_revision(root: &Path, rel_path: &str, full_path: &Path) {
    let Ok(content) = fs::read(full_path) else {
        return;
    };
    let dir = revisions_dir(root, rel_path);
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let path = dir.join(format!("{ts}.md"));
    let _ = fs::write(path, content);
}

/// List revision timestamps for a note, sorted descending (newest first).
pub fn list_revisions(root: &Path, rel_path: &str) -> Vec<u64> {
    let dir = revisions_dir(root, rel_path);
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut timestamps: Vec<u64> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name();
            let name = name.to_string_lossy();
            name.strip_suffix(".md")?.parse().ok()
        })
        .collect();
    timestamps.sort_unstable_by(|a, b| b.cmp(a));
    timestamps
}

/// Get the content of a specific revision (decrypts if vault provided).
pub fn get_revision(
    root: &Path,
    rel_path: &str,
    timestamp: u64,
    vault: Option<&Vault>,
) -> Option<String> {
    let dir = revisions_dir(root, rel_path);
    let path = dir.join(format!("{timestamp}.md"));
    if let Some(vault) = vault {
        vault.read_to_string(&path).ok()
    } else {
        fs::read_to_string(path).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("tansu_test_rev_{name}_{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn save_and_list_revision() {
        let tmp = temp_dir("save_list");
        let note = tmp.join("test.md");
        fs::write(&note, "hello").unwrap();
        save_revision(&tmp, "test.md", &note);
        let revs = list_revisions(&tmp, "test.md");
        assert_eq!(revs.len(), 1);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn get_revision_content() {
        let tmp = temp_dir("get_content");
        let note = tmp.join("test.md");
        fs::write(&note, "hello").unwrap();
        save_revision(&tmp, "test.md", &note);
        let revs = list_revisions(&tmp, "test.md");
        let content = get_revision(&tmp, "test.md", revs[0], None).unwrap();
        assert_eq!(content, "hello");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn two_rapid_saves_produce_distinct_revisions() {
        let tmp = temp_dir("rapid_saves");
        let note = tmp.join("test.md");
        fs::write(&note, "hello").unwrap();
        save_revision(&tmp, "test.md", &note);
        std::thread::sleep(std::time::Duration::from_millis(2));
        fs::write(&note, "world").unwrap();
        save_revision(&tmp, "test.md", &note);
        let revs = list_revisions(&tmp, "test.md");
        assert_eq!(
            revs.len(),
            2,
            "two rapid saves should produce two revisions"
        );
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn revisions_dir_handles_subdirectory_paths() {
        let tmp = temp_dir("subdir");
        let sub = tmp.join("sub");
        fs::create_dir_all(&sub).unwrap();
        let note = sub.join("note.md");
        fs::write(&note, "content").unwrap();
        save_revision(&tmp, "sub/note.md", &note);
        let revs = list_revisions(&tmp, "sub/note.md");
        assert_eq!(revs.len(), 1);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn migrate_revisions_moves_history() {
        let tmp = temp_dir("migrate");
        let note = tmp.join("old.md");
        fs::write(&note, "content").unwrap();
        save_revision(&tmp, "old.md", &note);
        migrate_revisions(&tmp, "old.md", "new.md");
        assert!(list_revisions(&tmp, "old.md").is_empty());
        assert_eq!(list_revisions(&tmp, "new.md").len(), 1);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn get_revision_encrypted() {
        use crate::crypto;
        let tmp = temp_dir("encrypted_rev");
        let note = tmp.join("test.md");

        let vault = Vault::from_raw(crypto::generate_master_key());
        vault.write(&note, b"encrypted content").unwrap();

        // save_revision copies raw bytes (already encrypted)
        save_revision(&tmp, "test.md", &note);
        let revs = list_revisions(&tmp, "test.md");
        assert_eq!(revs.len(), 1);

        // get_revision with vault decrypts
        let content = get_revision(&tmp, "test.md", revs[0], Some(&vault)).unwrap();
        assert_eq!(content, "encrypted content");

        // get_revision without vault returns None (can't decrypt)
        let raw = get_revision(&tmp, "test.md", revs[0], None);
        assert!(raw.is_none() || raw.unwrap() != "encrypted content");

        let _ = fs::remove_dir_all(&tmp);
    }
}
