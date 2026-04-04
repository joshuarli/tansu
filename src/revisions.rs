use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

/// Directory for revisions of a given note path.
fn revisions_dir(root: &Path, rel_path: &str) -> PathBuf {
    let stem = Path::new(rel_path)
        .with_extension("")
        .to_string_lossy()
        .into_owned();
    root.join(".tansu/revisions").join(stem)
}

/// Save the current content of a note as a revision.
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

/// Get the content of a specific revision.
pub fn get_revision(root: &Path, rel_path: &str, timestamp: u64) -> Option<String> {
    let dir = revisions_dir(root, rel_path);
    let path = dir.join(format!("{timestamp}.md"));
    fs::read_to_string(path).ok()
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
        let content = get_revision(&tmp, "test.md", revs[0]).unwrap();
        assert_eq!(content, "hello");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn two_rapid_saves_produce_distinct_revisions() {
        let tmp = temp_dir("rapid_saves");
        let note = tmp.join("test.md");
        fs::write(&note, "hello").unwrap();
        save_revision(&tmp, "test.md", &note);
        // Small delay to ensure distinct millisecond timestamps
        std::thread::sleep(std::time::Duration::from_millis(2));
        fs::write(&note, "world").unwrap();
        save_revision(&tmp, "test.md", &note);
        let revs = list_revisions(&tmp, "test.md");
        assert_eq!(revs.len(), 2, "two rapid saves should produce two revisions");
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
}
