use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, Transaction, params};

use crate::api_types::{
    ConflictDraftMeta, NoteEventKind, NoteEventSource, NoteMeta, RevisionMeta,
    SearchStatus, Settings, UnresolvedReason, ValidatedSettings,
};
use crate::{Error, Result};

#[derive(Debug, Clone)]
pub struct NoteRow {
    pub meta: NoteMeta,
    pub visible_hash: String,
    pub tombstoned: bool,
    pub unresolved_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MutationRecord {
    pub mutation_id: String,
    pub payload_hash: String,
    pub state: String,
    pub kind: String,
    pub note_id: Option<String>,
    pub path: Option<String>,
    pub old_path: Option<String>,
    pub expected_disk_hash: Option<String>,
    pub source_hash: Option<String>,
    pub disk_hash: Option<String>,
    pub result_json: Option<String>,
}

#[derive(Debug, Clone)]
pub struct MutationIntent<'a> {
    pub mutation_id: &'a str,
    pub payload_hash: &'a str,
    pub kind: &'a str,
    pub note_id: Option<&'a str>,
    pub path: Option<&'a str>,
    pub old_path: Option<&'a str>,
    pub expected_disk_hash: Option<&'a str>,
    pub source_hash: Option<&'a str>,
    pub disk_hash: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredVaultEvent {
    pub event_version: u64,
    pub payload_json: String,
}

pub struct Catalog {
    conn: Connection,
}

pub struct InsertNote<'a> {
    pub path: &'a str,
    pub path_key: &'a str,
    pub title: &'a str,
    pub tags: &'a [String],
    pub content_hash: &'a str,
    pub visible_hash: &'a str,
    pub kind: NoteEventKind,
    pub source: NoteEventSource,
    pub unresolved: Option<UnresolvedReason>,
}

