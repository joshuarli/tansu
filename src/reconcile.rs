use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use crate::api_types::{ApiErrorKind, NoteEventKind, NoteEventSource, UnresolvedReason};
use crate::catalog::{Catalog, InsertNote, NoteRow};
use crate::history::{self, SourceDocument};
use crate::paths::{
    normalize_note_path, path_key, read_visible_bytes, write_visible_note_bytes_atomic,
    write_visible_note_bytes_new,
};
use crate::tags::parse_markdown;
use crate::{Error, Result};

pub fn reconcile_vault(
    root: &Path,
    state_root: &Path,
    catalog: &mut Catalog,
    excluded_folders: &[String],
) -> Result<()> {
    let files = walk_markdown(root, state_root, excluded_folders)?;
    let mut seen_keys: HashMap<String, Vec<FileRecord>> = HashMap::new();
    for file in files {
        seen_keys
            .entry(file.path_key.clone())
            .or_default()
            .push(file);
    }
    let live_paths = catalog
        .live_notes()?
        .into_iter()
        .map(|note| note.path)
        .collect::<HashSet<_>>();
    for records in seen_keys.values_mut() {
        records.sort_by(|left, right| left.path.cmp(&right.path));
        if records.len() > 1 {
            let live_path_index = primary_record_index(records, &live_paths);
            records.swap(0, live_path_index);
            for record in records.iter().skip(1) {
                insert_unresolved(state_root, catalog, record, UnresolvedReason::CaseFoldCollision)?;
            }
        }
    }

    let primary_files = seen_keys
        .into_values()
        .filter_map(|mut records| records.drain(..).next())
        .collect::<Vec<_>>();
    let rows = catalog.all_rows()?;
    let live_rows = rows
        .iter()
        .filter(|row| !row.tombstoned && row.unresolved_reason.is_none())
        .cloned()
        .collect::<Vec<_>>();
    let live_paths = live_rows
        .iter()
        .map(|row| path_key(&row.meta.path))
        .collect::<HashSet<_>>();
    let mut consumed = HashSet::new();

    for row in &live_rows {
        let key = path_key(&row.meta.path);
        let Some(file) = primary_files.iter().find(|file| file.path_key == key) else {
            continue;
        };
        consumed.insert(file.path_key.clone());
        apply_visible_version(root, state_root, catalog, row, file)?;
    }

    let unmatched_rows = live_rows
        .iter()
        .filter(|row| !primary_files.iter().any(|file| file.path_key == path_key(&row.meta.path)))
        .cloned()
        .collect::<Vec<_>>();
    let unmatched_files = primary_files
        .iter()
        .filter(|file| !consumed.contains(&file.path_key) && file.unresolved.is_none())
        .collect::<Vec<_>>();
    let moved_pairs = unambiguous_move_pairs(&unmatched_rows, &unmatched_files);
    let moved_note_ids = moved_pairs
        .iter()
        .map(|(row_index, _)| unmatched_rows[*row_index].meta.note_id.clone())
        .collect::<HashSet<_>>();
    let moved_paths = moved_pairs
        .iter()
        .map(|(_, file_index)| unmatched_files[*file_index].path_key.clone())
        .collect::<HashSet<_>>();
    for (row_index, file_index) in moved_pairs {
        let row = &unmatched_rows[row_index];
        let file = unmatched_files[file_index];
        catalog.rename_note(&row.meta.note_id, &file.path, &file.path_key)?;
        catalog.record_visible_hash(&row.meta.note_id, &file.disk_hash)?;
        let migrated = history::write_snapshot_bytes(
            state_root,
            &row.meta.note_id,
            &file.source_hash,
            &file.disk_bytes,
        )?;
        if migrated != row.meta.content_hash {
            catalog.migrate_current_hashes(
                &row.meta.note_id,
                &row.meta.content_hash,
                &file.source_hash,
                &file.disk_hash,
            )?;
        }
        consumed.insert(file.path_key.clone());
    }

    for row in unmatched_rows {
        if moved_note_ids.contains(&row.meta.note_id) {
            continue;
        }
        match history::read_snapshot_bytes_for_reconciliation(
            state_root,
            &row.meta.note_id,
            &row.meta.content_hash,
        ) {
            Ok(bytes) if should_repair_missing_visible(catalog, &row.meta.note_id)? => {
                write_visible_note_bytes_new(root, &row.meta.path, &bytes)?;
                let document = SourceDocument::from_disk(&bytes)?;
                catalog.record_visible_hash(&row.meta.note_id, &history::disk_hash(&bytes))?;
                let source_hash = history::source_hash(&document.source);
                if source_hash != row.meta.content_hash {
                    catalog.migrate_current_hashes(
                        &row.meta.note_id,
                        &row.meta.content_hash,
                        &source_hash,
                        &history::disk_hash(&bytes),
                    )?;
                }
            }
            Ok(_) => {
                catalog.tombstone_note(
                    &row.meta.note_id,
                    NoteEventKind::ExternalDelete,
                    NoteEventSource::External,
                )?;
            }
            Err(history::SnapshotReadError::Missing(_)) => {
                catalog.mark_unresolved(&row.meta.note_id, UnresolvedReason::MissingSnapshot)?;
            }
            Err(history::SnapshotReadError::Corrupt(_)) => {
                catalog.mark_unresolved(&row.meta.note_id, UnresolvedReason::CorruptSnapshot)?;
            }
            Err(history::SnapshotReadError::Other(error)) => return Err(error),
        }
    }

    for file in primary_files {
        if consumed.contains(&file.path_key) || moved_paths.contains(&file.path_key) {
            continue;
        }
        if let Some(reason) = file.unresolved.clone() {
            insert_unresolved(state_root, catalog, &file, reason)?;
            continue;
        }
        if catalog.note_by_path_key(&file.path_key)?.is_some() || live_paths.contains(&file.path_key) {
            continue;
        }
        let parsed = parse_markdown(&file.path, &file.source);
        let note_id = catalog.insert_note(InsertNote {
            path: &file.path,
            path_key: &file.path_key,
            title: &parsed.title,
            tags: &parsed.tags,
            content_hash: &file.source_hash,
            visible_hash: &file.disk_hash,
            kind: NoteEventKind::Baseline,
            source: NoteEventSource::External,
            unresolved: None,
        })?;
        history::write_snapshot_bytes(
            state_root,
            &note_id,
            &file.source_hash,
            &file.disk_bytes,
        )?;
    }
    Ok(())
}

