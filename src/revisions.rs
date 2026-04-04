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
        .map(|d| d.as_secs())
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
