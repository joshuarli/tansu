use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use lz4_flex::{compress_prepend_size, decompress_size_prepended};
use tansu_note_core::{SourceDocument, normalize_lf, source_hash};

use crate::{Error, Result};

pub(crate) enum SnapshotReadError {
    Missing(String),
    Corrupt(String),
    Other(Error),
}

impl SnapshotReadError {
    pub(crate) fn into_error(self) -> Error {
        match self {
            Self::Missing(hash) => Error::NotFound(format!("missing snapshot {hash}")),
            Self::Corrupt(hash) => Error::Internal(format!("corrupt snapshot {hash}")),
            Self::Other(error) => error,
        }
    }
}

pub fn canonical_markdown_bytes(content: &str) -> Vec<u8> {
    normalize_lf(content).into_bytes()
}

pub fn canonical_markdown_string(content: &str) -> String {
    normalize_lf(content)
}

pub fn validate_and_canonicalize(bytes: &[u8]) -> Result<String> {
    Ok(SourceDocument::from_disk(bytes)?.source)
}

pub fn source_hash_format_version(hash: &str) -> Result<u16> {
    if valid_hash(hash, "blake3-v3:") {
        Ok(3)
    } else {
        Err(Error::Internal("catalog source hash uses an unsupported format".to_string()))
    }
}

pub fn disk_hash_format_version(hash: &str) -> Result<u16> {
    if valid_hash(hash, "blake3-v2:") {
        Ok(2)
    } else {
        Err(Error::Internal("catalog disk hash uses an unsupported format".to_string()))
    }
}

fn valid_hash(hash: &str, prefix: &str) -> bool {
    hash.strip_prefix(prefix).is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

pub fn write_snapshot(root: &Path, note_id: &str, content: &str) -> Result<String> {
    let source = canonical_markdown_string(content);
    write_snapshot_bytes(root, note_id, &source_hash(&source), source.as_bytes())
}

pub fn write_snapshot_bytes(
    root: &Path,
    note_id: &str,
    expected_source_hash: &str,
    disk_bytes: &[u8],
) -> Result<String> {
    validate_note_id(note_id)?;
    let document = SourceDocument::from_disk(disk_bytes)?;
    let hash = source_hash(&document.source);
    if expected_source_hash != hash {
        return Err(Error::Internal(format!(
            "snapshot source hash mismatch for {expected_source_hash}"
        )));
    }
    let dir = root.join("history").join("snapshots").join(note_id);
    fs::create_dir_all(&dir)?;
    let path = dir.join(hash_filename(&hash));
    #[cfg(test)]
    crate::failure_point::check(crate::failure_point::FailurePoint::SnapshotWritePermissionDenied)?;
    write_compressed_atomic(&path, disk_bytes)?;
    #[cfg(test)]
    crate::failure_point::check(crate::failure_point::FailurePoint::SnapshotWritten)?;
    Ok(hash)
}

pub fn read_snapshot(root: &Path, note_id: &str, hash: &str) -> Result<String> {
    let bytes = read_snapshot_bytes(root, note_id, hash)?;
    validate_and_canonicalize(&bytes)
}

pub fn read_snapshot_bytes(root: &Path, note_id: &str, hash: &str) -> Result<Vec<u8>> {
    read_snapshot_bytes_for_reconciliation(root, note_id, hash)
        .map_err(SnapshotReadError::into_error)
}

pub(crate) fn read_snapshot_bytes_for_reconciliation(
    root: &Path,
    note_id: &str,
    hash: &str,
) -> std::result::Result<Vec<u8>, SnapshotReadError> {
    validate_note_id(note_id).map_err(SnapshotReadError::Other)?;
    if !valid_snapshot_hash(hash) {
        return Err(SnapshotReadError::Other(Error::BadRequest(
            "invalid snapshot hash".to_string(),
        )));
    }
    let path = root
        .join("history")
        .join("snapshots")
        .join(note_id)
        .join(hash_filename(hash));
    let compressed = fs::read(&path).map_err(|error| {
        if error.kind() == ErrorKind::NotFound {
            SnapshotReadError::Missing(hash.to_string())
        } else {
            SnapshotReadError::Other(Error::Io(error))
        }
    })?;
    let bytes = decompress_size_prepended(&compressed)
        .map_err(|_| SnapshotReadError::Corrupt(hash.to_string()))?;
    let document = SourceDocument::from_disk(&bytes)
        .map_err(|_| SnapshotReadError::Corrupt(hash.to_string()))?;
    if source_hash(&document.source) != hash {
        return Err(SnapshotReadError::Corrupt(hash.to_string()));
    }
    Ok(bytes)
}

pub fn write_conflict_draft(
    root: &Path,
    note_id: &str,
    draft_id: i64,
    content: &str,
) -> Result<String> {
    validate_note_id(note_id)?;
    let source = canonical_markdown_string(content);
    let hash = source_hash(&source);
    let dir = root.join("history").join("conflicts").join(note_id);
    fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{draft_id}.lz4"));
    write_compressed_atomic(&path, source.as_bytes())?;
    Ok(hash)
}

pub fn read_conflict_draft(
    root: &Path,
    note_id: &str,
    draft_id: i64,
    expected_hash: &str,
) -> Result<String> {
    validate_note_id(note_id)?;
    let path = root
        .join("history")
        .join("conflicts")
        .join(note_id)
        .join(format!("{draft_id}.lz4"));
    let compressed = fs::read(path)?;
    let bytes = decompress_size_prepended(&compressed)
        .map_err(|_| Error::Internal("corrupt conflict draft".to_string()))?;
    let content = validate_and_canonicalize(&bytes)?;
    if source_hash(&content) != expected_hash {
        return Err(Error::Internal("conflict draft hash mismatch".to_string()));
    }
    Ok(content)
}

pub fn write_visible_atomic(path: &Path, content: &str) -> Result<()> {
    write_bytes_atomic(path, canonical_markdown_bytes(content).as_slice())
}

pub fn write_visible_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    write_bytes_atomic(path, bytes)
}