pub fn reconcile_note_before_write(
    root: &Path,
    state_root: &Path,
    catalog: &mut Catalog,
    note_id: &str,
) -> Result<bool> {
    let row = catalog
        .note_row_by_id(note_id)?
        .ok_or_else(|| Error::NotFound(note_id.to_string()))?;
    if row.tombstoned {
        return Err(Error::NotFound(note_id.to_string()));
    }
    if let Some(reason) = row.unresolved_reason.as_deref() {
        return Err(Error::api(ApiErrorKind::UnresolvedNote {
            note_id: note_id.to_string(),
            reason: parse_unresolved_reason(reason),
        }));
    }
    let bytes = match read_visible_bytes(root, &row.meta.path) {
        Ok(bytes) => bytes,
        Err(Error::Io(error)) if error.kind() == ErrorKind::NotFound => {
            catalog.tombstone_note(
                note_id,
                NoteEventKind::ExternalDelete,
                NoteEventSource::External,
            )?;
            return Err(Error::NotFound(note_id.to_string()));
        }
        Err(error) => return Err(error),
    };
    let document = match SourceDocument::from_disk(&bytes) {
        Ok(document) => document,
        Err(_) => {
            catalog.mark_unresolved(note_id, UnresolvedReason::InvalidUtf8)?;
            return Err(Error::api(ApiErrorKind::UnresolvedNote {
                note_id: note_id.to_string(),
                reason: UnresolvedReason::InvalidUtf8,
            }));
        }
    };
    let source_hash = history::source_hash(&document.source);
    let disk_hash = history::disk_hash(&bytes);
    if history::source_hash_matches(&row.meta.content_hash, &document.source) {
        if row.meta.content_hash != source_hash {
            history::write_snapshot_bytes(state_root, note_id, &source_hash, &bytes)?;
            catalog.migrate_current_hashes(
                note_id,
                &row.meta.content_hash,
                &source_hash,
                &disk_hash,
            )?;
            return Ok(true);
        }
        if row.visible_hash != disk_hash {
            history::write_snapshot_bytes(state_root, note_id, &source_hash, &bytes)?;
            catalog.record_visible_hash(note_id, &disk_hash)?;
            return Ok(true);
        }
        return Ok(false);
    }
    if row.visible_hash == disk_hash {
        catalog.mark_unresolved(note_id, UnresolvedReason::FileCatalogMismatch)?;
        return Err(Error::api(ApiErrorKind::UnresolvedNote {
            note_id: note_id.to_string(),
            reason: UnresolvedReason::FileCatalogMismatch,
        }));
    }
    history::write_snapshot_bytes(state_root, note_id, &source_hash, &bytes)?;
    let parsed = parse_markdown(&row.meta.path, &document.source);
    catalog.update_note_content(
        note_id,
        &parsed.title,
        &parsed.tags,
        &source_hash,
        &disk_hash,
        NoteEventKind::ExternalEdit,
        NoteEventSource::External,
    )?;
    Ok(true)
}