impl Catalog {
    pub fn open(path: &std::path::Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "
            PRAGMA foreign_keys = ON;
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = FULL;
            PRAGMA busy_timeout = 5000;
            ",
        )?;
        let mut catalog = Self { conn };
        catalog.migrate()?;
        Ok(catalog)
    }

    fn migrate(&mut self) -> Result<()> {
        self.conn.execute_batch(
            "
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS schema_migrations (
              version INTEGER PRIMARY KEY,
              applied_at_ms INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS vault_meta (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS notes (
              note_id TEXT PRIMARY KEY,
              path TEXT NOT NULL,
              path_key TEXT NOT NULL,
              title TEXT NOT NULL,
              tags_json TEXT NOT NULL,
              seq INTEGER NOT NULL,
              content_hash TEXT NOT NULL,
              visible_hash TEXT NOT NULL DEFAULT '',
              updated_at_ms INTEGER NOT NULL,
              tombstoned INTEGER NOT NULL DEFAULT 0,
              unresolved_reason TEXT
            );
            CREATE UNIQUE INDEX IF NOT EXISTS notes_live_path_key_unique
              ON notes(path_key)
              WHERE tombstoned = 0 AND unresolved_reason IS NULL;
            CREATE TABLE IF NOT EXISTS note_events (
              event_id INTEGER PRIMARY KEY AUTOINCREMENT,
              note_id TEXT NOT NULL,
              seq INTEGER NOT NULL,
              kind TEXT NOT NULL,
              source TEXT NOT NULL,
              path TEXT NOT NULL,
              content_hash TEXT,
              created_at_ms INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS conflict_drafts (
              draft_id INTEGER PRIMARY KEY AUTOINCREMENT,
              note_id TEXT NOT NULL,
              base_seq INTEGER NOT NULL,
              base_hash TEXT NOT NULL,
              content_hash TEXT NOT NULL,
              created_at_ms INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS mutation_operations (
              mutation_id TEXT PRIMARY KEY,
              payload_hash TEXT NOT NULL,
              state TEXT NOT NULL CHECK(state IN ('prepared', 'pending_materialization', 'accepted', 'conflict')),
              kind TEXT NOT NULL,
              note_id TEXT,
              path TEXT,
              old_path TEXT,
              expected_disk_hash TEXT,
              source_hash TEXT,
              disk_hash TEXT,
              result_json TEXT,
              created_at_ms INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS vault_events (
              event_version INTEGER PRIMARY KEY,
              payload_json TEXT NOT NULL,
              created_at_ms INTEGER NOT NULL
            );
            ",
        )?;
        self.conn.execute_batch(
            "DROP TABLE IF EXISTS pins; DROP TABLE IF EXISTS recent; DROP TABLE IF EXISTS session;",
        )?;
        ensure_column(
            &self.conn,
            "notes",
            "visible_hash",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        self.conn.execute(
            "UPDATE notes SET visible_hash=content_hash WHERE visible_hash=''",
            [],
        )?;
        self.conn.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at_ms) VALUES(1, ?1)",
            params![now_ms()],
        )?;
        self.conn.execute(
            "INSERT OR IGNORE INTO vault_meta(key, value) VALUES('sync_version', '0')",
            [],
        )?;
        self.conn.execute(
            "INSERT OR IGNORE INTO vault_meta(key, value) VALUES('search_dirty', 'false')",
            [],
        )?;
        self.conn.execute(
            "INSERT OR IGNORE INTO vault_meta(key, value) VALUES('search_degraded', 'false')",
            [],
        )?;
        self.conn.execute(
            "INSERT OR IGNORE INTO vault_meta(key, value) VALUES('watcher_reconcile_pending', 'false')",
            [],
        )?;
        Ok(())
    }

    pub fn insert_note(&mut self, note: InsertNote<'_>) -> Result<String> {
        let note_id = generate_note_id();
        self.insert_note_with_id(&note_id, note)?;
        Ok(note_id)
    }

    pub fn insert_note_with_id(&mut self, note_id: &str, note: InsertNote<'_>) -> Result<()> {
        let tx = self.conn.transaction()?;
        insert_note_tx(&tx, note_id, note)?;
        advance_sync_tx(&tx)?;
        tx.commit()?;
        Ok(())
    }

    pub fn update_note_content(
        &mut self,
        note_id: &str,
        title: &str,
        tags: &[String],
        content_hash: &str,
        visible_hash: &str,
        kind: NoteEventKind,
        source: NoteEventSource,
    ) -> Result<NoteMeta> {
        let tx = self.conn.transaction()?;
        let current =
            note_by_id_tx(&tx, note_id)?.ok_or_else(|| Error::NotFound(note_id.to_string()))?;
        let seq = current.meta.seq + 1;
        let now = now_ms();
        tx.execute(
            "UPDATE notes SET title=?2, tags_json=?3, seq=?4, content_hash=?5, visible_hash=?6, updated_at_ms=?7, tombstoned=0, unresolved_reason=NULL WHERE note_id=?1",
            params![note_id, title, serde_json::to_string(tags)?, seq, content_hash, visible_hash, now],
        )?;
        tx.execute(
            "INSERT INTO note_events(note_id, seq, kind, source, path, content_hash, created_at_ms) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![note_id, seq, event_kind(kind), event_source(source), current.meta.path, content_hash, now],
        )?;
        advance_sync_tx(&tx)?;
        tx.commit()?;
        self.note_row_by_id(note_id)?
            .map(|row| row.meta)
            .ok_or_else(|| Error::NotFound(note_id.to_string()))
    }

    pub fn rename_note(&mut self, note_id: &str, path: &str, path_key: &str) -> Result<NoteMeta> {
        let tx = self.conn.transaction()?;
        let current =
            note_by_id_tx(&tx, note_id)?.ok_or_else(|| Error::NotFound(note_id.to_string()))?;
        let seq = current.meta.seq + 1;
        let now = now_ms();
        tx.execute(
            "UPDATE notes SET path=?2, path_key=?3, seq=?4, updated_at_ms=?5 WHERE note_id=?1 AND tombstoned=0 AND unresolved_reason IS NULL",
            params![note_id, path, path_key, seq, now],
        )?;
        tx.execute(
            "INSERT INTO note_events(note_id, seq, kind, source, path, content_hash, created_at_ms) VALUES(?1, ?2, 'rename', 'user', ?3, NULL, ?4)",
            params![note_id, seq, path, now],
        )?;
        advance_sync_tx(&tx)?;
        tx.commit()?;
        self.note_row_by_id(note_id)?
            .map(|row| row.meta)
            .ok_or_else(|| Error::NotFound(note_id.to_string()))
    }

    pub fn tombstone_note(
        &mut self,
        note_id: &str,
        kind: NoteEventKind,
        source: NoteEventSource,
    ) -> Result<NoteMeta> {
        let tx = self.conn.transaction()?;
        let current =
            note_by_id_tx(&tx, note_id)?.ok_or_else(|| Error::NotFound(note_id.to_string()))?;
        let seq = current.meta.seq + 1;
        let now = now_ms();
        tx.execute(
            "UPDATE notes SET tombstoned=1, seq=?2, updated_at_ms=?3 WHERE note_id=?1",
            params![note_id, seq, now],
        )?;
        tx.execute(
            "INSERT INTO note_events(note_id, seq, kind, source, path, content_hash, created_at_ms) VALUES(?1, ?2, ?3, ?4, ?5, NULL, ?6)",
            params![note_id, seq, event_kind(kind), event_source(source), current.meta.path, now],
        )?;
        advance_sync_tx(&tx)?;
        tx.commit()?;
        self.note_row_by_id(note_id)?
            .map(|row| row.meta)
            .ok_or_else(|| Error::NotFound(note_id.to_string()))
    }

    pub fn mark_unresolved(&mut self, note_id: &str, reason: UnresolvedReason) -> Result<()> {
        self.conn.execute(
            "UPDATE notes SET unresolved_reason=?2 WHERE note_id=?1",
            params![note_id, unresolved_reason(reason)],
        )?;
        self.advance_sync()?;
        Ok(())
    }

    pub fn record_visible_hash(&mut self, note_id: &str, visible_hash: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE notes SET visible_hash=?2 WHERE note_id=?1",
            params![note_id, visible_hash],
        )?;
        Ok(())
    }

    pub fn migrate_current_hashes(
        &mut self,
        note_id: &str,
        previous_source_hash: &str,
        source_hash: &str,
        visible_hash: &str,
    ) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "UPDATE notes SET content_hash=?3, visible_hash=?4 WHERE note_id=?1 AND content_hash=?2",
            params![note_id, previous_source_hash, source_hash, visible_hash],
        )?;
        tx.execute(
            "UPDATE note_events SET content_hash=?3 WHERE event_id=(SELECT MAX(event_id) FROM note_events WHERE note_id=?1) AND note_id=?1 AND content_hash=?2",
            params![note_id, previous_source_hash, source_hash],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn prepare_mutation(&mut self, intent: MutationIntent<'_>) -> Result<()> {
        self.conn.execute(
            "INSERT INTO mutation_operations(mutation_id, payload_hash, state, kind, note_id, path, old_path, expected_disk_hash, source_hash, disk_hash, created_at_ms) VALUES(?1, ?2, 'prepared', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                intent.mutation_id,
                intent.payload_hash,
                intent.kind,
                intent.note_id,
                intent.path,
                intent.old_path,
                intent.expected_disk_hash,
                intent.source_hash,
                intent.disk_hash,
                now_ms()
            ],
        )?;
        #[cfg(test)]
        crate::failure_point::check(crate::failure_point::FailurePoint::IntentCommitted)?;
        Ok(())
    }

    pub fn clear_prepared_mutation(&mut self, mutation_id: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM mutation_operations WHERE mutation_id=?1 AND state='prepared'",
            params![mutation_id],
        )?;
        Ok(())
    }

    pub fn accept_note_content_mutation(
        &mut self,
        mutation_id: &str,
        note_id: &str,
        title: &str,
        tags: &[String],
        source_hash: &str,
        visible_hash_before_materialization: &str,
        kind: NoteEventKind,
        source: NoteEventSource,
        pending_result_json: &str,
    ) -> Result<NoteMeta> {
        let tx = self.conn.transaction()?;
        let current = note_by_id_tx(&tx, note_id)?
            .ok_or_else(|| Error::NotFound(note_id.to_string()))?;
        let seq = current.meta.seq + 1;
        let now = now_ms();
        tx.execute(
            "UPDATE notes SET title=?2, tags_json=?3, seq=?4, content_hash=?5, visible_hash=?6, updated_at_ms=?7, tombstoned=0, unresolved_reason=NULL WHERE note_id=?1",
            params![note_id, title, serde_json::to_string(tags)?, seq, source_hash, visible_hash_before_materialization, now],
        )?;
        tx.execute(
            "INSERT INTO note_events(note_id, seq, kind, source, path, content_hash, created_at_ms) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![note_id, seq, event_kind(kind), event_source(source), current.meta.path, source_hash, now],
        )?;
        advance_sync_tx(&tx)?;
        let changed = tx.execute(
            "UPDATE mutation_operations SET state='pending_materialization', result_json=?2 WHERE mutation_id=?1 AND state='prepared'",
            params![mutation_id, pending_result_json],
        )?;
        if changed != 1 {
            return Err(Error::Internal(format!("mutation intent {mutation_id} was not prepared")));
        }
        tx.commit()?;
        #[cfg(test)]
        crate::failure_point::check(crate::failure_point::FailurePoint::CatalogTransitionCommitted)?;
        self.note_row_by_id(note_id)?
            .map(|row| row.meta)
            .ok_or_else(|| Error::NotFound(note_id.to_string()))
    }

    pub fn accept_new_note_mutation(
        &mut self,
        mutation_id: &str,
        note_id: &str,
        note: InsertNote<'_>,
        pending_result_json: &str,
    ) -> Result<()> {
        let tx = self.conn.transaction()?;
        insert_note_tx(&tx, note_id, note)?;
        advance_sync_tx(&tx)?;
        let changed = tx.execute(
            "UPDATE mutation_operations SET state='pending_materialization', result_json=?2 WHERE mutation_id=?1 AND state='prepared'",
            params![mutation_id, pending_result_json],
        )?;
        if changed != 1 {
            return Err(Error::Internal(format!("mutation intent {mutation_id} was not prepared")));
        }
        tx.commit()?;
        #[cfg(test)]
        crate::failure_point::check(crate::failure_point::FailurePoint::CatalogTransitionCommitted)?;
        Ok(())
    }

    pub fn accept_rename_mutation(
        &mut self,
        mutation_id: &str,
        note_id: &str,
        path: &str,
        path_key: &str,
        title: &str,
        pending_result_json: &str,
    ) -> Result<NoteMeta> {
        let tx = self.conn.transaction()?;
        let current = note_by_id_tx(&tx, note_id)?
            .ok_or_else(|| Error::NotFound(note_id.to_string()))?;
        let seq = current.meta.seq + 1;
        let now = now_ms();
        tx.execute(
            "UPDATE notes SET path=?2, path_key=?3, title=?4, seq=?5, updated_at_ms=?6 WHERE note_id=?1 AND tombstoned=0 AND unresolved_reason IS NULL",
            params![note_id, path, path_key, title, seq, now],
        )?;
        tx.execute(
            "INSERT INTO note_events(note_id, seq, kind, source, path, content_hash, created_at_ms) VALUES(?1, ?2, 'rename', 'user', ?3, NULL, ?4)",
            params![note_id, seq, path, now],
        )?;
        advance_sync_tx(&tx)?;
        let changed = tx.execute(
            "UPDATE mutation_operations SET state='pending_materialization', result_json=?2 WHERE mutation_id=?1 AND state='prepared'",
            params![mutation_id, pending_result_json],
        )?;
        if changed != 1 {
            return Err(Error::Internal(format!("mutation intent {mutation_id} was not prepared")));
        }
        tx.commit()?;
        #[cfg(test)]
        crate::failure_point::check(crate::failure_point::FailurePoint::CatalogTransitionCommitted)?;
        self.note_row_by_id(note_id)?
            .map(|row| row.meta)
            .ok_or_else(|| Error::NotFound(note_id.to_string()))
    }

    pub fn accept_delete_mutation(
        &mut self,
        mutation_id: &str,
        note_id: &str,
        pending_result_json: &str,
    ) -> Result<NoteMeta> {
        let tx = self.conn.transaction()?;
        let current = note_by_id_tx(&tx, note_id)?
            .ok_or_else(|| Error::NotFound(note_id.to_string()))?;
        let seq = current.meta.seq + 1;
        let now = now_ms();
        tx.execute(
            "UPDATE notes SET tombstoned=1, seq=?2, updated_at_ms=?3 WHERE note_id=?1",
            params![note_id, seq, now],
        )?;
        tx.execute(
            "INSERT INTO note_events(note_id, seq, kind, source, path, content_hash, created_at_ms) VALUES(?1, ?2, 'delete', 'user', ?3, NULL, ?4)",
            params![note_id, seq, current.meta.path, now],
        )?;
        advance_sync_tx(&tx)?;
        let changed = tx.execute(
            "UPDATE mutation_operations SET state='pending_materialization', result_json=?2 WHERE mutation_id=?1 AND state='prepared'",
            params![mutation_id, pending_result_json],
        )?;
        if changed != 1 {
            return Err(Error::Internal(format!("mutation intent {mutation_id} was not prepared")));
        }
        tx.commit()?;
        #[cfg(test)]
        crate::failure_point::check(crate::failure_point::FailurePoint::CatalogTransitionCommitted)?;
        self.note_row_by_id(note_id)?
            .map(|row| row.meta)
            .ok_or_else(|| Error::NotFound(note_id.to_string()))
    }

    pub fn next_conflict_draft_id(&self) -> Result<i64> {
        self.conn
            .query_row(
                "SELECT COALESCE(MAX(draft_id), 0) + 1 FROM conflict_drafts",
                [],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    pub fn record_conflict_mutation(
        &mut self,
        mutation_id: &str,
        result_json: &str,
        draft_id: i64,
        note_id: &str,
        base_seq: i64,
        base_hash: &str,
        content_hash: &str,
        created_at_ms: i64,
    ) -> Result<ConflictDraftMeta> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO conflict_drafts(draft_id, note_id, base_seq, base_hash, content_hash, created_at_ms) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
            params![draft_id, note_id, base_seq, base_hash, content_hash, created_at_ms],
        )?;
        let changed = tx.execute(
            "UPDATE mutation_operations SET state='conflict', result_json=?2 WHERE mutation_id=?1 AND state='prepared'",
            params![mutation_id, result_json],
        )?;
        if changed != 1 {
            return Err(Error::Internal(format!("mutation intent {mutation_id} was not prepared")));
        }
        tx.commit()?;
        Ok(ConflictDraftMeta {
            draft_id,
            note_id: note_id.to_string(),
            base_seq,
            base_hash: base_hash.to_string(),
            content_hash: content_hash.to_string(),
            created_at_ms,
        })
    }

    pub fn complete_mutation(
        &mut self,
        mutation_id: &str,
        result_json: &str,
        event_update_json: Option<&str>,
        retain_events: usize,
        visible_hash_update: Option<(&str, &str)>,
    ) -> Result<Option<u64>> {
        let tx = self.conn.transaction()?;
        if let Some((note_id, visible_hash)) = visible_hash_update {
            tx.execute(
                "UPDATE notes SET visible_hash=?2 WHERE note_id=?1",
                params![note_id, visible_hash],
            )?;
        }
        let changed = tx.execute(
            "UPDATE mutation_operations SET state='accepted', result_json=?2 WHERE mutation_id=?1 AND state='pending_materialization'",
            params![mutation_id, result_json],
        )?;
        if changed != 1 {
            return Err(Error::Internal(format!("mutation {mutation_id} is not pending")));
        }
        let event_version = if let Some(payload) = event_update_json {
            Some(append_vault_event_tx(&tx, payload, retain_events)?)
        } else {
            None
        };
        tx.commit()?;
        #[cfg(test)]
        crate::failure_point::check(crate::failure_point::FailurePoint::CompletionCommitted)?;
        Ok(event_version.map(|version| version as u64))
    }

    pub fn complete_noop_mutation(
        &mut self,
        mutation_id: &str,
        result_json: &str,
    ) -> Result<()> {
        let changed = self.conn.execute(
            "UPDATE mutation_operations SET state='accepted', result_json=?2 WHERE mutation_id=?1 AND state='prepared'",
            params![mutation_id, result_json],
        )?;
        if changed != 1 {
            return Err(Error::Internal(format!("mutation {mutation_id} is not prepared")));
        }
        Ok(())
    }

    pub fn complete_pending_conflict(
        &mut self,
        mutation_id: &str,
        result_json: &str,
        draft_id: i64,
        note_id: &str,
        base_seq: i64,
        base_hash: &str,
        content_hash: &str,
        created_at_ms: i64,
    ) -> Result<ConflictDraftMeta> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO conflict_drafts(draft_id, note_id, base_seq, base_hash, content_hash, created_at_ms) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
            params![draft_id, note_id, base_seq, base_hash, content_hash, created_at_ms],
        )?;
        let changed = tx.execute(
            "UPDATE mutation_operations SET state='conflict', result_json=?2 WHERE mutation_id=?1 AND state='pending_materialization'",
            params![mutation_id, result_json],
        )?;
        if changed != 1 {
            return Err(Error::Internal(format!("mutation {mutation_id} is not pending")));
        }
        tx.commit()?;
        Ok(ConflictDraftMeta {
            draft_id,
            note_id: note_id.to_string(),
            base_seq,
            base_hash: base_hash.to_string(),
            content_hash: content_hash.to_string(),
            created_at_ms,
        })
    }

    pub fn finish_repaired_mutation(
        &mut self,
        mutation_id: &str,
        result_json: &str,
        event_update_json: Option<&str>,
        retain_events: usize,
    ) -> Result<Option<u64>> {
        self.complete_mutation(
            mutation_id,
            result_json,
            event_update_json,
            retain_events,
            None,
        )
    }

    pub fn mutation(&self, mutation_id: &str) -> Result<Option<MutationRecord>> {
        self.conn
            .query_row(
                "SELECT mutation_id, payload_hash, state, kind, note_id, path, old_path, expected_disk_hash, source_hash, disk_hash, result_json FROM mutation_operations WHERE mutation_id=?1",
                params![mutation_id],
                |row| {
                    Ok(MutationRecord {
                        mutation_id: row.get(0)?,
                        payload_hash: row.get(1)?,
                        state: row.get(2)?,
                        kind: row.get(3)?,
                        note_id: row.get(4)?,
                        path: row.get(5)?,
                        old_path: row.get(6)?,
                        expected_disk_hash: row.get(7)?,
                        source_hash: row.get(8)?,
                        disk_hash: row.get(9)?,
                        result_json: row.get(10)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn set_mutation_outcome(
        &mut self,
        mutation_id: &str,
        state: &str,
        result_json: &str,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE mutation_operations SET state=?2, result_json=?3 WHERE mutation_id=?1",
            params![mutation_id, state, result_json],
        )?;
        Ok(())
    }

    pub fn pending_mutations(&self) -> Result<Vec<MutationRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT mutation_id, payload_hash, state, kind, note_id, path, old_path, expected_disk_hash, source_hash, disk_hash, result_json FROM mutation_operations WHERE state='pending_materialization' ORDER BY created_at_ms, mutation_id",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(MutationRecord {
                mutation_id: row.get(0)?,
                payload_hash: row.get(1)?,
                state: row.get(2)?,
                kind: row.get(3)?,
                note_id: row.get(4)?,
                path: row.get(5)?,
                old_path: row.get(6)?,
                expected_disk_hash: row.get(7)?,
                source_hash: row.get(8)?,
                disk_hash: row.get(9)?,
                result_json: row.get(10)?,
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub fn clear_unrecoverable_prepared_mutations(&mut self) -> Result<()> {
        self.conn.execute(
            "DELETE FROM mutation_operations WHERE state='prepared' AND kind!='image_upload'",
            [],
        )?;
        Ok(())
    }

    pub fn append_vault_event(&mut self, payload_json: &str, retain: usize) -> Result<u64> {
        let tx = self.conn.transaction()?;
        let event_version = append_vault_event_tx(&tx, payload_json, retain)?;
        tx.commit()?;
        Ok(event_version as u64)
    }

    pub(crate) fn watcher_reconcile_pending(&self) -> Result<bool> {
        let value: String = self.conn.query_row(
            "SELECT value FROM vault_meta WHERE key='watcher_reconcile_pending'",
            [],
            |row| row.get(0),
        )?;
        match value.as_str() {
            "true" => Ok(true),
            "false" => Ok(false),
            _ => Err(Error::Internal(format!(
                "invalid watcher reconciliation state {value}"
            ))),
        }
    }

    pub(crate) fn mark_watcher_reconcile_pending(&mut self) -> Result<()> {
        self.conn.execute(
            "UPDATE vault_meta SET value='true' WHERE key='watcher_reconcile_pending'",
            [],
        )?;
        Ok(())
    }

    pub(crate) fn clear_watcher_reconcile_pending(&mut self) -> Result<()> {
        self.conn.execute(
            "UPDATE vault_meta SET value='false' WHERE key='watcher_reconcile_pending'",
            [],
        )?;
        Ok(())
    }

    pub(crate) fn append_watcher_resync_event(
        &mut self,
        payload_json: &str,
        retain: usize,
    ) -> Result<u64> {
        let tx = self.conn.transaction()?;
        let event_version = append_vault_event_tx(&tx, payload_json, retain)?;
        tx.execute(
            "UPDATE vault_meta SET value='false' WHERE key='watcher_reconcile_pending'",
            [],
        )?;
        tx.commit()?;
        Ok(event_version as u64)
    }

    pub fn vault_event_window(
        &self,
        after: Option<u64>,
        limit: usize,
    ) -> Result<(u64, Option<u64>, Vec<StoredVaultEvent>)> {
        let current: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(event_version), 0) FROM vault_events",
            [],
            |row| row.get(0),
        )?;
        let oldest: Option<i64> = self.conn.query_row(
            "SELECT MIN(event_version) FROM vault_events",
            [],
            |row| row.get(0),
        )?;
        let after = after.unwrap_or(0).min(current.max(0) as u64) as i64;
        let mut stmt = self.conn.prepare(
            "SELECT event_version, payload_json FROM vault_events WHERE event_version > ?1 ORDER BY event_version LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![after, limit as i64], |row| {
            Ok(StoredVaultEvent {
                event_version: row.get::<_, i64>(0)? as u64,
                payload_json: row.get(1)?,
            })
        })?;
        let events = rows.collect::<std::result::Result<Vec<_>, _>>()?;
        Ok((current.max(0) as u64, oldest.map(|value| value as u64), events))
    }

    pub fn latest_vault_event_version(&self) -> Result<u64> {
        self.conn
            .query_row(
                "SELECT COALESCE(MAX(event_version), 0) FROM vault_events",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map(|version| version.max(0) as u64)
            .map_err(Into::into)
    }

    pub fn note_by_id(&self, note_id: &str) -> Result<Option<NoteMeta>> {
        Ok(self.note_row_by_id(note_id)?.and_then(|row| {
            if row.tombstoned || row.unresolved_reason.is_some() {
                None
            } else {
                Some(row.meta)
            }
        }))
    }

    pub fn note_row_by_id(&self, note_id: &str) -> Result<Option<NoteRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT note_id, path, title, tags_json, seq, content_hash, visible_hash, updated_at_ms, tombstoned, unresolved_reason FROM notes WHERE note_id=?1",
        )?;
        stmt.query_row(params![note_id], row_from_sql)
            .optional()
            .map_err(Into::into)
    }

    pub fn note_by_path_key(&self, path_key: &str) -> Result<Option<NoteMeta>> {
        let mut stmt = self.conn.prepare(
            "SELECT note_id, path, title, tags_json, seq, content_hash, visible_hash, updated_at_ms, tombstoned, unresolved_reason FROM notes WHERE path_key=?1 AND tombstoned=0 AND unresolved_reason IS NULL",
        )?;
        let row: Option<NoteRow> = stmt.query_row(params![path_key], row_from_sql).optional()?;
        Ok(row.map(|row| row.meta))
    }

    pub(crate) fn live_path_exists(&self, path: &str) -> Result<bool> {
        self.conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM notes WHERE path=?1 AND tombstoned=0 AND unresolved_reason IS NULL)",
                params![path],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    pub(crate) fn unresolved_path_exists(
        &self,
        path: &str,
        reason: UnresolvedReason,
    ) -> Result<bool> {
        self.conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM notes WHERE path=?1 AND tombstoned=0 AND unresolved_reason=?2)",
                params![path, unresolved_reason(reason)],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    pub fn live_notes(&self) -> Result<Vec<NoteMeta>> {
        let mut stmt = self.conn.prepare(
            "SELECT note_id, path, title, tags_json, seq, content_hash, visible_hash, updated_at_ms, tombstoned, unresolved_reason FROM notes WHERE tombstoned=0 AND unresolved_reason IS NULL ORDER BY path COLLATE NOCASE",
        )?;
        let rows = stmt.query_map([], row_from_sql)?;
        let mut notes = Vec::new();
        for row in rows {
            notes.push(row?.meta);
        }
        Ok(notes)
    }

    pub fn all_rows(&self) -> Result<Vec<NoteRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT note_id, path, title, tags_json, seq, content_hash, visible_hash, updated_at_ms, tombstoned, unresolved_reason FROM notes ORDER BY path COLLATE NOCASE",
        )?;
        let rows = stmt.query_map([], row_from_sql)?;
        let mut notes = Vec::new();
        for row in rows {
            notes.push(row?);
        }
        Ok(notes)
    }

    pub fn latest_event(&self, note_id: &str) -> Result<Option<(String, String)>> {
        self.conn
            .query_row(
                "SELECT kind, source FROM note_events WHERE note_id=?1 ORDER BY event_id DESC LIMIT 1",
                params![note_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn revisions(&self, note_id: &str) -> Result<Vec<RevisionMeta>> {
        let mut stmt = self.conn.prepare(
            "SELECT event_id, note_id, seq, kind, source, content_hash, created_at_ms FROM note_events WHERE note_id=?1 AND content_hash IS NOT NULL ORDER BY event_id DESC",
        )?;
        let rows = stmt.query_map(params![note_id], revision_from_sql)?;
        let mut revisions = Vec::new();
        for row in rows {
            revisions.push(row?);
        }
        Ok(revisions)
    }

    pub fn revision(&self, note_id: &str, event_id: i64) -> Result<Option<RevisionMeta>> {
        self.conn
            .query_row(
                "SELECT event_id, note_id, seq, kind, source, content_hash, created_at_ms FROM note_events WHERE note_id=?1 AND event_id=?2 AND content_hash IS NOT NULL",
                params![note_id, event_id],
                revision_from_sql,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn create_conflict_draft(
        &mut self,
        note_id: &str,
        base_seq: i64,
        base_hash: &str,
        content_hash: &str,
    ) -> Result<ConflictDraftMeta> {
        let now = now_ms();
        self.conn.execute(
            "INSERT INTO conflict_drafts(note_id, base_seq, base_hash, content_hash, created_at_ms) VALUES(?1, ?2, ?3, ?4, ?5)",
            params![note_id, base_seq, base_hash, content_hash, now],
        )?;
        let draft_id = self.conn.last_insert_rowid();
        Ok(ConflictDraftMeta {
            draft_id,
            note_id: note_id.to_string(),
            base_seq,
            base_hash: base_hash.to_string(),
            content_hash: content_hash.to_string(),
            created_at_ms: now,
        })
    }

    pub fn conflict_draft(
        &self,
        note_id: &str,
        draft_id: i64,
    ) -> Result<Option<ConflictDraftMeta>> {
        self.conn
            .query_row(
                "SELECT draft_id, note_id, base_seq, base_hash, content_hash, created_at_ms FROM conflict_drafts WHERE note_id=?1 AND draft_id=?2",
                params![note_id, draft_id],
                |row| {
                    Ok(ConflictDraftMeta {
                        draft_id: row.get(0)?,
                        note_id: row.get(1)?,
                        base_seq: row.get(2)?,
                        base_hash: row.get(3)?,
                        content_hash: row.get(4)?,
                        created_at_ms: row.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn settings(&self) -> Result<Settings> {
        let value: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM settings WHERE key='settings'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        match value {
            Some(value) => Ok(serde_json::from_str(&value)?),
            None => Ok(Settings::default()),
        }
    }

    pub fn save_settings(&mut self, settings: &ValidatedSettings) -> Result<()> {
        self.conn.execute(
            "INSERT INTO settings(key, value) VALUES('settings', ?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![serde_json::to_string(settings.as_settings())?],
        )?;
        self.set_search_dirty(true, false)?;
        self.advance_sync()
    }

    pub fn search_status(&self) -> Result<SearchStatus> {
        Ok(SearchStatus {
            dirty: self.meta_bool("search_dirty")?,
            degraded: self.meta_bool("search_degraded")?,
        })
    }

    pub fn set_search_dirty(&mut self, dirty: bool, degraded: bool) -> Result<()> {
        self.conn.execute(
            "INSERT INTO vault_meta(key, value) VALUES('search_dirty', ?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![dirty.to_string()],
        )?;
        self.conn.execute(
            "INSERT INTO vault_meta(key, value) VALUES('search_degraded', ?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![degraded.to_string()],
        )?;
        Ok(())
    }

    pub fn sync_version(&self) -> Result<i64> {
        read_sync_version(&self.conn)
    }

    fn advance_sync(&mut self) -> Result<()> {
        let tx = self.conn.transaction()?;
        advance_sync_tx(&tx)?;
        tx.commit()?;
        Ok(())
    }

    fn meta_bool(&self, key: &str) -> Result<bool> {
        self.conn
            .query_row(
                "SELECT value FROM vault_meta WHERE key=?1",
                params![key],
                |row| match row.get::<_, String>(0)?.as_str() {
                    "true" => Ok(true),
                    "false" => Ok(false),
                    other => Err(invalid_column(0, format!("{key} is {other:?}, not a boolean"))),
                },
            )
            .map_err(Into::into)
    }
}

fn insert_note_tx(tx: &Transaction<'_>, note_id: &str, note: InsertNote<'_>) -> Result<()> {
    let now = now_ms();
    let unresolved = note.unresolved.map(unresolved_reason);
    tx.execute(
        "INSERT INTO notes(note_id, path, path_key, title, tags_json, seq, content_hash, visible_hash, updated_at_ms, tombstoned, unresolved_reason) VALUES(?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?8, 0, ?9)",
        params![
            note_id,
            note.path,
            note.path_key,
            note.title,
            serde_json::to_string(note.tags)?,
            note.content_hash,
            note.visible_hash,
            now,
            unresolved
        ],
    )?;
    tx.execute(
        "INSERT INTO note_events(note_id, seq, kind, source, path, content_hash, created_at_ms) VALUES(?1, 1, ?2, ?3, ?4, ?5, ?6)",
        params![
            note_id,
            event_kind(note.kind),
            event_source(note.source),
            note.path,
            note.content_hash,
            now
        ],
    )?;
    Ok(())
}

fn note_by_id_tx(tx: &Transaction<'_>, note_id: &str) -> Result<Option<NoteRow>> {
    let mut stmt = tx.prepare(
        "SELECT note_id, path, title, tags_json, seq, content_hash, visible_hash, updated_at_ms, tombstoned, unresolved_reason FROM notes WHERE note_id=?1",
    )?;
    stmt.query_row(params![note_id], row_from_sql)
        .optional()
        .map_err(Into::into)
}

fn row_from_sql(row: &rusqlite::Row<'_>) -> rusqlite::Result<NoteRow> {
    let tags_json: String = row.get(3)?;
    let tags = serde_json::from_str(&tags_json).map_err(|error| invalid_column(3, error))?;
    let tombstoned = match row.get::<_, i64>(8)? {
        0 => false,
        1 => true,
        other => return Err(invalid_column(8, format!("tombstoned is {other}, not 0 or 1"))),
    };
    Ok(NoteRow {
        meta: NoteMeta {
            note_id: row.get(0)?,
            path: row.get(1)?,
            title: row.get(2)?,
            tags,
            seq: row.get(4)?,
            content_hash: row.get(5)?,
            updated_at_ms: row.get(7)?,
        },
        visible_hash: row.get(6)?,
        tombstoned,
        unresolved_reason: row.get(9)?,
    })
}

fn revision_from_sql(row: &rusqlite::Row<'_>) -> rusqlite::Result<RevisionMeta> {
    Ok(RevisionMeta {
        event_id: row.get(0)?,
        note_id: row.get(1)?,
        seq: row.get(2)?,
        kind: note_event_kind(row.get::<_, String>(3)?.as_str()).map_err(|error| invalid_column(3, error))?,
        source: note_event_source(row.get::<_, String>(4)?.as_str()).map_err(|error| invalid_column(4, error))?,
        content_hash: row.get(5)?,
        created_at_ms: row.get(6)?,
    })
}

fn ensure_column(conn: &Connection, table: &str, column: &str, declaration: &str) -> Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for row in rows {
        if row? == column {
            return Ok(());
        }
    }
    conn.execute(
        &format!("ALTER TABLE {table} ADD COLUMN {column} {declaration}"),
        [],
    )?;
    Ok(())
}

fn invalid_column(
    index: usize,
    error: impl Into<Box<dyn std::error::Error + Send + Sync>>,
) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(index, rusqlite::types::Type::Text, error.into())
}

fn read_sync_version(conn: &Connection) -> Result<i64> {
    conn.query_row(
        "SELECT value FROM vault_meta WHERE key='sync_version'",
        [],
        |row| {
            let value: String = row.get(0)?;
            match value.parse::<i64>() {
                Ok(version) if version >= 0 => Ok(version),
                Ok(version) => Err(invalid_column(0, format!("sync_version is negative: {version}"))),
                Err(error) => Err(invalid_column(0, error)),
            }
        },
    )
    .map_err(Into::into)
}

fn advance_sync_tx(tx: &Transaction<'_>) -> Result<()> {
    let next = read_sync_version(tx)?
        .checked_add(1)
        .ok_or_else(|| Error::Internal("sync version exhausted".to_string()))?;
    tx.execute(
        "UPDATE vault_meta SET value=?1 WHERE key='sync_version'",
        params![next.to_string()],
    )?;
    Ok(())
}

fn append_vault_event_tx(
    tx: &Transaction<'_>,
    payload_json: &str,
    retain: usize,
) -> Result<i64> {
    let current: i64 = tx.query_row(
        "SELECT COALESCE(MAX(event_version), 0) FROM vault_events",
        [],
        |row| row.get(0),
    )?;
    let event_version = current
        .checked_add(1)
        .ok_or_else(|| Error::Internal("vault event version exhausted".to_string()))?;
    tx.execute(
        "INSERT INTO vault_events(event_version, payload_json, created_at_ms) VALUES(?1, ?2, ?3)",
        params![event_version, payload_json, now_ms()],
    )?;
    let first_retained = event_version
        .saturating_sub(retain as i64)
        .saturating_add(1);
    tx.execute(
        "DELETE FROM vault_events WHERE event_version < ?1",
        params![first_retained],
    )?;
    Ok(event_version)
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

pub fn generate_note_id() -> String {
    let mut bytes = [0_u8; 16];
    fastrand::fill(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn event_kind(kind: NoteEventKind) -> &'static str {
    match kind {
        NoteEventKind::Baseline => "baseline",
        NoteEventKind::Create => "create",
        NoteEventKind::Import => "import",
        NoteEventKind::Save => "save",
        NoteEventKind::Rename => "rename",
        NoteEventKind::Delete => "delete",
        NoteEventKind::ExternalEdit => "external_edit",
        NoteEventKind::ExternalRename => "external_rename",
        NoteEventKind::ExternalDelete => "external_delete",
        NoteEventKind::ConflictRecovery => "conflict_recovery",
    }
}

fn note_event_kind(kind: &str) -> std::result::Result<NoteEventKind, String> {
    Ok(match kind {
        "baseline" => NoteEventKind::Baseline,
        "create" => NoteEventKind::Create,
        "import" => NoteEventKind::Import,
        "save" => NoteEventKind::Save,
        "rename" => NoteEventKind::Rename,
        "delete" => NoteEventKind::Delete,
        "external_edit" => NoteEventKind::ExternalEdit,
        "external_rename" => NoteEventKind::ExternalRename,
        "external_delete" => NoteEventKind::ExternalDelete,
        "conflict_recovery" => NoteEventKind::ConflictRecovery,
        other => return Err(format!("unknown note event kind: {other:?}")),
    })
}

fn event_source(source: NoteEventSource) -> &'static str {
    match source {
        NoteEventSource::User => "user",
        NoteEventSource::Import => "import",
        NoteEventSource::External => "external",
        NoteEventSource::Repair => "repair",
    }
}

fn note_event_source(source: &str) -> std::result::Result<NoteEventSource, String> {
    Ok(match source {
        "user" => NoteEventSource::User,
        "import" => NoteEventSource::Import,
        "external" => NoteEventSource::External,
        "repair" => NoteEventSource::Repair,
        other => return Err(format!("unknown note event source: {other:?}")),
    })
}

fn unresolved_reason(reason: UnresolvedReason) -> &'static str {
    match reason {
        UnresolvedReason::CaseFoldCollision => "case_fold_collision",
        UnresolvedReason::InvalidUtf8 => "invalid_utf8",
        UnresolvedReason::MissingSnapshot => "missing_snapshot",
        UnresolvedReason::CorruptSnapshot => "corrupt_snapshot",
        UnresolvedReason::FileCatalogMismatch => "file_catalog_mismatch",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_path_uniqueness_allows_tombstone_reuse() {
        let dir = tempfile::tempdir().unwrap();
        let mut catalog = Catalog::open(&dir.path().join("vault.db")).unwrap();
        let first = catalog
            .insert_note(InsertNote {
                path: "A.md",
                path_key: "a.md",
                title: "A",
                tags: &[],
                content_hash: "sha256:first",
                visible_hash: "sha256:first-disk",
                kind: NoteEventKind::Baseline,
                source: NoteEventSource::External,
                unresolved: None,
            })
            .unwrap();
        catalog
            .tombstone_note(&first, NoteEventKind::Delete, NoteEventSource::User)
            .unwrap();
        catalog
            .insert_note(InsertNote {
                path: "a.md",
                path_key: "a.md",
                title: "a",
                tags: &[],
                content_hash: "sha256:second",
                visible_hash: "sha256:second-disk",
                kind: NoteEventKind::Create,
                source: NoteEventSource::User,
                unresolved: None,
            })
            .unwrap();
    }

    #[test]
    fn settings_round_trip_and_app_state_tables_are_removed() {
        let dir = tempfile::tempdir().unwrap();
        let mut catalog = Catalog::open(&dir.path().join("vault.db")).unwrap();
        let settings = Settings {
            excluded_folders: vec!["Archive".to_string()],
            ..Settings::default()
        };
        catalog.save_settings(&ValidatedSettings::try_from(settings).unwrap()).unwrap();
        assert_eq!(
            catalog.settings().unwrap().excluded_folders,
            vec!["Archive"]
        );
        let tables = ["pins", "recent", "session"];
        for table in tables {
            let found: Option<String> = catalog.conn.query_row(
                "SELECT name FROM sqlite_master WHERE type='table' AND name=?1",
                [table],
                |row| row.get(0),
            ).optional().unwrap();
            assert!(found.is_none());
        }
    }

    fn open_catalog_with_note() -> (tempfile::TempDir, Catalog, String) {
        let dir = tempfile::tempdir().unwrap();
        let mut catalog = Catalog::open(&dir.path().join("vault.db")).unwrap();
        let note_id = catalog
            .insert_note(InsertNote {
                path: "A.md",
                path_key: "a.md",
                title: "A",
                tags: &["x".to_string()],
                content_hash: "sha256:a",
                visible_hash: "sha256:a-disk",
                kind: NoteEventKind::Create,
                source: NoteEventSource::User,
                unresolved: None,
            })
            .unwrap();
        (dir, catalog, note_id)
    }

    fn set_meta(catalog: &Catalog, key: &str, value: &str) {
        catalog
            .conn
            .execute("UPDATE vault_meta SET value=?2 WHERE key=?1", params![key, value])
            .unwrap();
    }

    #[test]
    fn previously_saved_out_of_range_settings_still_load() {
        let dir = tempfile::tempdir().unwrap();
        let catalog = Catalog::open(&dir.path().join("vault.db")).unwrap();
        catalog
            .conn
            .execute(
                "INSERT INTO settings(key, value) VALUES('settings', ?1)",
                params![r#"{"autosaveDelayMs":5,"undoStackMax":3,"imageWebpQuality":0.01,"excludedFolders":["a/b"]}"#],
            )
            .unwrap();
        let settings = catalog.settings().unwrap();
        assert_eq!(settings.autosave_delay_ms, 5);
        assert_eq!(settings.undo_stack_max, 3);
        assert_eq!(settings.excluded_folders, vec!["a/b"]);
    }

    #[test]
    fn malformed_settings_json_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let catalog = Catalog::open(&dir.path().join("vault.db")).unwrap();
        catalog
            .conn
            .execute("INSERT INTO settings(key, value) VALUES('settings', '{not json')", [])
            .unwrap();
        assert!(catalog.settings().is_err());
    }

    #[test]
    fn malformed_tags_json_is_an_error_on_every_note_read() {
        let (_dir, catalog, note_id) = open_catalog_with_note();
        catalog
            .conn
            .execute("UPDATE notes SET tags_json='[not json'", [])
            .unwrap();
        assert!(catalog.note_by_id(&note_id).is_err());
        assert!(catalog.note_by_path_key("a.md").is_err());
        assert!(catalog.live_notes().is_err());
        assert!(catalog.all_rows().is_err());
    }

    #[test]
    fn malformed_sync_version_is_an_error() {
        let (_dir, mut catalog, _) = open_catalog_with_note();
        for value in ["", "abc", "-1", "1.5"] {
            set_meta(&catalog, "sync_version", value);
            assert!(catalog.sync_version().is_err(), "{value:?}");
            assert!(catalog.save_settings(&ValidatedSettings::try_from(Settings::default()).unwrap()).is_err(), "{value:?}");
            let stored: String = catalog
                .conn
                .query_row("SELECT value FROM vault_meta WHERE key='sync_version'", [], |row| row.get(0))
                .unwrap();
            assert_eq!(stored, value);
        }
    }

    #[test]
    fn exhausted_sync_version_is_an_error() {
        let (_dir, mut catalog, _) = open_catalog_with_note();
        set_meta(&catalog, "sync_version", &i64::MAX.to_string());
        assert!(catalog.save_settings(&ValidatedSettings::try_from(Settings::default()).unwrap()).is_err());
    }

    #[test]
    fn malformed_search_flags_are_errors() {
        let (_dir, catalog, _) = open_catalog_with_note();
        for key in ["search_dirty", "search_degraded"] {
            for value in ["", "True", "1", "yes"] {
                set_meta(&catalog, key, value);
                assert!(catalog.search_status().is_err(), "{key}={value:?}");
            }
            set_meta(&catalog, key, "false");
        }
        let status = catalog.search_status().unwrap();
        assert!(!status.dirty && !status.degraded);
    }

    #[test]
    fn malformed_tombstone_flag_is_an_error() {
        let (_dir, catalog, note_id) = open_catalog_with_note();
        catalog
            .conn
            .execute("UPDATE notes SET tombstoned=2", [])
            .unwrap();
        assert!(catalog.note_by_id(&note_id).is_err());
    }

    #[test]
    fn unknown_note_event_kind_is_an_error() {
        let (_dir, catalog, note_id) = open_catalog_with_note();
        catalog
            .conn
            .execute("UPDATE note_events SET kind='bogus'", [])
            .unwrap();
        assert!(catalog.revisions(&note_id).is_err());
    }

    #[test]
    fn unknown_note_event_source_is_an_error() {
        let (_dir, catalog, note_id) = open_catalog_with_note();
        catalog
            .conn
            .execute("UPDATE note_events SET source='bogus'", [])
            .unwrap();
        assert!(catalog.revisions(&note_id).is_err());
    }
}
