use std::collections::{HashMap, VecDeque};
use std::ffi::OsString;
use std::fmt::Write as _;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use blake3::hash as blake3_hash;
use lz4_flex::{compress_prepend_size, decompress_size_prepended};

use crate::{Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineEnding {
    Lf,
    CrLf,
    Cr,
}

impl LineEnding {
    fn bytes(self) -> &'static [u8] {
        match self {
            Self::Lf => b"\n",
            Self::CrLf => b"\r\n",
            Self::Cr => b"\r",
        }
    }
}

#[derive(Debug, Clone)]
pub struct SourceDocument {
    pub source: String,
    pub disk_bytes: Vec<u8>,
    pub line_endings: Vec<LineEnding>,
    dominant_line_ending: LineEnding,
}

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

impl SourceDocument {
    pub fn from_disk(bytes: &[u8]) -> Result<Self> {
        let text = std::str::from_utf8(bytes)
            .map_err(|_| Error::BadRequest("markdown must be valid UTF-8".to_string()))?;
        let mut source = String::with_capacity(text.len());
        let mut line_endings = Vec::new();
        let mut counts = [0_usize; 3];
        let mut chars = text.char_indices().peekable();
        while let Some((_, ch)) = chars.next() {
            match ch {
                '\r' => {
                    let ending = if matches!(chars.peek(), Some((_, '\n'))) {
                        chars.next();
                        LineEnding::CrLf
                    } else {
                        LineEnding::Cr
                    };
                    line_endings.push(ending);
                    counts[line_ending_index(ending)] += 1;
                    source.push('\n');
                }
                '\n' => {
                    line_endings.push(LineEnding::Lf);
                    counts[line_ending_index(LineEnding::Lf)] += 1;
                    source.push('\n');
                }
                _ => source.push(ch),
            }
        }
        let dominant_line_ending = if counts[0] >= counts[1] && counts[0] >= counts[2] {
            LineEnding::Lf
        } else if counts[1] >= counts[2] {
            LineEnding::CrLf
        } else {
            LineEnding::Cr
        };
        Ok(Self {
            source,
            disk_bytes: bytes.to_vec(),
            line_endings,
            dominant_line_ending,
        })
    }

    pub fn disk_bytes_for_source(&self, source: &str) -> Result<Vec<u8>> {
        if source == self.source {
            return Ok(self.disk_bytes.clone());
        }
        if source.contains('\r') {
            return Err(Error::BadRequest(
                "editor source must use LF line endings".to_string(),
            ));
        }
        let original_lines = self.source.split('\n').collect::<Vec<_>>();
        let mut original_positions = HashMap::<&str, VecDeque<usize>>::new();
        for (index, line) in original_lines.iter().enumerate() {
            if index < self.line_endings.len() {
                original_positions
                    .entry(line)
                    .or_default()
                    .push_back(index);
            }
        }
        let mut last_original_line = None;
        let candidate_lines = source.split('\n').collect::<Vec<_>>();
        let mut bytes = Vec::with_capacity(source.len() + self.line_endings.len());
        for (index, line) in candidate_lines.iter().enumerate() {
            bytes.extend_from_slice(line.as_bytes());
            if index + 1 == candidate_lines.len() {
                continue;
            }
            let ending = original_positions
                .get_mut(line)
                .and_then(|positions| {
                    while positions.front().is_some_and(|position| {
                        last_original_line.is_some_and(|last| *position <= last)
                    }) {
                        positions.pop_front();
                    }
                    positions.pop_front()
                })
                .map(|line| {
                    last_original_line = Some(line);
                    self.line_endings[line]
                })
                .unwrap_or(self.dominant_line_ending);
            bytes.extend_from_slice(ending.bytes());
        }
        Ok(bytes)
    }
}

fn line_ending_index(ending: LineEnding) -> usize {
    match ending {
        LineEnding::Lf => 0,
        LineEnding::CrLf => 1,
        LineEnding::Cr => 2,
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

pub fn content_hash(content: &str) -> String {
    source_hash(content)
}

pub fn source_hash(content: &str) -> String {
    format!("blake3-v3:{}", digest(normalize_lf(content).as_bytes()))
}

pub fn disk_hash(bytes: &[u8]) -> String {
    format!("blake3-v2:{}", digest(bytes))
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

fn normalize_lf(content: &str) -> String {
    content.replace("\r\n", "\n").replace('\r', "\n")
}

fn digest(bytes: &[u8]) -> String {
    hex(blake3_hash(bytes).as_bytes())
}

fn hex(bytes: &[u8]) -> String {
    let mut hex = String::with_capacity(64);
    for byte in bytes {
        write!(&mut hex, "{byte:02x}").expect("writing to String cannot fail");
    }
    hex
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
    fn source_hash_normalizes_line_endings_and_keeps_the_bom() {
        assert_eq!(
            source_hash("\u{feff}a\nb\nc\nd"),
            source_hash("\u{feff}a\r\nb\rc\nd")
        );
        assert_ne!(source_hash("a"), source_hash("\u{feff}a"));
        assert_eq!(
            source_hash("hello\n"),
            "blake3-v3:8e4c7c1b99dbfd50e7a95185fead5ee1448fa904a2fdd778eaf5f2dbfd629a99"
        );
    }

    #[test]
    fn disk_hash_uses_blake3_over_exact_bytes() {
        assert_eq!(
            disk_hash(b"hello\n"),
            "blake3-v2:8e4c7c1b99dbfd50e7a95185fead5ee1448fa904a2fdd778eaf5f2dbfd629a99"
        );
        assert_ne!(disk_hash(b"hello\n"), disk_hash(b"hello\r\n"));
    }

    #[test]
    fn source_document_preserves_untouched_endings_and_uses_dominant_for_inserted_lines() {
        let source = SourceDocument::from_disk(b"a\r\nb\nc\r").unwrap();
        assert_eq!(source.source, "a\nb\nc\n");
        assert_eq!(source.line_endings, vec![LineEnding::CrLf, LineEnding::Lf, LineEnding::Cr]);
        assert_eq!(
            source.disk_bytes_for_source("a\ninserted\nb\nc\n").unwrap(),
            b"a\r\ninserted\nb\nc\r"
        );
    }

    #[test]
    fn source_document_preserves_original_bytes_for_no_op_edits() {
        for bytes in [b"\xef\xbb\xbfalpha\r\n\r\nomega".as_slice(), b"x\rY\nZ"] {
            let source = SourceDocument::from_disk(bytes).unwrap();
            assert_eq!(source.disk_bytes_for_source(&source.source).unwrap(), bytes);
        }
    }

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