#[derive(Debug, Clone)]
struct FileRecord {
    path: String,
    path_key: String,
    source_hash: String,
    legacy_hash: String,
    legacy_v2_hash: String,
    disk_hash: String,
    source: String,
    disk_bytes: Vec<u8>,
    unresolved: Option<UnresolvedReason>,
}

fn walk_markdown(
    root: &Path,
    state_root: &Path,
    excluded_folders: &[String],
) -> Result<Vec<FileRecord>> {
    let mut out = Vec::new();
    walk_dir(root, state_root, root, excluded_folders, &mut out)?;
    Ok(out)
}

fn walk_dir(
    root: &Path,
    state_root: &Path,
    dir: &Path,
    excluded_folders: &[String],
    out: &mut Vec<FileRecord>,
) -> Result<()> {
    if !dir.exists() {
        fs::create_dir_all(dir)?;
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.starts_with(state_root) {
            continue;
        }
        let file_name = match entry.file_name().to_str() {
            Some(file_name) => file_name.to_string(),
            None => continue,
        };
        if file_name == ".tansu" || excluded_folders.iter().any(|folder| folder == &file_name) {
            continue;
        }
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            walk_dir(root, state_root, &path, excluded_folders, out)?;
            continue;
        }
        if !file_type.is_file() || path.extension().and_then(|value| value.to_str()) != Some("md") {
            continue;
        }
        let rel = path
            .strip_prefix(root)
            .map_err(|_| Error::Internal("walked path outside vault".to_string()))?
            .to_str()
            .ok_or_else(|| Error::BadRequest("Markdown path is not valid UTF-8".to_string()))?
            .replace('\\', "/");
        let rel = match normalize_note_path(&rel) {
            Ok(rel) => rel,
            Err(_) => continue,
        };
        let disk_bytes = read_visible_bytes(root, &rel)?;
        let disk_hash = history::disk_hash(&disk_bytes);
        match SourceDocument::from_disk(&disk_bytes) {
            Ok(document) => out.push(FileRecord {
                path: rel,
                path_key: path_key(&entry_path_to_string(&path, root)?),
                source_hash: history::source_hash(&document.source),
                legacy_hash: history::legacy_content_hash(&document.source),
                legacy_v2_hash: history::legacy_source_hash_v2(&document.source),
                disk_hash,
                source: document.source,
                disk_bytes,
                unresolved: None,
            }),
            Err(_) => out.push(FileRecord {
                path_key: path_key(&rel),
                path: rel.clone(),
                source_hash: format!("invalid-utf8:{}", path_key(&rel)),
                legacy_hash: String::new(),
                legacy_v2_hash: String::new(),
                disk_hash,
                source: String::new(),
                disk_bytes,
                unresolved: Some(UnresolvedReason::InvalidUtf8),
            }),
        }
    }
    Ok(())
}

fn entry_path_to_string(path: &Path, root: &Path) -> Result<String> {
    path.strip_prefix(root)
        .map_err(|_| Error::Internal("walked path outside vault".to_string()))?
        .to_str()
        .map(|value| value.replace('\\', "/"))
        .ok_or_else(|| Error::BadRequest("Markdown path is not valid UTF-8".to_string()))
}