pub fn write_visible_bytes_new(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    write_new_atomic(path, bytes)
}

pub fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    write_atomic(path, bytes)
}

pub fn sync_parent_dir(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        sync_dir(parent)?;
    }
    Ok(())
}

fn write_compressed_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    write_atomic(path, &compress_prepend_size(bytes))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = create_temp_file(path, bytes)?;
    let result = (|| {
        if fs::symlink_metadata(path)
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err(Error::BadRequest("refusing to replace a symlink".to_string()));
        }
        fs::rename(&tmp, path)?;
        sync_parent_dir(path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn write_new_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = create_temp_file(path, bytes)?;
    let result = (|| {
        fs::hard_link(&tmp, path)?;
        fs::remove_file(&tmp)?;
        sync_parent_dir(path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn create_temp_file(path: &Path, bytes: &[u8]) -> Result<PathBuf> {
    let parent = path
        .parent()
        .ok_or_else(|| Error::BadRequest("atomic path has no parent".to_string()))?;
    fs::create_dir_all(parent)?;
    let name = path
        .file_name()
        .ok_or_else(|| Error::BadRequest("atomic path has no filename".to_string()))?;
    for _ in 0..32 {
        let mut temp_name = OsString::from(".");
        temp_name.push(name);
        temp_name.push(format!(".{}.tmp", fastrand::u64(..)));
        let tmp = parent.join(temp_name);
        match OpenOptions::new().write(true).create_new(true).open(&tmp) {
            Ok(mut file) => {
                let result = file.write_all(bytes).and_then(|()| file.sync_all());
                if let Err(error) = result {
                    let _ = fs::remove_file(&tmp);
                    return Err(Error::Io(error));
                }
                return Ok(tmp);
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(Error::Io(error)),
        }
    }
    Err(Error::Internal("could not allocate an atomic temp file".to_string()))
}

fn sync_dir(path: &Path) -> Result<()> {
    fs::File::open(path)?.sync_all()?;
    Ok(())
}

fn hash_filename(hash: &str) -> String {
    format!("{}.lz4", hash.replace(':', "_"))
}

fn valid_snapshot_hash(hash: &str) -> bool {
    valid_hash(hash, "blake3-v3:")
}

fn validate_note_id(note_id: &str) -> Result<()> {
    if note_id.is_empty()
        || note_id == "."
        || note_id == ".."
        || note_id.contains('/')
        || note_id.contains('\\')
        || note_id.contains('\0')
    {
        return Err(Error::BadRequest("invalid note ID".to_string()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_hash_cannot_escape_its_history_directory() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_snapshot_bytes(dir.path(), "note", "../../../../etc/passwd").is_err());
        assert!(read_snapshot_bytes(dir.path(), "../../note", &source_hash("safe")).is_err());
    }

    #[test]
    fn visible_create_is_no_clobber_and_replace_uses_unique_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        write_visible_bytes_new(&path, b"first").unwrap();
        assert!(write_visible_bytes_new(&path, b"second").is_err());
        write_visible_bytes_atomic(&path, b"replaced").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"replaced");
        assert!(fs::read_dir(dir.path()).unwrap().all(|entry| {
            !entry.unwrap().file_name().to_string_lossy().ends_with(".tmp")
        }));
    }

    #[test]
    fn atomic_replace_refuses_a_symlink_destination() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target.md");
        let link = dir.path().join("link.md");
        fs::write(&target, b"outside").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        assert!(write_visible_bytes_atomic(&link, b"inside").is_err());
        assert_eq!(fs::read(&target).unwrap(), b"outside");
    }
}