fn unambiguous_move_pairs(rows: &[NoteRow], files: &[&FileRecord]) -> Vec<(usize, usize)> {
    let mut rows_by_hash = HashMap::<&str, Vec<usize>>::new();
    for (index, row) in rows.iter().enumerate() {
        rows_by_hash
            .entry(row.meta.content_hash.as_str())
            .or_default()
            .push(index);
    }
    let mut files_by_hash = HashMap::<&str, Vec<usize>>::new();
    for (index, file) in files.iter().enumerate() {
        files_by_hash
            .entry(file.source_hash.as_str())
            .or_default()
            .push(index);
        files_by_hash
            .entry(file.legacy_hash.as_str())
            .or_default()
            .push(index);
        files_by_hash
            .entry(file.legacy_v2_hash.as_str())
            .or_default()
            .push(index);
    }
    let mut pairs = Vec::new();
    let mut claimed_files = HashSet::new();
    for (hash, row_indices) in rows_by_hash {
        if row_indices.len() != 1 {
            continue;
        }
        let Some(file_indices) = files_by_hash.get(hash) else {
            continue;
        };
        let unique_files = file_indices
            .iter()
            .copied()
            .filter(|index| !claimed_files.contains(index))
            .collect::<HashSet<_>>();
        if unique_files.len() == 1 {
            let file_index = *unique_files.iter().next().expect("one move candidate");
            if claimed_files.insert(file_index) {
                pairs.push((row_indices[0], file_index));
            }
        }
    }
    pairs
}

fn should_repair_missing_visible(catalog: &Catalog, note_id: &str) -> Result<bool> {
    let Some((kind, source)) = catalog.latest_event(note_id)? else {
        return Ok(false);
    };
    Ok(source == "user" && matches!(kind.as_str(), "create" | "save" | "rename" | "import"))
}

fn insert_unresolved(
    state_root: &Path,
    catalog: &mut Catalog,
    record: &FileRecord,
    reason: UnresolvedReason,
) -> Result<()> {
    if catalog.live_path_exists(&record.path)?
        || catalog.unresolved_path_exists(&record.path, reason.clone())?
    {
        return Ok(());
    }
    let parsed = parse_markdown(&record.path, &record.source);
    let note_id = catalog.insert_note(InsertNote {
        path: &record.path,
        path_key: &record.path_key,
        title: &parsed.title,
        tags: &parsed.tags,
        content_hash: &record.source_hash,
        visible_hash: &record.disk_hash,
        kind: NoteEventKind::Baseline,
        source: NoteEventSource::External,
        unresolved: Some(reason),
    })?;
    if !record.source.is_empty() {
        history::write_snapshot_bytes(
            state_root,
            &note_id,
            &history::source_hash(&record.source),
            &record.disk_bytes,
        )?;
    }
    Ok(())
}

fn primary_record_index(records: &[FileRecord], live_paths: &HashSet<String>) -> usize {
    records
        .iter()
        .position(|record| live_paths.contains(&record.path))
        .unwrap_or(0)
}

fn apply_visible_version(
    root: &Path,
    state_root: &Path,
    catalog: &mut Catalog,
    row: &NoteRow,
    file: &FileRecord,
) -> Result<()> {
    if let Some(reason) = file.unresolved.clone() {
        catalog.mark_unresolved(&row.meta.note_id, reason)?;
        return Ok(());
    }
    let source_matches = row.meta.content_hash == file.source_hash
        || row.meta.content_hash == file.legacy_hash
        || row.meta.content_hash == file.legacy_v2_hash;
    if source_matches {
        if let Err(error) = history::read_snapshot_bytes_for_reconciliation(
            state_root,
            &row.meta.note_id,
            &row.meta.content_hash,
        ) {
            if mark_snapshot_unresolved(catalog, &row.meta.note_id, &error)? {
                return Ok(());
            }
            return Err(error.into_error());
        }
        if row.meta.content_hash != file.source_hash {
            history::write_snapshot_bytes(
                state_root,
                &row.meta.note_id,
                &file.source_hash,
                &file.disk_bytes,
            )?;
            catalog.migrate_current_hashes(
                &row.meta.note_id,
                &row.meta.content_hash,
                &file.source_hash,
                &file.disk_hash,
            )?;
        } else if row.visible_hash != file.disk_hash {
            history::write_snapshot_bytes(
                state_root,
                &row.meta.note_id,
                &file.source_hash,
                &file.disk_bytes,
            )?;
            catalog.record_visible_hash(&row.meta.note_id, &file.disk_hash)?;
        }
        return Ok(());
    }
    if row.visible_hash == file.disk_hash {
        let bytes = match history::read_snapshot_bytes_for_reconciliation(
            state_root,
            &row.meta.note_id,
            &row.meta.content_hash,
        ) {
            Ok(bytes) => bytes,
            Err(error) if mark_snapshot_unresolved(catalog, &row.meta.note_id, &error)? => {
                return Ok(());
            }
            Err(error) => return Err(error.into_error()),
        };
        write_visible_note_bytes_atomic(root, &row.meta.path, &bytes)?;
        catalog.record_visible_hash(&row.meta.note_id, &history::disk_hash(&bytes))?;
        return Ok(());
    }
    let parsed = parse_markdown(&file.path, &file.source);
    history::write_snapshot_bytes(
        state_root,
        &row.meta.note_id,
        &file.source_hash,
        &file.disk_bytes,
    )?;
    catalog.update_note_content(
        &row.meta.note_id,
        &parsed.title,
        &parsed.tags,
        &file.source_hash,
        &file.disk_hash,
        NoteEventKind::ExternalEdit,
        NoteEventSource::External,
    )?;
    Ok(())
}

fn mark_snapshot_unresolved(
    catalog: &mut Catalog,
    note_id: &str,
    error: &history::SnapshotReadError,
) -> Result<bool> {
    let reason = match error {
        history::SnapshotReadError::Missing(_) => UnresolvedReason::MissingSnapshot,
        history::SnapshotReadError::Corrupt(_) => UnresolvedReason::CorruptSnapshot,
        history::SnapshotReadError::Other(_) => return Ok(false),
    };
    catalog.mark_unresolved(note_id, reason)?;
    Ok(true)
}

fn parse_unresolved_reason(value: &str) -> UnresolvedReason {
    match value {
        "case_fold_collision" => UnresolvedReason::CaseFoldCollision,
        "invalid_utf8" => UnresolvedReason::InvalidUtf8,
        "missing_snapshot" => UnresolvedReason::MissingSnapshot,
        "corrupt_snapshot" => UnresolvedReason::CorruptSnapshot,
        _ => UnresolvedReason::FileCatalogMismatch,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use crate::api_types::{NoteEventKind, NoteEventSource};

    use super::*;

    #[test]
    fn case_fold_collision_preserves_exact_live_path_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let original_bytes = b"# Original\n\ncanonical\n";
        fs::write(dir.path().join("a.md"), original_bytes).unwrap();
        let state_root = dir.path().join("state");
        let mut catalog = Catalog::open(&state_root.join("vault.db")).unwrap();
        reconcile_vault(dir.path(), &state_root, &mut catalog, &[]).unwrap();
        let original = catalog.live_notes().unwrap().remove(0);
        let collision_source = "# Collision\n\nother\n";
        let collision_bytes = collision_source.as_bytes();
        let collision = FileRecord {
            path: "A.md".to_string(),
            path_key: path_key("A.md"),
            source_hash: history::source_hash(collision_source),
            legacy_hash: history::legacy_content_hash(collision_source),
            legacy_v2_hash: history::legacy_source_hash_v2(collision_source),
            disk_hash: history::disk_hash(collision_bytes),
            source: collision_source.to_string(),
            disk_bytes: collision_bytes.to_vec(),
            unresolved: Some(UnresolvedReason::CaseFoldCollision),
        };
        let canonical = walk_markdown(dir.path(), &state_root, &[]).unwrap().remove(0);
        let candidates = [collision.clone(), canonical];
        assert_eq!(
            primary_record_index(&candidates, &HashSet::from([original.path.clone()])),
            1
        );
        insert_unresolved(
            &state_root,
            &mut catalog,
            &collision,
            UnresolvedReason::CaseFoldCollision,
        )
        .unwrap();
        insert_unresolved(
            &state_root,
            &mut catalog,
            &collision,
            UnresolvedReason::CaseFoldCollision,
        )
        .unwrap();

        let live = catalog.live_notes().unwrap();
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].note_id, original.note_id);
        assert_eq!(live[0].path, "a.md");
        assert_eq!(live[0].content_hash, original.content_hash);
        assert_eq!(fs::read(dir.path().join("a.md")).unwrap(), original_bytes);
        let rows = catalog.all_rows().unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().any(|row| {
            row.meta.path == "A.md"
                && row.unresolved_reason.as_deref() == Some("case_fold_collision")
        }));

        reconcile_vault(dir.path(), &state_root, &mut catalog, &[]).unwrap();

        assert_eq!(catalog.all_rows().unwrap().len(), 2);
    }

    #[test]
    fn missing_or_corrupt_current_snapshots_mark_notes_unresolved() {
        for (damage, remove_visible, expected_reason) in [
            ("missing", false, "missing_snapshot"),
            ("corrupt", false, "corrupt_snapshot"),
            ("missing", true, "missing_snapshot"),
            ("corrupt", true, "corrupt_snapshot"),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let visible = dir.path().join("A.md");
            let bytes = b"# A\ncurrent\n";
            fs::write(&visible, bytes).unwrap();
            let state_root = dir.path().join("state");
            let mut catalog = Catalog::open(&state_root.join("vault.db")).unwrap();
            reconcile_vault(dir.path(), &state_root, &mut catalog, &[]).unwrap();
            let note = catalog.live_notes().unwrap().remove(0);
            let snapshot = state_root
                .join("history/snapshots")
                .join(&note.note_id)
                .join(format!("{}.lz4", note.content_hash.replace(':', "_")));
            match damage {
                "missing" => fs::remove_file(snapshot).unwrap(),
                "corrupt" => fs::write(snapshot, b"not a snapshot").unwrap(),
                _ => unreachable!(),
            }
            if remove_visible {
                fs::remove_file(&visible).unwrap();
            }

            reconcile_vault(dir.path(), &state_root, &mut catalog, &[]).unwrap();

            let rows = catalog.all_rows().unwrap();
            assert_eq!(rows[0].unresolved_reason.as_deref(), Some(expected_reason));
            if !remove_visible {
                assert_eq!(fs::read(&visible).unwrap(), bytes);
            }
        }
    }

    #[test]
    fn exact_hash_external_rename_preserves_note_id() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("A.md"), "# A\n\nsame\n").unwrap();
        let mut catalog = Catalog::open(&dir.path().join("state").join("vault.db")).unwrap();
        reconcile_vault(dir.path(), &dir.path().join("state"), &mut catalog, &[]).unwrap();
        let before = catalog.live_notes().unwrap().remove(0);

        fs::rename(dir.path().join("A.md"), dir.path().join("Renamed.md")).unwrap();
        reconcile_vault(dir.path(), &dir.path().join("state"), &mut catalog, &[]).unwrap();
        let after = catalog.live_notes().unwrap().remove(0);

        assert_eq!(after.note_id, before.note_id);
        assert_eq!(after.path, "Renamed.md");
    }

    #[test]
    fn legacy_hashes_migrate_during_external_rename_without_losing_identity() {
        let content = "# A\n\nsame\n";
        let bytes = content.as_bytes();
        for previous_hash in [
            history::legacy_source_hash_v2(content),
            history::legacy_content_hash(content),
        ] {
            let dir = tempfile::tempdir().unwrap();
            fs::write(dir.path().join("A.md"), bytes).unwrap();
            let state = dir.path().join("state");
            let mut catalog = Catalog::open(&state.join("vault.db")).unwrap();
            reconcile_vault(dir.path(), &state, &mut catalog, &[]).unwrap();
            let before = catalog.live_notes().unwrap().remove(0);
            let old_disk_hash = history::legacy_disk_hash(bytes);
            let old_snapshot = state
                .join("history/snapshots")
                .join(&before.note_id)
                .join(format!("{}.lz4", previous_hash.replace(':', "_")));
            fs::create_dir_all(old_snapshot.parent().unwrap()).unwrap();
            fs::write(&old_snapshot, lz4_flex::compress_prepend_size(bytes)).unwrap();
            drop(catalog);

            let connection = rusqlite::Connection::open(state.join("vault.db")).unwrap();
            connection.execute(
                "UPDATE notes SET content_hash=?2, visible_hash=?3 WHERE note_id=?1",
                rusqlite::params![&before.note_id, &previous_hash, &old_disk_hash],
            ).unwrap();
            connection.execute(
                "UPDATE note_events SET content_hash=?2 WHERE note_id=?1 AND seq=?3",
                rusqlite::params![&before.note_id, &previous_hash, before.seq],
            ).unwrap();
            drop(connection);
            fs::rename(dir.path().join("A.md"), dir.path().join("Renamed.md")).unwrap();

            let mut catalog = Catalog::open(&state.join("vault.db")).unwrap();
            reconcile_vault(dir.path(), &state, &mut catalog, &[]).unwrap();
            let migrated = catalog.live_notes().unwrap().remove(0);
            let row = catalog.note_row_by_id(&before.note_id).unwrap().unwrap();

            assert_eq!(migrated.note_id, before.note_id);
            assert_eq!(migrated.path, "Renamed.md");
            assert_eq!(migrated.seq, before.seq + 1);
            assert_eq!(row.meta.content_hash, history::source_hash(content));
            assert_eq!(row.visible_hash, history::disk_hash(bytes));
            assert_eq!(history::read_snapshot_bytes(&state, &before.note_id, &previous_hash).unwrap(), bytes);
            assert_eq!(fs::read(dir.path().join("Renamed.md")).unwrap(), bytes);
        }
    }

    #[test]
    fn moved_and_edited_file_becomes_delete_plus_new_note() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("A.md"), "# A\n\nsame\n").unwrap();
        let mut catalog = Catalog::open(&dir.path().join("state").join("vault.db")).unwrap();
        reconcile_vault(dir.path(), &dir.path().join("state"), &mut catalog, &[]).unwrap();
        let original = catalog.live_notes().unwrap().remove(0);

        fs::remove_file(dir.path().join("A.md")).unwrap();
        fs::write(dir.path().join("Moved.md"), "# A\n\nchanged\n").unwrap();
        reconcile_vault(dir.path(), &dir.path().join("state"), &mut catalog, &[]).unwrap();
        let live = catalog.live_notes().unwrap();
        let rows = catalog.all_rows().unwrap();

        assert_eq!(live.len(), 1);
        assert_ne!(live[0].note_id, original.note_id);
        assert!(rows.iter().any(|row| row.meta.note_id == original.note_id && row.tombstoned));
    }

    #[test]
    fn identical_content_never_pairs_external_moves_ambiguously() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("A.md"), "same\n").unwrap();
        fs::write(dir.path().join("B.md"), "same\n").unwrap();
        let mut catalog = Catalog::open(&dir.path().join("state").join("vault.db")).unwrap();
        reconcile_vault(dir.path(), &dir.path().join("state"), &mut catalog, &[]).unwrap();
        let original = catalog.live_notes().unwrap();

        fs::remove_file(dir.path().join("A.md")).unwrap();
        fs::remove_file(dir.path().join("B.md")).unwrap();
        fs::write(dir.path().join("C.md"), "same\n").unwrap();
        fs::write(dir.path().join("D.md"), "same\n").unwrap();
        reconcile_vault(dir.path(), &dir.path().join("state"), &mut catalog, &[]).unwrap();

        let live = catalog.live_notes().unwrap();
        assert_eq!(live.len(), 2);
        assert!(live.iter().all(|note| !original.iter().any(|old| old.note_id == note.note_id)));
    }

    #[test]
    fn invalid_utf8_file_is_unresolved_and_excluded_from_live_notes() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("Bad.md"), [0xff, 0xfe]).unwrap();
        let mut catalog = Catalog::open(&dir.path().join("state").join("vault.db")).unwrap();

        reconcile_vault(dir.path(), &dir.path().join("state"), &mut catalog, &[]).unwrap();

        assert!(catalog.live_notes().unwrap().is_empty());
        let rows = catalog.all_rows().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].unresolved_reason.as_deref(), Some("invalid_utf8"));
    }

    #[test]
    fn interrupted_user_save_repairs_visible_file_from_latest_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("A.md"), "# A\n\nold\n").unwrap();
        let mut catalog = Catalog::open(&dir.path().join("state").join("vault.db")).unwrap();
        reconcile_vault(dir.path(), &dir.path().join("state"), &mut catalog, &[]).unwrap();
        let note = catalog.live_notes().unwrap().remove(0);
        let accepted = "# A\n\nnew\n";
        let accepted_source_hash = history::write_snapshot(&dir.path().join("state"), &note.note_id, accepted).unwrap();
        let base_disk_hash = history::disk_hash(b"# A\n\nold\n");
        let parsed = parse_markdown(&note.path, accepted);
        catalog
            .update_note_content(
                &note.note_id,
                &parsed.title,
                &parsed.tags,
                &accepted_source_hash,
                &base_disk_hash,
                NoteEventKind::Save,
                NoteEventSource::User,
            )
            .unwrap();

        reconcile_vault(dir.path(), &dir.path().join("state"), &mut catalog, &[]).unwrap();

        let visible = fs::read_to_string(dir.path().join("A.md")).unwrap();
        assert_eq!(visible, accepted);
        let row = catalog.note_row_by_id(&note.note_id).unwrap().unwrap();
        assert_eq!(row.meta.content_hash, accepted_source_hash);
        assert_eq!(row.visible_hash, history::disk_hash(accepted.as_bytes()));
    }

    #[test]
    fn external_edit_after_accepted_save_is_preserved_when_visible_hash_changed() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("A.md"), "# A\n\nold\n").unwrap();
        let mut catalog = Catalog::open(&dir.path().join("state").join("vault.db")).unwrap();
        reconcile_vault(dir.path(), &dir.path().join("state"), &mut catalog, &[]).unwrap();
        let note = catalog.live_notes().unwrap().remove(0);
        let accepted = "# A\n\nnew\n";
        let accepted_source_hash = history::write_snapshot(&dir.path().join("state"), &note.note_id, accepted).unwrap();
        let base_disk_hash = history::disk_hash(b"# A\n\nold\n");
        let parsed = parse_markdown(&note.path, accepted);
        catalog
            .update_note_content(
                &note.note_id,
                &parsed.title,
                &parsed.tags,
                &accepted_source_hash,
                &base_disk_hash,
                NoteEventKind::Save,
                NoteEventSource::User,
            )
            .unwrap();
        fs::write(dir.path().join("A.md"), "# A\n\nexternal\n").unwrap();

        reconcile_vault(dir.path(), &dir.path().join("state"), &mut catalog, &[]).unwrap();

        let live = catalog.live_notes().unwrap().remove(0);
        assert_eq!(live.note_id, note.note_id);
        assert_eq!(live.content_hash, history::content_hash("# A\n\nexternal\n"));
        assert_eq!(fs::read_to_string(dir.path().join("A.md")).unwrap(), "# A\n\nexternal\n");
    }

    #[test]
    fn watcher_delay_preflight_adopts_external_content_before_save() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("A.md"), "base\r\n").unwrap();
        let state = dir.path().join("state");
        let mut catalog = Catalog::open(&state.join("vault.db")).unwrap();
        reconcile_vault(dir.path(), &state, &mut catalog, &[]).unwrap();
        let note = catalog.live_notes().unwrap().remove(0);
        fs::write(dir.path().join("A.md"), "external\r").unwrap();

        assert!(reconcile_note_before_write(dir.path(), &state, &mut catalog, &note.note_id).unwrap());
        let updated = catalog.note_by_id(&note.note_id).unwrap().unwrap();
        let row = catalog.note_row_by_id(&note.note_id).unwrap().unwrap();
        assert_ne!(updated.content_hash, note.content_hash);
        assert_eq!(row.visible_hash, history::disk_hash(b"external\r"));
        assert_eq!(history::read_snapshot_bytes(&state, &note.note_id, &updated.content_hash).unwrap(), b"external\r");
    }
}
