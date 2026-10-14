use std::fs;
use std::collections::{HashMap, VecDeque};
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender, TryRecvError, TrySendError};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};
use std::thread;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::ErrorCode;
use serde::de::DeserializeOwned;

use crate::api_types::{
    ApiErrorKind, BootstrapResponse, CreateNoteRequest, NoteDocument, NoteEventKind,
    NoteEventSource, NoteMeta, NoteMutationResponse, RenameNoteRequest, RevisionDocument,
    RevisionMeta, SaveNoteDeltaRequest, SaveNoteRequest, SearchHit, SearchStatus, ServerEvent,
    ServerEventKind, SessionState, Settings, TextEdit, TextPosition, V2ApiErrorKind,
    V2CreateNoteRequest, V2DeleteNoteRequest, V2MutationOutcome,
    V2MutationResponse, V2NoteDocument, V2NoteMeta, V2NotePrecondition, V2QuickOpenHit,
    V2QuickOpenRequest, V2QuickOpenResponse, V2RenameNoteRequest, V2SearchHit,
    V2SearchHitIdentity, V2SearchMode, V2SearchOverlay, V2SearchRequest, V2SearchResponse,
    V2SourceRange, V2ExcerptRange, V2OverlayCoverage,
    V2RestoreConflictRequest, V2RestoreRevisionRequest, V2RevisionDocument, V2RevisionMeta,
    V2ConflictDraftDocument, V2SettingsRequest, V2SettingsResponse, V2ImageUploadResponse,
    V2SaveNoteDeltaRequest,
    V2SaveNoteRequest, V2ServerEvent, V2ServerEventUpdate, V2VaultBootstrapResponse,
    V2VaultMeta, VaultEntry, UnresolvedReason,
};
use crate::catalog::{Catalog, InsertNote, MutationIntent, MutationRecord, now_ms};
use crate::config::VaultConfig;
use crate::history;
use crate::logging::{LogHub, LogLevel, fields};
use crate::paths::{
    checked_visible_path, normalize_note_path, path_key, read_visible_bytes,
    read_vault_asset, remove_visible_note_file, write_vault_asset_new,
    sync_visible_note_parent, write_visible_note_bytes_atomic, write_visible_note_bytes_new,
};
use crate::reconcile::{reconcile_note_before_write, reconcile_vault};
use crate::search::{SearchIndex, dirty_note_snapshot};
use crate::tags::parse_markdown;
use crate::{Error, Result};
use tansu_search::{SearchMode, MAX_OVERLAY_BYTES, MAX_OVERLAY_NOTES};

const EVENT_REPLAY_LIMIT: usize = 512;
const EVENT_SUBSCRIBER_CAPACITY: usize = 64;
const SEARCH_QUEUE_CAPACITY: usize = 128;

fn v2_note_meta(meta: &NoteMeta, disk_hash: &str) -> Result<V2NoteMeta> {
    Ok(V2NoteMeta {
        note_id: meta.note_id.clone(),
        path: meta.path.clone(),
        title: meta.title.clone(),
        tags: meta.tags.clone(),
        revision: meta.seq,
        source_hash: meta.content_hash.clone(),
        disk_hash: disk_hash.to_string(),
        source_hash_format_version: history::source_hash_format_version(&meta.content_hash)?,
        disk_hash_format_version: history::disk_hash_format_version(disk_hash)?,
        updated_at_ms: meta.updated_at_ms,
    })
}

pub struct VaultRuntime {
    pub index: usize,
    pub name: String,
    pub vault_id: String,
    pub root: PathBuf,
    state_root: PathBuf,
    catalog: Mutex<Catalog>,
    search: Mutex<SearchIndex>,
    op_lock: Mutex<()>,
    subscribers: Mutex<Vec<Sender<ServerEvent>>>,
    v2_subscribers: Arc<Mutex<Vec<(u64, Weak<EventQueue<V2EventEnvelope>>)>>>,
    next_subscriber_id: AtomicU64,
    watcher: Mutex<Option<RecommendedWatcher>>,
    search_tx: SyncSender<SearchJob>,
    search_rx: Mutex<Option<Receiver<SearchJob>>>,
    search_needs_reconciliation: AtomicBool,
    logs: LogHub,
}

struct EventQueue<T> {
    values: Mutex<EventQueueValues<T>>,
    ready: Condvar,
}

struct EventQueueValues<T> {
    events: VecDeque<T>,
    closed: bool,
}

pub struct V2EventSubscription {
    queue: Arc<EventQueue<V2EventEnvelope>>,
    subscribers: Weak<Mutex<Vec<(u64, Weak<EventQueue<V2EventEnvelope>>)>>>,
    id: u64,
}

#[derive(Debug)]
pub enum V2VaultError {
    Api(V2ApiErrorKind),
    Internal(Error),
}

pub type V2Result<T> = std::result::Result<T, V2VaultError>;

impl From<Error> for V2VaultError {
    fn from(error: Error) -> Self {
        Self::Internal(error)
    }
}

impl From<serde_json::Error> for V2VaultError {
    fn from(error: serde_json::Error) -> Self {
        Self::Internal(Error::Json(error))
    }
}

impl std::fmt::Display for V2VaultError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Api(error) => write!(formatter, "{error:?}"),
            Self::Internal(error) => write!(formatter, "{error}"),
        }
    }
}

fn validate_mutation_id(mutation_id: &str) -> V2Result<()> {
    if mutation_id.is_empty() || mutation_id.len() > 128 {
        return Err(V2VaultError::Api(V2ApiErrorKind::BadRequest {
            message: "mutationId must contain 1 to 128 bytes".to_string(),
        }));
    }
    Ok(())
}

struct V2PayloadHashes {
    current: String,
    legacy: String,
}

impl V2PayloadHashes {
    fn matches(&self, hash: &str) -> bool {
        self.current == hash || self.legacy == hash
    }
}

fn v2_request_hash<T: serde::Serialize>(kind: &str, target: Option<&str>, request: &T) -> V2Result<V2PayloadHashes> {
    let bytes = serde_json::to_vec(&(kind, target, request))?;
    Ok(V2PayloadHashes {
        current: history::disk_hash(&bytes),
        legacy: history::legacy_disk_hash(&bytes),
    })
}

fn v2_request_hash_for_source<T: serde::Serialize>(
    kind: &str,
    target: Option<&str>,
    request: &T,
    content: &str,
) -> V2Result<V2PayloadHashes> {
    let bytes = serde_json::to_vec(&(kind, target, request))?;
    let current_source_hash = serde_json::to_string(&history::source_hash(content))?;
    let legacy_source_hash = serde_json::to_string(&history::legacy_source_hash_v2(content))?;
    let current_field = format!("\"sourceHash\":{current_source_hash}");
    let legacy_field = format!("\"sourceHash\":{legacy_source_hash}");
    let serialized = std::str::from_utf8(&bytes)
        .map_err(|_| Error::Internal("serialized mutation payload is not UTF-8".to_string()))?
        .to_string();
    let mut matches = serialized.match_indices(&current_field);
    let Some((start, _)) = matches.next() else {
        return Err(Error::Internal("mutation payload has no sourceHash field".to_string()).into());
    };
    if matches.next().is_some() {
        return Err(Error::Internal("mutation payload has duplicate sourceHash fields".to_string()).into());
    }
    let mut legacy_bytes = serialized;
    legacy_bytes.replace_range(start..start + current_field.len(), &legacy_field);
    Ok(V2PayloadHashes {
        current: history::disk_hash(&bytes),
        legacy: history::legacy_disk_hash(legacy_bytes.as_bytes()),
    })
}

fn v2_legacy_request_hash<T: serde::Serialize>(kind: &str, target: Option<&str>, request: &T) -> V2Result<String> {
    Ok(history::legacy_disk_hash(&serde_json::to_vec(&(kind, target, request))?))
}

fn v2_existing_result<T: DeserializeOwned>(
    catalog: &mut Catalog,
    mutation_id: &str,
    payload_hash: &V2PayloadHashes,
) -> V2Result<Option<T>> {
    let Some(record) = catalog.mutation(mutation_id)? else {
        return Ok(None);
    };
    if !payload_hash.matches(&record.payload_hash) {
        return Err(V2VaultError::Api(V2ApiErrorKind::MutationIdReuse {
            mutation_id: mutation_id.to_string(),
        }));
    }
    match record.state.as_str() {
        "prepared" => {
            catalog.clear_prepared_mutation(mutation_id)?;
            Ok(None)
        }
        "accepted" => {
            let result = record.result_json.ok_or_else(|| {
                Error::Internal(format!("mutation {mutation_id} has no result"))
            })?;
            Ok(Some(serde_json::from_str(&result)?))
        }
        _ => Err(Error::Internal(format!(
            "mutation {mutation_id} has unsupported state {}",
            record.state
        ))
        .into()),
    }
}

fn v2_existing_mutation(
    vault: &VaultRuntime,
    root: &Path,
    state_root: &Path,
    catalog: &mut Catalog,
    mutation_id: &str,
    payload_hash: &V2PayloadHashes,
) -> V2Result<Option<V2MutationResponse>> {
    let Some(mut record) = catalog.mutation(mutation_id)? else {
        return Ok(None);
    };
    if !payload_hash.matches(&record.payload_hash) {
        return Err(V2VaultError::Api(V2ApiErrorKind::MutationIdReuse {
            mutation_id: mutation_id.to_string(),
        }));
    }
    if record.state == "prepared" {
        catalog.clear_prepared_mutation(mutation_id)?;
        return Ok(None);
    }
    if record.state == "pending_materialization" {
        let note_id = record.note_id.as_deref().ok_or_else(|| {
            Error::Internal("pending mutation has no note ID".to_string())
        })?;
        let (version, update) = repair_pending_mutation(root, state_root, catalog, &record)?;
        vault.broadcast_v2_event(version, update.clone())?;
        if record.kind == "delete" {
            let revision = catalog
                .note_row_by_id(note_id)?
                .ok_or_else(|| Error::Internal("pending delete note is unavailable".to_string()))?
                .meta
                .seq;
            vault.enqueue_search_with_catalog(
                catalog,
                SearchJob::Remove(note_id.to_string(), revision),
            );
        } else {
            let meta = catalog
                .note_by_id(note_id)?
                .ok_or_else(|| Error::Internal("pending mutation note is unavailable".to_string()))?;
            let source_hash = record.source_hash.as_deref().ok_or_else(|| {
                Error::Internal("pending mutation has no source hash".to_string())
            })?;
            let content = history::read_snapshot(state_root, note_id, source_hash)?;
            vault.enqueue_search_with_catalog(catalog, SearchJob::Upsert(meta, content));
        }
        record = catalog
            .mutation(mutation_id)?
            .ok_or_else(|| Error::Internal(format!("repaired mutation {mutation_id} disappeared")))?;
    }
    let response = record
        .result_json
        .as_deref()
        .ok_or_else(|| Error::Internal(format!("mutation {mutation_id} has no result")))?;
    Ok(Some(serde_json::from_str(response)?))
}

fn v2_pending_response(mutation_id: &str) -> V2MutationResponse {
    V2MutationResponse {
        mutation_id: mutation_id.to_string(),
        outcome: V2MutationOutcome::PendingMaterialization {
            operation_id: mutation_id.to_string(),
        },
    }
}

fn validate_v2_search_limit(limit: u16) -> V2Result<()> {
    if limit == 0 || usize::from(limit) > tansu_search::SearchLimit::MAX {
        return Err(V2VaultError::Api(V2ApiErrorKind::BadRequest {
            message: format!("search limit must be between 1 and {}", tansu_search::SearchLimit::MAX),
        }));
    }
    Ok(())
}

fn v2_search_error(error: tansu_search::SearchError) -> V2VaultError {
    match error {
        tansu_search::SearchError::InvalidInput { .. }
        | tansu_search::SearchError::LimitOutOfRange { .. }
        | tansu_search::SearchError::QueryTooLong { .. }
        | tansu_search::SearchError::InvalidRange { .. }
        | tansu_search::SearchError::DuplicateOverlayNote => {
            V2VaultError::Api(V2ApiErrorKind::BadRequest {
                message: error.to_string(),
            })
        }
        error => V2VaultError::Internal(Error::Internal(error.to_string())),
    }
}

fn v2_accepted_response(
    mutation_id: &str,
    result: Option<V2NoteMeta>,
) -> V2MutationResponse {
    V2MutationResponse {
        mutation_id: mutation_id.to_string(),
        outcome: V2MutationOutcome::Accepted { result },
    }
}

fn v2_image_upload_response(mutation_id: &str, name: &str) -> V2ImageUploadResponse {
    V2ImageUploadResponse {
        mutation_id: mutation_id.to_string(),
        name: name.to_string(),
        markdown: format!("![[{name}]]"),
    }
}

fn v2_unresolved_reason(reason: Option<&str>) -> UnresolvedReason {
    match reason {
        Some("case_fold_collision") => UnresolvedReason::CaseFoldCollision,
        Some("invalid_utf8") => UnresolvedReason::InvalidUtf8,
        Some("missing_snapshot") => UnresolvedReason::MissingSnapshot,
        Some("corrupt_snapshot") => UnresolvedReason::CorruptSnapshot,
        _ => UnresolvedReason::FileCatalogMismatch,
    }
}

fn v2_document(meta: &NoteMeta, disk_hash: &str, content: String) -> Result<V2NoteDocument> {
    Ok(V2NoteDocument {
        meta: v2_note_meta(meta, disk_hash)?,
        content,
    })
}

fn v2_source(content: &str) -> V2Result<&str> {
    if content.contains('\r') {
        return Err(V2VaultError::Api(V2ApiErrorKind::BadRequest {
            message: "editor source must use LF line endings".to_string(),
        }));
    }
    Ok(content)
}

fn v2_check_precondition(row: &crate::catalog::NoteRow, precondition: &V2NotePrecondition) -> V2Result<()> {
    if row.meta.content_hash != precondition.base_source_hash {
        return Err(V2VaultError::Api(V2ApiErrorKind::SourceHashMismatch {
            expected: row.meta.content_hash.clone(),
            received: precondition.base_source_hash.clone(),
        }));
    }
    if row.visible_hash != precondition.base_disk_hash {
        return Err(V2VaultError::Api(V2ApiErrorKind::DiskHashMismatch {
            expected: row.visible_hash.clone(),
            received: precondition.base_disk_hash.clone(),
        }));
    }
    if row.meta.seq != precondition.base_revision {
        return Err(V2VaultError::Api(V2ApiErrorKind::BadRequest {
            message: "note revision changed".to_string(),
        }));
    }
    Ok(())
}

fn repair_pending_mutations(root: &Path, state_root: &Path, catalog: &mut Catalog) -> Result<()> {
    for mutation in catalog.pending_mutations()? {
        let _ = repair_pending_mutation(root, state_root, catalog, &mutation)?;
    }
    Ok(())
}

fn repair_pending_mutation(
    root: &Path,
    state_root: &Path,
    catalog: &mut Catalog,
    mutation: &MutationRecord,
) -> Result<(u64, V2ServerEventUpdate)> {
    let note_id = mutation
        .note_id
        .as_deref()
        .ok_or_else(|| Error::Internal("pending mutation has no note ID".to_string()))?;
    let candidate_bytes = match mutation.source_hash.as_deref() {
        Some(source_hash) => {
            let bytes = history::read_snapshot_bytes(state_root, note_id, source_hash)?;
            let expected_disk_hash = mutation
                .disk_hash
                .as_deref()
                .ok_or_else(|| Error::Internal("pending mutation has no disk hash".to_string()))?;
            if !history::disk_hash_matches(expected_disk_hash, &bytes) {
                return Err(Error::Internal(format!(
                    "pending mutation {} snapshot disk hash mismatch",
                    mutation.mutation_id
                )));
            }
            Some(bytes)
        }
        None if mutation.kind == "delete" => None,
        None => {
            return Err(Error::Internal(format!(
                "pending mutation {} has no source hash",
                mutation.mutation_id
            )));
        }
    };
    let mut disk_hash_update = None;
    match mutation.kind.as_str() {
        "create" => {
            let path = mutation.path.as_deref().ok_or_else(|| {
                Error::Internal("pending create has no destination path".to_string())
            })?;
            materialize_pending_file(
                root,
                path,
                candidate_bytes.as_deref().unwrap(),
                None,
            )?;
            disk_hash_update = mutation.disk_hash.as_deref();
        }
        "save" | "save_delta" | "restore_revision" | "restore_conflict" => {
            let path = mutation.path.as_deref().ok_or_else(|| {
                Error::Internal("pending content mutation has no path".to_string())
            })?;
            materialize_pending_file(
                root,
                path,
                candidate_bytes.as_deref().unwrap(),
                mutation.expected_disk_hash.as_deref(),
            )?;
            disk_hash_update = mutation.disk_hash.as_deref();
        }
        "rename" => {
            let path = mutation.path.as_deref().ok_or_else(|| {
                Error::Internal("pending rename has no destination path".to_string())
            })?;
            let old_path = mutation.old_path.as_deref().ok_or_else(|| {
                Error::Internal("pending rename has no source path".to_string())
            })?;
            move_pending_file(
                root,
                old_path,
                path,
                candidate_bytes.as_deref().unwrap(),
                mutation.disk_hash.as_deref().ok_or_else(|| {
                    Error::Internal("pending rename has no disk hash".to_string())
                })?,
            )?;
        }
        "delete" => {
            let path = mutation.old_path.as_deref().ok_or_else(|| {
                Error::Internal("pending delete has no source path".to_string())
            })?;
            let expected = mutation.expected_disk_hash.as_deref().ok_or_else(|| {
                Error::Internal("pending delete has no expected disk hash".to_string())
            })?;
            if let Some(bytes) = read_optional_visible_bytes(root, path)? {
                if !history::disk_hash_matches(expected, &bytes) {
                    return Err(Error::Internal(format!(
                        "pending delete {} found unexpected file bytes",
                        mutation.mutation_id
                    )));
                }
                remove_visible_note_file(root, path)?;
            }
            sync_visible_note_parent(root, path)?;
        }
        kind => {
            return Err(Error::Internal(format!(
                "cannot repair pending mutation kind {kind}"
            )));
        }
    }
    let response = if mutation.kind == "delete" {
        v2_accepted_response(&mutation.mutation_id, None)
    } else {
        let meta = catalog
            .note_by_id(note_id)?
            .ok_or_else(|| Error::Internal("pending mutation note is unavailable".to_string()))?;
        v2_accepted_response(
            &mutation.mutation_id,
            Some(v2_note_meta(
                &meta,
                mutation.disk_hash.as_deref().ok_or_else(|| {
                    Error::Internal("pending mutation has no disk hash".to_string())
                })?,
            )?),
        )
    };
    let update = if mutation.kind == "delete" {
        V2ServerEventUpdate::NoteDeleted {
            note_id: note_id.to_string(),
        }
    } else {
        V2ServerEventUpdate::NoteChanged {
            note: match &response.outcome {
                V2MutationOutcome::Accepted { result: Some(meta) } => meta.clone(),
                _ => return Err(Error::Internal("repaired mutation result is missing".to_string())),
            },
        }
    };
    let event_json = serde_json::to_string(&update)?;
    let result_json = serde_json::to_string(&response)?;
    let version = catalog.complete_mutation(
        &mutation.mutation_id,
        &result_json,
        Some(&event_json),
        EVENT_REPLAY_LIMIT,
        disk_hash_update.map(|hash| (note_id, hash)),
    )?
    .ok_or_else(|| Error::Internal("pending repair event was not recorded".to_string()))?;
    Ok((version, update))
}

fn materialize_pending_file(
    root: &Path,
    path: &str,
    candidate_bytes: &[u8],
    expected_before: Option<&str>,
) -> Result<()> {
    let expected = history::disk_hash(candidate_bytes);
    match read_optional_visible_bytes(root, path)? {
        Some(bytes) if history::disk_hash(&bytes) == expected => {
            sync_visible_note_parent(root, path)
        }
        Some(bytes) => {
            if expected_before.is_none_or(|hash| !history::disk_hash_matches(hash, &bytes)) {
                return Err(Error::Internal(format!(
                    "pending mutation found unexpected bytes at {path}"
                )));
            }
            write_visible_note_bytes_atomic(root, path, candidate_bytes)
        }
        None => {
            write_visible_note_bytes_new(root, path, candidate_bytes)
        }
    }
}

fn move_pending_file(
    root: &Path,
    old_path: &str,
    new_path: &str,
    candidate_bytes: &[u8],
    expected_hash: &str,
) -> Result<()> {
    let old_bytes = read_optional_visible_bytes(root, old_path)?;
    let new_bytes = read_optional_visible_bytes(root, new_path)?;
    if let Some(bytes) = &new_bytes {
        if !history::disk_hash_matches(expected_hash, bytes) {
            return Err(Error::Internal(format!(
                "pending rename found unexpected bytes at {new_path}"
            )));
        }
    }
    if let Some(bytes) = &old_bytes {
        if !history::disk_hash_matches(expected_hash, bytes) {
            return Err(Error::Internal(format!(
                "pending rename found unexpected bytes at {old_path}"
            )));
        }
    }
    if new_bytes.is_none() {
        write_visible_note_bytes_new(root, new_path, candidate_bytes)?;
    }
    if old_bytes.is_some() {
        remove_visible_note_file(root, old_path)?;
    }
    sync_visible_note_parent(root, new_path)?;
    sync_visible_note_parent(root, old_path)?;
    Ok(())
}

fn read_optional_visible_bytes(root: &Path, path: &str) -> Result<Option<Vec<u8>>> {
    let visible = checked_visible_path(root, path)?;
    match fs::symlink_metadata(&visible) {
        Ok(_) => read_visible_bytes(root, path).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(Error::Io(error)),
    }
}

impl<T> EventQueue<T> {
    fn new() -> Self {
        Self {
            values: Mutex::new(EventQueueValues {
                events: VecDeque::new(),
                closed: false,
            }),
            ready: Condvar::new(),
        }
    }

    fn push(&self, event: T, overflow: T) {
        let mut values = self.values.lock().expect("event queue mutex poisoned");
        if values.closed {
            return;
        }
        if values.events.len() >= EVENT_SUBSCRIBER_CAPACITY {
            values.events.clear();
            values.events.push_back(overflow);
            values.closed = true;
        } else {
            values.events.push_back(event);
        }
        self.ready.notify_one();
    }

    fn seed(&self, event: T) {
        let mut values = self.values.lock().expect("event queue mutex poisoned");
        values.events.push_back(event);
        self.ready.notify_one();
    }

    fn close(&self) {
        let mut values = self.values.lock().expect("event queue mutex poisoned");
        values.closed = true;
        self.ready.notify_all();
    }

    fn next_timeout(
        &self,
        timeout: Duration,
    ) -> std::result::Result<T, std::sync::mpsc::RecvTimeoutError> {
        let deadline = Instant::now() + timeout;
        let mut values = self.values.lock().expect("event queue mutex poisoned");
        loop {
            if let Some(event) = values.events.pop_front() {
                return Ok(event);
            }
            if values.closed {
                return Err(std::sync::mpsc::RecvTimeoutError::Disconnected);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(std::sync::mpsc::RecvTimeoutError::Timeout);
            }
            let (next, timeout) = self
                .ready
                .wait_timeout(values, remaining)
                .expect("event queue mutex poisoned");
            values = next;
            if timeout.timed_out() && values.events.is_empty() {
                return Err(std::sync::mpsc::RecvTimeoutError::Timeout);
            }
        }
    }
}

impl V2EventSubscription {
    pub fn recv_timeout(
        &self,
        timeout: Duration,
    ) -> std::result::Result<V2EventEnvelope, std::sync::mpsc::RecvTimeoutError> {
        self.queue.next_timeout(timeout)
    }

    pub fn capacity(&self) -> usize {
        EVENT_SUBSCRIBER_CAPACITY
    }
}

#[derive(Debug, Clone)]
pub struct V2EventEnvelope {
    pub event_version: u64,
    pub payload: serde_json::Value,
}

pub struct EventSubscription {
    pub replay: Vec<V2EventEnvelope>,
    pub current_version: u64,
    pub resync_required: bool,
    pub events: V2EventSubscription,
}

fn event_envelope(version: u64, update: V2ServerEventUpdate) -> Result<V2EventEnvelope> {
    let event = V2ServerEvent::new(version, update);
    Ok(V2EventEnvelope {
        event_version: version,
        payload: serde_json::to_value(event)?,
    })
}

impl Drop for V2EventSubscription {
    fn drop(&mut self) {
        if let Some(subscribers) = self.subscribers.upgrade() {
            subscribers
                .lock()
                .expect("event subscriber mutex poisoned")
                .retain(|(id, _)| *id != self.id);
        }
    }
}

enum SearchJob {
    Upsert(NoteMeta, String),
    Remove(String, i64),
    Rebuild,
}

enum SearchOverlayIdentityKind {
    Saved(String),
    New(String),
}

fn run_search_worker(runtime: Arc<VaultRuntime>, receiver: Receiver<SearchJob>) {
    loop {
        if runtime
            .search_needs_reconciliation
            .swap(false, Ordering::AcqRel)
            && !runtime.run_search_job(SearchJob::Rebuild)
        {
            thread::sleep(Duration::from_secs(1));
        }
        let mut job = match receiver.recv_timeout(Duration::from_secs(1)) {
            Ok(job) => job,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        };
        loop {
            runtime.run_search_job(job);
            match receiver.try_recv() {
                Ok(next) => job = next,
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return,
            }
        }
    }
}

impl VaultRuntime {
    pub fn open(index: usize, config: &VaultConfig, logs: LogHub) -> Result<Self> {
        fs::create_dir_all(&config.path)?;
        initialize_state_dir(&config.path, &config.state_path)?;
        let vault_id = config
            .state_path
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .ok_or_else(|| Error::BadRequest("vault state directory needs an opaque ID".to_string()))?
            .to_string();
        let mut catalog = Catalog::open(&config.state_path.join("vault.db"))?;
        let settings = catalog.settings()?;
        let excluded = if settings.excluded_folders.is_empty() {
            config.excluded_folders.clone()
        } else {
            settings.excluded_folders
        };
        catalog.clear_prepared_mutations()?;
        repair_pending_mutations(&config.path, &config.state_path, &mut catalog)?;
        reconcile_vault(&config.path, &config.state_path, &mut catalog, &excluded)?;
        let notes = catalog.live_notes()?;
        let mut search = SearchIndex::open(&config.state_path);
        if search.rebuild(&config.path, &notes).is_err() {
            search.mark_needs_reconciliation(true);
        }
        let search_status = search.search_status();
        catalog.set_search_dirty(search_status.dirty, search_status.degraded)?;
        let (search_tx, search_rx) = mpsc::sync_channel(SEARCH_QUEUE_CAPACITY);
        let search_needs_reconciliation = search.needs_reconciliation();
        if logs.enabled() {
            logs.server_event(
                LogLevel::Info,
                "system.event",
                None,
                fields([
                    (
                        "system",
                        serde_json::json!({ "component": "vault", "action": "open" }),
                    ),
                    ("vault", serde_json::json!(index)),
                    ("path", serde_json::json!(config.path.to_string_lossy())),
                    (
                        "statePath",
                        serde_json::json!(config.state_path.to_string_lossy()),
                    ),
                    ("notes", serde_json::json!(notes.len())),
                ]),
            );
        }
        Ok(Self {
            index,
            name: config.name.clone(),
            vault_id,
            root: config.path.clone(),
            state_root: config.state_path.clone(),
            catalog: Mutex::new(catalog),
            search: Mutex::new(search),
            op_lock: Mutex::new(()),
            subscribers: Mutex::new(Vec::new()),
            v2_subscribers: Arc::new(Mutex::new(Vec::new())),
            next_subscriber_id: AtomicU64::new(1),
            watcher: Mutex::new(None),
            search_tx,
            search_rx: Mutex::new(Some(search_rx)),
            search_needs_reconciliation: AtomicBool::new(search_needs_reconciliation),
            logs,
        })
    }

    pub fn start_search_worker(self: &Arc<Self>) {
        let Some(rx) = self
            .search_rx
            .lock()
            .expect("search receiver mutex poisoned")
            .take()
        else {
            return;
        };
        let runtime = Arc::clone(self);
        thread::spawn(move || {
            run_search_worker(runtime, rx);
        });
    }

    pub fn start_watcher(self: &Arc<Self>) -> Result<()> {
        let root = self.root.clone();
        let state_root = self.state_root.clone();
        let (tx, rx) = mpsc::channel::<()>();
        let mut watcher =
            notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                if let Ok(event) = result {
                    if event.paths.iter().any(|path| {
                        path.starts_with(&state_root)
                            || path.components().any(|part| part.as_os_str() == ".tansu")
                    }) {
                        return;
                    }
                    let _ = tx.send(());
                }
            })?;
        watcher.watch(&root, RecursiveMode::Recursive)?;
        *self.watcher.lock().expect("watcher mutex poisoned") = Some(watcher);
        let runtime = Arc::clone(self);
        thread::spawn(move || {
            while rx.recv().is_ok() {
                while rx.recv_timeout(Duration::from_millis(150)).is_ok() {}
                let _ = runtime.reconcile_from_watcher();
            }
        });
        Ok(())
    }

    pub fn subscribe(&self) -> Result<Receiver<ServerEvent>> {
        let (tx, rx) = mpsc::channel();
        tx.send(self.server_event(ServerEventKind::Ready, Vec::new())?)
            .map_err(|error| Error::Internal(error.to_string()))?;
        self.subscribers
            .lock()
            .expect("subscribers mutex poisoned")
            .push(tx);
        Ok(rx)
    }

    pub fn vault_meta(&self) -> V2VaultMeta {
        V2VaultMeta {
            vault_id: self.vault_id.clone(),
            name: self.name.clone(),
        }
    }

    pub fn v2_notes(&self) -> Result<Vec<V2NoteMeta>> {
        let _op = self.lock_op();
        let catalog = self.lock_catalog();
        catalog
            .live_notes()?
            .into_iter()
            .map(|note| {
                let row = catalog
                    .note_row_by_id(&note.note_id)?
                    .ok_or_else(|| Error::NotFound(note.note_id.clone()))?;
                v2_note_meta(&row.meta, &row.visible_hash)
            })
            .collect()
    }

    pub fn v2_vault_bootstrap(&self) -> Result<V2VaultBootstrapResponse> {
        let _op = self.lock_op();
        let catalog = self.lock_catalog();
        let notes = catalog
            .live_notes()?
            .into_iter()
            .map(|note| {
                let row = catalog
                    .note_row_by_id(&note.note_id)?
                    .ok_or_else(|| Error::NotFound(note.note_id.clone()))?;
                v2_note_meta(&row.meta, &row.visible_hash)
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(V2VaultBootstrapResponse {
            vault: self.vault_meta(),
            notes,
            settings: catalog.settings()?,
            search_status: catalog.search_status()?,
            legacy_workspace: catalog.legacy_workspace()?,
        })
    }

    pub fn v2_list_revisions(&self, note_id: &str) -> V2Result<Vec<V2RevisionMeta>> {
        let _op = self.lock_op();
        let catalog = self.lock_catalog();
        let row = catalog.note_row_by_id(note_id)?.ok_or_else(|| {
            V2VaultError::Api(V2ApiErrorKind::NoteNotFound {
                note_id: note_id.to_string(),
            })
        })?;
        if row.tombstoned {
            return Err(V2VaultError::Api(V2ApiErrorKind::NoteNotFound {
                note_id: note_id.to_string(),
            }));
        }
        Ok(catalog
            .revisions(note_id)?
            .into_iter()
            .map(|revision| V2RevisionMeta {
                revision: revision.event_id,
                note_id: revision.note_id,
                kind: revision.kind,
                source: revision.source,
                source_hash: revision.content_hash,
                created_at_ms: revision.created_at_ms,
            })
            .collect())
    }

    pub fn v2_open_revision(&self, note_id: &str, revision_id: i64) -> V2Result<V2RevisionDocument> {
        let _op = self.lock_op();
        let catalog = self.lock_catalog();
        let row = catalog.note_row_by_id(note_id)?.ok_or_else(|| {
            V2VaultError::Api(V2ApiErrorKind::NoteNotFound {
                note_id: note_id.to_string(),
            })
        })?;
        if row.tombstoned {
            return Err(V2VaultError::Api(V2ApiErrorKind::NoteNotFound {
                note_id: note_id.to_string(),
            }));
        }
        let revision = catalog
            .revision(note_id, revision_id)?
            .filter(|revision| revision.content_hash.is_some())
            .ok_or_else(|| {
                V2VaultError::Api(V2ApiErrorKind::RevisionNotFound {
                    note_id: note_id.to_string(),
                    revision: revision_id,
                })
            })?;
        let source_hash = revision.content_hash.as_deref().expect("revision hash was checked");
        let content = history::read_snapshot(&self.state_root, note_id, source_hash)?;
        Ok(V2RevisionDocument {
            revision: V2RevisionMeta {
                revision: revision.event_id,
                note_id: revision.note_id,
                kind: revision.kind,
                source: revision.source,
                source_hash: revision.content_hash,
                created_at_ms: revision.created_at_ms,
            },
            content,
        })
    }

    pub fn v2_open_conflict_draft(
        &self,
        note_id: &str,
        draft_id: i64,
    ) -> V2Result<V2ConflictDraftDocument> {
        let _op = self.lock_op();
        let catalog = self.lock_catalog();
        let draft = catalog.conflict_draft(note_id, draft_id)?.ok_or_else(|| {
            V2VaultError::Api(V2ApiErrorKind::ConflictDraftNotFound {
                note_id: note_id.to_string(),
                draft_id,
            })
        })?;
        let content = history::read_conflict_draft(
            &self.state_root,
            note_id,
            draft.draft_id,
            &draft.content_hash,
        )?;
        Ok(V2ConflictDraftDocument {
            draft: crate::api_types::V2ConflictDraftMeta {
                draft_id: draft.draft_id,
                note_id: draft.note_id,
                base_revision: draft.base_seq,
                base_source_hash: draft.base_hash,
                source_hash: draft.content_hash,
                created_at_ms: draft.created_at_ms,
            },
            content,
        })
    }

    pub fn v2_settings(&self) -> V2Result<Settings> {
        self.settings().map_err(V2VaultError::Internal)
    }

    pub fn v2_save_settings(&self, request: V2SettingsRequest) -> V2Result<V2SettingsResponse> {
        validate_mutation_id(&request.mutation_id)?;
        let payload_hash = v2_request_hash("settings", None, &request)?;
        let _op = self.lock_op();
        let mut catalog = self.lock_catalog();
        if let Some(response) =
            v2_existing_result::<V2SettingsResponse>(&mut catalog, &request.mutation_id, &payload_hash)?
        {
            return Ok(response);
        }
        catalog.prepare_mutation(MutationIntent {
            mutation_id: &request.mutation_id,
            payload_hash: &payload_hash.current,
            kind: "settings",
            note_id: None,
            path: None,
            old_path: None,
            expected_disk_hash: None,
            source_hash: None,
            disk_hash: None,
        })?;
        catalog.save_settings(&request.settings)?;
        let response = V2SettingsResponse {
            mutation_id: request.mutation_id.clone(),
            settings: request.settings,
        };
        catalog.complete_noop_mutation(
            &request.mutation_id,
            &serde_json::to_string(&response)?,
        )?;
        drop(catalog);
        self.enqueue_search(SearchJob::Rebuild);
        let status = self.search.lock().expect("search mutex poisoned").search_status();
        self.record_v2_event(V2ServerEventUpdate::SearchChanged {
            dirty: status.dirty,
            degraded: status.degraded,
        })?;
        self.broadcast(ServerEventKind::SearchChanged, Vec::new());
        Ok(response)
    }

    pub fn v2_upload_image(&self, mutation_id: &str, bytes: &[u8]) -> V2Result<V2ImageUploadResponse> {
        validate_mutation_id(mutation_id)?;
        if bytes.is_empty() {
            return Err(V2VaultError::Api(V2ApiErrorKind::BadRequest {
                message: "image body is empty".to_string(),
            }));
        }
        let body_hash = history::disk_hash(bytes);
        let mut payload_hash = v2_request_hash("image_upload", None, &body_hash)?;
        let legacy_body_hash = history::legacy_disk_hash(bytes);
        payload_hash.legacy = v2_legacy_request_hash("image_upload", None, &legacy_body_hash)?;
        let _op = self.lock_op();
        let mut catalog = self.lock_catalog();
        if let Some(record) = catalog.mutation(mutation_id)? {
            if !payload_hash.matches(&record.payload_hash) {
                return Err(V2VaultError::Api(V2ApiErrorKind::MutationIdReuse {
                    mutation_id: mutation_id.to_string(),
                }));
            }
            match record.state.as_str() {
                "accepted" => {
                    let result = record.result_json.ok_or_else(|| {
                        Error::Internal(format!("mutation {mutation_id} has no result"))
                    })?;
                    return Ok(serde_json::from_str(&result)?);
                }
                "prepared" => {
                    let name = record.path.as_deref().ok_or_else(|| {
                        Error::Internal(format!("image mutation {mutation_id} has no asset path"))
                    })?;
                    match self.read_asset(name) {
                        Ok(existing) if existing == bytes => {
                            let response = v2_image_upload_response(mutation_id, name);
                            catalog.complete_noop_mutation(
                                mutation_id,
                                &serde_json::to_string(&response)?,
                            )?;
                            return Ok(response);
                        }
                        Ok(_) => {
                            return Err(Error::Internal(format!(
                                "image mutation {mutation_id} asset contents changed"
                            ))
                            .into());
                        }
                        Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                            catalog.clear_prepared_mutation(mutation_id)?;
                        }
                        Err(error) => return Err(V2VaultError::Internal(error)),
                    }
                }
                _ => {
                    return Err(Error::Internal(format!(
                        "image mutation {mutation_id} has unsupported state {}",
                        record.state
                    ))
                    .into());
                }
            }
        }
        let digest = history::disk_hash(mutation_id.as_bytes());
        let digest_hex = digest.strip_prefix("blake3-v2:").ok_or_else(|| {
            Error::Internal("image name hash uses an unsupported format".to_string())
        })?;
        let name = format!("z-images/image-{digest_hex}.webp");
        catalog.prepare_mutation(MutationIntent {
            mutation_id,
            payload_hash: &payload_hash.current,
            kind: "image_upload",
            note_id: None,
            path: Some(&name),
            old_path: None,
            expected_disk_hash: None,
            source_hash: None,
            disk_hash: Some(&body_hash),
        })?;
        write_vault_asset_new(&self.root, &name, bytes)?;
        let response = v2_image_upload_response(mutation_id, &name);
        catalog.complete_noop_mutation(mutation_id, &serde_json::to_string(&response)?)?;
        drop(catalog);
        if self.logs.enabled() {
            self.logs.server_event(
                LogLevel::Info,
                "asset.upload",
                None,
                fields([(
                    "asset",
                    serde_json::json!({
                        "name": name,
                        "bytes": bytes.len(),
                        "vault": self.index,
                    }),
                )]),
            );
        }
        Ok(response)
    }

    pub fn v2_read_asset(&self, name: &str) -> V2Result<Vec<u8>> {
        self.read_asset(name).map_err(|error| match error {
            Error::Io(error) if error.kind() == std::io::ErrorKind::NotFound => {
                V2VaultError::Api(V2ApiErrorKind::AssetNotFound {
                    name: name.to_string(),
                })
            }
            Error::BadRequest(message) => V2VaultError::Api(V2ApiErrorKind::BadRequest { message }),
            error => V2VaultError::Internal(error),
        })
    }

    pub fn v2_open_note(&self, note_id: &str) -> V2Result<V2NoteDocument> {
        let _op = self.lock_op();
        let mut catalog = self.lock_catalog();
        if catalog.note_row_by_id(note_id)?.is_none() {
            return Err(V2VaultError::Api(V2ApiErrorKind::NoteNotFound {
                note_id: note_id.to_string(),
            }));
        }
        reconcile_note_before_write(&self.root, &self.state_root, &mut catalog, note_id)?;
        let row = catalog.note_row_by_id(note_id)?.ok_or_else(|| {
            V2VaultError::Api(V2ApiErrorKind::NoteNotFound {
                note_id: note_id.to_string(),
            })
        })?;
        if row.tombstoned {
            return Err(V2VaultError::Api(V2ApiErrorKind::NoteNotFound {
                note_id: note_id.to_string(),
            }));
        }
        if row.unresolved_reason.is_some() {
            return Err(V2VaultError::Api(V2ApiErrorKind::UnresolvedNote {
                note_id: note_id.to_string(),
                reason: v2_unresolved_reason(row.unresolved_reason.as_deref()),
            }));
        }
        let content = read_visible_or_snapshot(&self.root, &row.meta).map_err(|error| {
            match error {
                Error::Api(error) => match *error {
                    ApiErrorKind::UnresolvedNote { reason, .. } => {
                        V2VaultError::Api(V2ApiErrorKind::UnresolvedNote {
                            note_id: note_id.to_string(),
                            reason,
                        })
                    }
                    _ => V2VaultError::Internal(Error::Api(error)),
                },
                Error::NotFound(_) => V2VaultError::Api(V2ApiErrorKind::NoteNotFound {
                    note_id: note_id.to_string(),
                }),
                error => V2VaultError::Internal(error),
            }
        })?;
        catalog.touch_recent(note_id)?;
        Ok(v2_document(&row.meta, &row.visible_hash, content)?)
    }

    pub fn v2_save_note(
        &self,
        note_id: &str,
        request: V2SaveNoteRequest,
    ) -> V2Result<V2MutationResponse> {
        validate_mutation_id(&request.mutation_id)?;
        let content = v2_source(&request.content)?.to_string();
        let submitted_hash = history::source_hash(&content);
        if submitted_hash != request.source_hash {
            return Err(V2VaultError::Api(V2ApiErrorKind::SourceHashMismatch {
                expected: submitted_hash,
                received: request.source_hash,
            }));
        }
        let payload_hash = v2_request_hash_for_source("save", Some(note_id), &request, &content)?;
        self.v2_save_source(
            note_id,
            &request.mutation_id,
            &request.precondition,
            &content,
            &submitted_hash,
            &payload_hash,
            "save",
        )
    }

    pub fn v2_save_note_delta(
        &self,
        note_id: &str,
        request: V2SaveNoteDeltaRequest,
    ) -> V2Result<V2MutationResponse> {
        validate_mutation_id(&request.mutation_id)?;
        {
            let _op = self.lock_op();
            let catalog = self.lock_catalog();
            let row = catalog.note_row_by_id(note_id)?.ok_or_else(|| {
                V2VaultError::Api(V2ApiErrorKind::NoteNotFound {
                    note_id: note_id.to_string(),
                })
            })?;
            if row.tombstoned {
                return Err(V2VaultError::Api(V2ApiErrorKind::NoteNotFound {
                    note_id: note_id.to_string(),
                }));
            }
        }
        let base = history::read_snapshot(
            &self.state_root,
            note_id,
            &request.precondition.base_source_hash,
        )
        .map_err(|error| match error {
            Error::NotFound(_) => V2VaultError::Api(V2ApiErrorKind::BadRequest {
                message: "base snapshot not found".to_string(),
            }),
            error => V2VaultError::Internal(error),
        })?;
        let content = apply_text_edits(&base, &request.edits).map_err(|error| {
            V2VaultError::Api(V2ApiErrorKind::BadRequest {
                message: error.to_string(),
            })
        })?;
        let payload_hash = v2_request_hash_for_source("save_delta", Some(note_id), &request, &content)?;
        let submitted_hash = history::source_hash(&content);
        if submitted_hash != request.source_hash {
            return Err(V2VaultError::Api(V2ApiErrorKind::SourceHashMismatch {
                expected: submitted_hash,
                received: request.source_hash,
            }));
        }
        self.v2_save_source(
            note_id,
            &request.mutation_id,
            &request.precondition,
            &content,
            &submitted_hash,
            &payload_hash,
            "save_delta",
        )
    }

    pub fn v2_restore_revision(
        &self,
        note_id: &str,
        event_id: i64,
        request: V2RestoreRevisionRequest,
    ) -> V2Result<V2MutationResponse> {
        validate_mutation_id(&request.mutation_id)?;
        let payload_hash = v2_request_hash("restore_revision", Some(note_id), &(event_id, &request))?;
        let source_hash = {
            let _op = self.lock_op();
            let mut catalog = self.lock_catalog();
            if let Some(response) =
                v2_existing_mutation(self, &self.root, &self.state_root, &mut catalog, &request.mutation_id, &payload_hash)?
            {
                return Ok(response);
            }
            catalog
                .revision(note_id, event_id)?
                .and_then(|revision| revision.content_hash)
                .ok_or_else(|| {
                    V2VaultError::Api(V2ApiErrorKind::BadRequest {
                        message: "revision has no recoverable content".to_string(),
                    })
                })?
        };
        let content = history::read_snapshot(&self.state_root, note_id, &source_hash)?;
        let submitted_hash = history::source_hash(&content);
        self.v2_save_source(
            note_id,
            &request.mutation_id,
            &request.precondition,
            &content,
            &submitted_hash,
            &payload_hash,
            "restore_revision",
        )
    }

    pub fn v2_restore_conflict(
        &self,
        note_id: &str,
        draft_id: i64,
        request: V2RestoreConflictRequest,
    ) -> V2Result<V2MutationResponse> {
        validate_mutation_id(&request.mutation_id)?;
        let payload_hash = v2_request_hash("restore_conflict", Some(note_id), &(draft_id, &request))?;
        let draft = {
            let _op = self.lock_op();
            let mut catalog = self.lock_catalog();
            if let Some(response) =
                v2_existing_mutation(self, &self.root, &self.state_root, &mut catalog, &request.mutation_id, &payload_hash)?
            {
                return Ok(response);
            }
            catalog
                .conflict_draft(note_id, draft_id)?
                .ok_or_else(|| {
                    V2VaultError::Api(V2ApiErrorKind::BadRequest {
                        message: "conflict draft not found".to_string(),
                    })
                })?
        };
        let content = history::read_conflict_draft(
            &self.state_root,
            note_id,
            draft.draft_id,
            &draft.content_hash,
        )?;
        let submitted_hash = history::source_hash(&content);
        self.v2_save_source(
            note_id,
            &request.mutation_id,
            &request.precondition,
            &content,
            &submitted_hash,
            &payload_hash,
            "restore_conflict",
        )
    }

    fn v2_save_source(
        &self,
        note_id: &str,
        mutation_id: &str,
        precondition: &V2NotePrecondition,
        content: &str,
        submitted_hash: &str,
        payload_hash: &V2PayloadHashes,
        kind: &str,
    ) -> V2Result<V2MutationResponse> {
        let _op = self.lock_op();
        let mut catalog = self.lock_catalog();
        if let Some(response) = v2_existing_mutation(self, &self.root, &self.state_root, &mut catalog, mutation_id, payload_hash)? {
            return Ok(response);
        }
        reconcile_note_before_write(&self.root, &self.state_root, &mut catalog, note_id)?;
        let mut row = catalog.note_row_by_id(note_id)?.ok_or_else(|| {
            V2VaultError::Api(V2ApiErrorKind::NoteNotFound {
                note_id: note_id.to_string(),
            })
        })?;
        if row.tombstoned {
            return Err(V2VaultError::Api(V2ApiErrorKind::NoteNotFound {
                note_id: note_id.to_string(),
            }));
        }
        if let Some(reason) = row.unresolved_reason.as_deref() {
            return Err(V2VaultError::Api(V2ApiErrorKind::UnresolvedNote {
                note_id: note_id.to_string(),
                reason: v2_unresolved_reason(Some(reason)),
            }));
        }
        let mut current_bytes = read_visible_bytes(&self.root, &row.meta.path)?;
        let mut source_document = history::SourceDocument::from_disk(&current_bytes).map_err(|_| {
            V2VaultError::Api(V2ApiErrorKind::UnresolvedNote {
                note_id: note_id.to_string(),
                reason: UnresolvedReason::InvalidUtf8,
            })
        })?;
        let mut current_disk_hash = history::disk_hash(&current_bytes);
        if current_disk_hash != row.visible_hash {
            reconcile_note_before_write(&self.root, &self.state_root, &mut catalog, note_id)?;
            row = catalog.note_row_by_id(note_id)?.ok_or_else(|| {
                V2VaultError::Api(V2ApiErrorKind::NoteNotFound {
                    note_id: note_id.to_string(),
                })
            })?;
            if row.tombstoned {
                return Err(V2VaultError::Api(V2ApiErrorKind::NoteNotFound {
                    note_id: note_id.to_string(),
                }));
            }
            if let Some(reason) = row.unresolved_reason.as_deref() {
                return Err(V2VaultError::Api(V2ApiErrorKind::UnresolvedNote {
                    note_id: note_id.to_string(),
                    reason: v2_unresolved_reason(Some(reason)),
                }));
            }
            current_bytes = read_visible_bytes(&self.root, &row.meta.path)?;
            source_document = history::SourceDocument::from_disk(&current_bytes).map_err(|_| {
                V2VaultError::Api(V2ApiErrorKind::UnresolvedNote {
                    note_id: note_id.to_string(),
                    reason: UnresolvedReason::InvalidUtf8,
                })
            })?;
            current_disk_hash = history::disk_hash(&current_bytes);
        }
        let precondition_matches = row.meta.seq == precondition.base_revision
            && row.meta.content_hash == precondition.base_source_hash
            && row.visible_hash == precondition.base_disk_hash
            && current_disk_hash == row.visible_hash;
        let candidate_disk_bytes = source_document.disk_bytes_for_source(&content)?;
        let candidate_disk_hash = history::disk_hash(&candidate_disk_bytes);
        let current = row.meta.clone();
        catalog.prepare_mutation(MutationIntent {
            mutation_id,
            payload_hash: &payload_hash.current,
            kind,
            note_id: Some(note_id),
            path: Some(&current.path),
            old_path: None,
            expected_disk_hash: Some(&row.visible_hash),
            source_hash: Some(submitted_hash),
            disk_hash: Some(&candidate_disk_hash),
        })?;
        if !precondition_matches {
            return self.v2_record_conflict(
                &mut catalog,
                note_id,
                mutation_id,
                precondition.base_revision,
                &precondition.base_source_hash,
                content,
                &current,
                &row.visible_hash,
            );
        }
        if source_document.source == content {
            let response = v2_accepted_response(
                mutation_id,
                Some(v2_note_meta(&current, &row.visible_hash)?),
            );
            catalog.complete_noop_mutation(
                mutation_id,
                &serde_json::to_string(&response)?,
            )?;
            catalog.touch_recent(note_id)?;
            return Ok(response);
        }
        history::write_snapshot_bytes(
            &self.state_root,
            note_id,
            &submitted_hash,
            &candidate_disk_bytes,
        )?;
        let current_check = read_visible_bytes(&self.root, &current.path)?;
        if history::disk_hash(&current_check) != row.visible_hash {
            catalog.clear_prepared_mutation(mutation_id)?;
            reconcile_note_before_write(&self.root, &self.state_root, &mut catalog, note_id)?;
            let latest = catalog.note_row_by_id(note_id)?.ok_or_else(|| {
                V2VaultError::Api(V2ApiErrorKind::NoteNotFound {
                    note_id: note_id.to_string(),
                })
            })?;
            catalog.prepare_mutation(MutationIntent {
                mutation_id,
                payload_hash: &payload_hash.current,
                kind,
                note_id: Some(note_id),
                path: Some(&latest.meta.path),
                old_path: None,
                expected_disk_hash: Some(&latest.visible_hash),
                source_hash: Some(submitted_hash),
                disk_hash: Some(&candidate_disk_hash),
            })?;
            return self.v2_record_conflict(
                &mut catalog,
                note_id,
                mutation_id,
                precondition.base_revision,
                &precondition.base_source_hash,
                content,
                &latest.meta,
                &latest.visible_hash,
            );
        }
        let pending = v2_pending_response(mutation_id);
        let pending_json = serde_json::to_string(&pending)?;
        let parsed = parse_markdown(&current.path, &content);
        let accepted_meta = catalog.accept_note_content_mutation(
            mutation_id,
            note_id,
            &parsed.title,
            &parsed.tags,
            submitted_hash,
            &row.visible_hash,
            if kind == "restore_conflict" {
                NoteEventKind::ConflictRecovery
            } else {
                NoteEventKind::Save
            },
            NoteEventSource::User,
            &pending_json,
        )?;
        if history::disk_hash(&read_visible_bytes(&self.root, &current.path)?) != row.visible_hash {
            return Ok(pending);
        }
        if write_visible_note_bytes_atomic(&self.root, &current.path, &candidate_disk_bytes).is_err() {
            return Ok(pending);
        }
        let note_meta = v2_note_meta(&accepted_meta, &candidate_disk_hash)?;
        let response = v2_accepted_response(mutation_id, Some(note_meta.clone()));
        let update = V2ServerEventUpdate::NoteChanged { note: note_meta };
        let update_json = serde_json::to_string(&update)?;
        let result_json = serde_json::to_string(&response)?;
        let version = catalog.complete_mutation(
            mutation_id,
            &result_json,
            Some(&update_json),
            EVENT_REPLAY_LIMIT,
            Some((note_id, &candidate_disk_hash)),
        )?;
        drop(catalog);
        if let Some(version) = version {
            self.broadcast_v2_event(version, update)?;
        }
        self.enqueue_search(SearchJob::Upsert(accepted_meta.clone(), content.to_string()));
        self.broadcast(ServerEventKind::NoteChanged, Vec::new());
        self.log_note_mutation("save_v2", &accepted_meta, Some(content.len()));
        #[cfg(test)]
        crate::failure_point::check(crate::failure_point::FailurePoint::ResponseReady)?;
        Ok(response)
    }

    pub fn v2_create_note(
        &self,
        request: V2CreateNoteRequest,
    ) -> V2Result<V2MutationResponse> {
        validate_mutation_id(&request.mutation_id)?;
        let content = v2_source(&request.content)?.to_string();
        let source_hash = history::source_hash(&content);
        if source_hash != request.source_hash {
            return Err(V2VaultError::Api(V2ApiErrorKind::SourceHashMismatch {
                expected: source_hash,
                received: request.source_hash,
            }));
        }
        let path = normalize_note_path(&request.path).map_err(|reason| {
            V2VaultError::Api(V2ApiErrorKind::PathInvalid { reason })
        })?;
        let payload_hash = v2_request_hash_for_source("create", None, &request, &content)?;
        let _op = self.lock_op();
        let mut catalog = self.lock_catalog();
        if let Some(response) =
            v2_existing_mutation(self, &self.root, &self.state_root, &mut catalog, &request.mutation_id, &payload_hash)?
        {
            return Ok(response);
        }
        let key = path_key(&path);
        if catalog.note_by_path_key(&key)?.is_some() {
            return Err(V2VaultError::Api(V2ApiErrorKind::PathCollision { path }));
        }
        let visible = checked_visible_path(&self.root, &path)?;
        match fs::symlink_metadata(&visible) {
            Ok(_) => return Err(V2VaultError::Api(V2ApiErrorKind::PathCollision { path })),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(V2VaultError::Internal(Error::Io(error))),
        }
        let note_id = crate::catalog::generate_note_id();
        let disk_bytes = content.as_bytes();
        let disk_hash = history::disk_hash(disk_bytes);
        catalog.prepare_mutation(MutationIntent {
            mutation_id: &request.mutation_id,
            payload_hash: &payload_hash.current,
            kind: "create",
            note_id: Some(&note_id),
            path: Some(&path),
            old_path: None,
            expected_disk_hash: None,
            source_hash: Some(&source_hash),
            disk_hash: Some(&disk_hash),
        })?;
        history::write_snapshot_bytes(&self.state_root, &note_id, &source_hash, disk_bytes)?;
        if read_optional_visible_bytes(&self.root, &path)?.is_some() {
                catalog.clear_prepared_mutation(&request.mutation_id)?;
                return Err(V2VaultError::Api(V2ApiErrorKind::PathCollision { path }));
        }
        let parsed = parse_markdown(&path, &content);
        let pending = v2_pending_response(&request.mutation_id);
        let pending_json = serde_json::to_string(&pending)?;
        catalog
            .accept_new_note_mutation(
                &request.mutation_id,
                &note_id,
                InsertNote {
                    path: &path,
                    path_key: &key,
                    title: &parsed.title,
                    tags: &parsed.tags,
                    content_hash: &source_hash,
                    visible_hash: &disk_hash,
                    kind: NoteEventKind::Create,
                    source: NoteEventSource::User,
                    unresolved: None,
                },
                &pending_json,
            )
            .map_err(|error| match error {
                Error::Sql(error) if is_unique_violation(&error) => {
                    V2VaultError::Api(V2ApiErrorKind::PathCollision { path: path.clone() })
                }
                error => V2VaultError::Internal(error),
            })?;
        if write_visible_note_bytes_new(&self.root, &path, disk_bytes).is_err() {
            return Ok(pending);
        }
        let meta = catalog
            .note_by_id(&note_id)?
            .ok_or_else(|| Error::NotFound(note_id.clone()))?;
        let note_meta = v2_note_meta(&meta, &disk_hash)?;
        let response = v2_accepted_response(&request.mutation_id, Some(note_meta.clone()));
        let update = V2ServerEventUpdate::NoteChanged { note: note_meta };
        let version = catalog.complete_mutation(
            &request.mutation_id,
            &serde_json::to_string(&response)?,
            Some(&serde_json::to_string(&update)?),
            EVENT_REPLAY_LIMIT,
            Some((&note_id, &disk_hash)),
        )?;
        drop(catalog);
        if let Some(version) = version {
            self.broadcast_v2_event(version, update)?;
        }
        self.enqueue_search(SearchJob::Upsert(meta.clone(), content.clone()));
        self.broadcast(ServerEventKind::NoteChanged, Vec::new());
        self.log_note_mutation("create_v2", &meta, Some(content.len()));
        Ok(response)
    }

    pub fn v2_rename_note(
        &self,
        note_id: &str,
        request: V2RenameNoteRequest,
    ) -> V2Result<V2MutationResponse> {
        validate_mutation_id(&request.mutation_id)?;
        let path = normalize_note_path(&request.path)
            .map_err(|reason| V2VaultError::Api(V2ApiErrorKind::PathInvalid { reason }))?;
        let payload_hash = v2_request_hash("rename", Some(note_id), &request)?;
        let _op = self.lock_op();
        let mut catalog = self.lock_catalog();
        if let Some(response) =
            v2_existing_mutation(self, &self.root, &self.state_root, &mut catalog, &request.mutation_id, &payload_hash)?
        {
            return Ok(response);
        }
        reconcile_note_before_write(&self.root, &self.state_root, &mut catalog, note_id)?;
        let row = catalog.note_row_by_id(note_id)?.ok_or_else(|| {
            V2VaultError::Api(V2ApiErrorKind::NoteNotFound {
                note_id: note_id.to_string(),
            })
        })?;
        if row.tombstoned {
            return Err(V2VaultError::Api(V2ApiErrorKind::NoteNotFound {
                note_id: note_id.to_string(),
            }));
        }
        if let Some(reason) = row.unresolved_reason.as_deref() {
            return Err(V2VaultError::Api(V2ApiErrorKind::UnresolvedNote {
                note_id: note_id.to_string(),
                reason: v2_unresolved_reason(Some(reason)),
            }));
        }
        v2_check_precondition(&row, &request.precondition)?;
        if path == row.meta.path {
            let response = v2_accepted_response(
                &request.mutation_id,
                Some(v2_note_meta(&row.meta, &row.visible_hash)?),
            );
            catalog.prepare_mutation(MutationIntent {
                mutation_id: &request.mutation_id,
                payload_hash: &payload_hash.current,
                kind: "rename",
                note_id: Some(note_id),
                path: Some(&path),
                old_path: Some(&row.meta.path),
                expected_disk_hash: Some(&row.visible_hash),
                source_hash: Some(&row.meta.content_hash),
                disk_hash: Some(&row.visible_hash),
            })?;
            catalog.complete_noop_mutation(
                &request.mutation_id,
                &serde_json::to_string(&response)?,
            )?;
            return Ok(response);
        }
        let key = path_key(&path);
        if key == path_key(&row.meta.path) || catalog.note_by_path_key(&key)?.is_some() {
            return Err(V2VaultError::Api(V2ApiErrorKind::PathCollision { path }));
        }
        let destination = checked_visible_path(&self.root, &path)?;
        match fs::symlink_metadata(&destination) {
            Ok(_) => return Err(V2VaultError::Api(V2ApiErrorKind::PathCollision { path })),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(V2VaultError::Internal(Error::Io(error))),
        }
        let source_bytes = read_visible_bytes(&self.root, &row.meta.path)?;
        if history::disk_hash(&source_bytes) != row.visible_hash {
            reconcile_note_before_write(&self.root, &self.state_root, &mut catalog, note_id)?;
            return Err(V2VaultError::Api(V2ApiErrorKind::DiskHashMismatch {
                expected: catalog
                    .note_row_by_id(note_id)?
                    .map(|current| current.visible_hash)
                    .unwrap_or_default(),
                received: row.visible_hash,
            }));
        }
        let source_document = history::SourceDocument::from_disk(&source_bytes).map_err(|_| {
            V2VaultError::Api(V2ApiErrorKind::UnresolvedNote {
                note_id: note_id.to_string(),
                reason: UnresolvedReason::InvalidUtf8,
            })
        })?;
        let content_hash = history::source_hash(&source_document.source);
        history::write_snapshot_bytes(
            &self.state_root,
            note_id,
            &content_hash,
            &source_bytes,
        )?;
        let destination = checked_visible_path(&self.root, &path)?;
        match fs::symlink_metadata(&destination) {
            Ok(_) => return Err(V2VaultError::Api(V2ApiErrorKind::PathCollision { path })),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(V2VaultError::Internal(Error::Io(error))),
        }
        catalog.prepare_mutation(MutationIntent {
            mutation_id: &request.mutation_id,
            payload_hash: &payload_hash.current,
            kind: "rename",
            note_id: Some(note_id),
            path: Some(&path),
            old_path: Some(&row.meta.path),
            expected_disk_hash: Some(&row.visible_hash),
            source_hash: Some(&content_hash),
            disk_hash: Some(&row.visible_hash),
        })?;
        let current_check = read_visible_bytes(&self.root, &row.meta.path)?;
        if history::disk_hash(&current_check) != row.visible_hash {
            catalog.clear_prepared_mutation(&request.mutation_id)?;
            reconcile_note_before_write(&self.root, &self.state_root, &mut catalog, note_id)?;
            return Err(V2VaultError::Api(V2ApiErrorKind::DiskHashMismatch {
                expected: catalog
                    .note_row_by_id(note_id)?
                    .map(|current| current.visible_hash)
                    .unwrap_or_default(),
                received: row.visible_hash,
            }));
        }
        let parsed = parse_markdown(&path, &source_document.source);
        let pending = v2_pending_response(&request.mutation_id);
        let pending_json = serde_json::to_string(&pending)?;
        let accepted_meta = catalog
            .accept_rename_mutation(
                &request.mutation_id,
                note_id,
                &path,
                &key,
                &parsed.title,
                &pending_json,
            )
            .map_err(|error| match error {
                Error::Sql(error) if is_unique_violation(&error) => {
                    V2VaultError::Api(V2ApiErrorKind::PathCollision { path: path.clone() })
                }
                error => V2VaultError::Internal(error),
            })?;
        if history::disk_hash(&read_visible_bytes(&self.root, &row.meta.path)?) != row.visible_hash
            || read_optional_visible_bytes(&self.root, &path)?.is_some()
        {
            return Ok(pending);
        }
        if write_visible_note_bytes_new(&self.root, &path, &source_bytes).is_err()
            || remove_visible_note_file(&self.root, &row.meta.path).is_err()
        {
            return Ok(pending);
        }
        let note_meta = v2_note_meta(&accepted_meta, &row.visible_hash)?;
        let response = v2_accepted_response(&request.mutation_id, Some(note_meta.clone()));
        let update = V2ServerEventUpdate::NoteChanged { note: note_meta };
        let version = catalog.complete_mutation(
            &request.mutation_id,
            &serde_json::to_string(&response)?,
            Some(&serde_json::to_string(&update)?),
            EVENT_REPLAY_LIMIT,
            None,
        )?;
        drop(catalog);
        if let Some(version) = version {
            self.broadcast_v2_event(version, update)?;
        }
        self.enqueue_search(SearchJob::Upsert(accepted_meta.clone(), source_document.source));
        self.broadcast(ServerEventKind::NoteChanged, Vec::new());
        self.log_note_mutation("rename_v2", &accepted_meta, None);
        Ok(response)
    }

    pub fn v2_delete_note(
        &self,
        note_id: &str,
        request: V2DeleteNoteRequest,
    ) -> V2Result<V2MutationResponse> {
        validate_mutation_id(&request.mutation_id)?;
        let payload_hash = v2_request_hash("delete", Some(note_id), &request)?;
        let _op = self.lock_op();
        let mut catalog = self.lock_catalog();
        if let Some(response) =
            v2_existing_mutation(self, &self.root, &self.state_root, &mut catalog, &request.mutation_id, &payload_hash)?
        {
            return Ok(response);
        }
        reconcile_note_before_write(&self.root, &self.state_root, &mut catalog, note_id)?;
        let row = catalog.note_row_by_id(note_id)?.ok_or_else(|| {
            V2VaultError::Api(V2ApiErrorKind::NoteNotFound {
                note_id: note_id.to_string(),
            })
        })?;
        if row.tombstoned {
            return Err(V2VaultError::Api(V2ApiErrorKind::NoteNotFound {
                note_id: note_id.to_string(),
            }));
        }
        if let Some(reason) = row.unresolved_reason.as_deref() {
            return Err(V2VaultError::Api(V2ApiErrorKind::UnresolvedNote {
                note_id: note_id.to_string(),
                reason: v2_unresolved_reason(Some(reason)),
            }));
        }
        v2_check_precondition(&row, &request.precondition)?;
        let bytes = read_visible_bytes(&self.root, &row.meta.path)?;
        let source_document = history::SourceDocument::from_disk(&bytes).map_err(|_| {
            V2VaultError::Api(V2ApiErrorKind::UnresolvedNote {
                note_id: note_id.to_string(),
                reason: UnresolvedReason::InvalidUtf8,
            })
        })?;
        let disk_hash = history::disk_hash(&bytes);
        history::write_snapshot_bytes(
            &self.state_root,
            note_id,
            &history::source_hash(&source_document.source),
            &bytes,
        )?;
        catalog.prepare_mutation(MutationIntent {
            mutation_id: &request.mutation_id,
            payload_hash: &payload_hash.current,
            kind: "delete",
            note_id: Some(note_id),
            path: None,
            old_path: Some(&row.meta.path),
            expected_disk_hash: Some(&disk_hash),
            source_hash: Some(&row.meta.content_hash),
            disk_hash: Some(&disk_hash),
        })?;
        let check = read_visible_bytes(&self.root, &row.meta.path)?;
        if history::disk_hash(&check) != disk_hash {
            catalog.clear_prepared_mutation(&request.mutation_id)?;
            reconcile_note_before_write(&self.root, &self.state_root, &mut catalog, note_id)?;
            let current = catalog.note_row_by_id(note_id)?.ok_or_else(|| {
                V2VaultError::Api(V2ApiErrorKind::NoteNotFound {
                    note_id: note_id.to_string(),
                })
            })?;
            return Err(V2VaultError::Api(V2ApiErrorKind::DiskHashMismatch {
                expected: current.visible_hash,
                received: disk_hash,
            }));
        }
        let pending = v2_pending_response(&request.mutation_id);
        let tombstone = catalog.accept_delete_mutation(
            &request.mutation_id,
            note_id,
            &serde_json::to_string(&pending)?,
        )?;
        let check = read_visible_bytes(&self.root, &row.meta.path)?;
        if history::disk_hash(&check) != disk_hash
            || remove_visible_note_file(&self.root, &row.meta.path).is_err()
        {
            return Ok(pending);
        }
        let response = v2_accepted_response(&request.mutation_id, None);
        let update = V2ServerEventUpdate::NoteDeleted {
            note_id: note_id.to_string(),
        };
        let version = catalog.complete_mutation(
            &request.mutation_id,
            &serde_json::to_string(&response)?,
            Some(&serde_json::to_string(&update)?),
            EVENT_REPLAY_LIMIT,
            None,
        )?;
        drop(catalog);
        if let Some(version) = version {
            self.broadcast_v2_event(version, update)?;
        }
        self.enqueue_search(SearchJob::Remove(note_id.to_string(), tombstone.seq));
        self.broadcast(ServerEventKind::NoteChanged, vec![note_id.to_string()]);
        self.log_note_mutation("delete_v2", &row.meta, None);
        Ok(response)
    }

    fn v2_record_conflict(
        &self,
        catalog: &mut Catalog,
        note_id: &str,
        mutation_id: &str,
        base_revision: i64,
        base_source_hash: &str,
        content: &str,
        current_meta: &NoteMeta,
        current_disk_hash: &str,
    ) -> V2Result<V2MutationResponse> {
        let draft_id = catalog.next_conflict_draft_id()?;
        let draft_source_hash =
            history::write_conflict_draft(&self.state_root, note_id, draft_id, content)?;
        let created_at_ms = now_ms();
        let draft = crate::api_types::V2ConflictDraftMeta {
            draft_id,
            note_id: note_id.to_string(),
            base_revision,
            base_source_hash: base_source_hash.to_string(),
            source_hash: draft_source_hash.clone(),
            created_at_ms,
        };
        let current_content = read_visible_or_snapshot(&self.root, current_meta)?;
        let response = V2MutationResponse {
            mutation_id: mutation_id.to_string(),
            outcome: V2MutationOutcome::Conflict {
                current: Box::new(v2_document(
                    current_meta,
                    current_disk_hash,
                    current_content,
                )?),
                draft,
            },
        };
        catalog.record_conflict_mutation(
            mutation_id,
            &serde_json::to_string(&response)?,
            draft_id,
            note_id,
            base_revision,
            base_source_hash,
            &draft_source_hash,
            created_at_ms,
        )?;
        Ok(response)
    }

    pub fn subscribe_v2_events(&self, after: Option<u64>) -> Result<EventSubscription> {
        let _op = self.lock_op();
        let catalog = self.lock_catalog();
        let (current, oldest, events) =
            catalog.vault_event_window(after, EVENT_REPLAY_LIMIT)?;
        let queue = Arc::new(EventQueue::new());
        let too_old = match (after, oldest) {
            (None, Some(oldest)) => oldest > 1,
            (Some(after), Some(oldest)) => after < oldest.saturating_sub(1),
            _ => false,
        };
        let too_new = after.is_some_and(|after| after > current);
        let replay_too_large = current.saturating_sub(after.unwrap_or(0))
            > EVENT_SUBSCRIBER_CAPACITY as u64;
        let resync_required = too_old || too_new || replay_too_large;
        let replay = if resync_required {
                queue.seed(event_envelope(
                current,
                V2ServerEventUpdate::ResyncRequired,
                )?);
            queue.close();
            Vec::new()
        } else {
            let mut replay = Vec::with_capacity(events.len());
            for event in events {
                let update = serde_json::from_str(&event.payload_json)?;
                replay.push(event_envelope(event.event_version, update)?);
            }
            replay
        };
        drop(catalog);
        if queue
            .values
            .lock()
            .expect("event queue mutex poisoned")
            .closed
        {
            return Ok(EventSubscription {
                replay,
                current_version: current,
                resync_required,
                events: V2EventSubscription {
                    queue,
                    subscribers: Weak::new(),
                    id: 0,
                },
            });
        }
        let id = self.next_subscriber_id.fetch_add(1, Ordering::Relaxed);
        self.v2_subscribers
            .lock()
            .expect("event subscriber mutex poisoned")
            .push((id, Arc::downgrade(&queue)));
        Ok(EventSubscription {
            replay,
            current_version: current,
            resync_required,
            events: V2EventSubscription {
                queue,
                subscribers: Arc::downgrade(&self.v2_subscribers),
                id,
            },
        })
    }

    fn record_v2_event(&self, update: V2ServerEventUpdate) -> Result<V2EventEnvelope> {
        let payload_json = serde_json::to_string(&update)?;
        let version = self
            .lock_catalog()
            .append_vault_event(&payload_json, EVENT_REPLAY_LIMIT)?;
        self.broadcast_v2_event(version, update)
    }

    fn broadcast_v2_event(
        &self,
        version: u64,
        update: V2ServerEventUpdate,
    ) -> Result<V2EventEnvelope> {
        let event = event_envelope(version, update)?;
        let overflow = event_envelope(version, V2ServerEventUpdate::ResyncRequired)?;
        #[cfg(test)]
        crate::failure_point::check(crate::failure_point::FailurePoint::BeforeEventPublish)?;
        let mut subscribers = self
            .v2_subscribers
            .lock()
            .expect("event subscriber mutex poisoned");
        subscribers.retain(|(_, subscriber)| {
            let Some(queue) = subscriber.upgrade() else {
                return false;
            };
            queue.push(event.clone(), overflow.clone());
            !queue
                .values
                .lock()
                .expect("event queue mutex poisoned")
                .closed
        });
        drop(subscribers);
        #[cfg(test)]
        crate::failure_point::check(crate::failure_point::FailurePoint::AfterEventPublish)?;
        Ok(event)
    }

    pub fn bootstrap(
        &self,
        vaults: Vec<VaultEntry>,
        active_vault: usize,
    ) -> Result<BootstrapResponse> {
        let _op = self.lock_op();
        let catalog = self.lock_catalog();
        Ok(BootstrapResponse {
            api_version: crate::api::API_VERSION,
            vaults,
            active_vault,
            notes: catalog.live_notes()?,
            pinned_note_ids: catalog.pinned()?,
            recent_note_ids: catalog.recent()?,
            settings: catalog.settings()?,
            session: catalog.session()?,
            search_status: catalog.search_status()?,
        })
    }

    pub fn open_note(&self, note_id: &str) -> Result<NoteDocument> {
        let _op = self.lock_op();
        let mut catalog = self.lock_catalog();
        reconcile_note_before_write(&self.root, &self.state_root, &mut catalog, note_id)?;
        let meta = catalog
            .note_by_id(note_id)?
            .ok_or_else(|| Error::NotFound(note_id.to_string()))?;
        let content = match read_visible_or_snapshot(&self.root, &meta) {
            Ok(content) => content,
            Err(Error::Api(error)) => {
                if let ApiErrorKind::UnresolvedNote { reason, .. } = &*error {
                    catalog.mark_unresolved(note_id, reason.clone())?;
                }
                return Err(Error::Api(error));
            }
            Err(error) => return Err(error),
        };
        catalog.touch_recent(note_id)?;
        self.log_note_read("open", &meta, Some(content.len()));
        Ok(NoteDocument { meta, content })
    }

    pub fn create_note(&self, request: CreateNoteRequest) -> Result<NoteMutationResponse> {
        let _op = self.lock_op();
        let path = match normalize_note_path(&request.path) {
            Ok(path) => path,
            Err(reason) => {
                return Err(Error::api(ApiErrorKind::PathInvalid { reason }));
            }
        };
        let key = path_key(&path);
        let source = request.source.unwrap_or(NoteEventSource::User);
        let kind = match source {
            NoteEventSource::Import => NoteEventKind::Import,
            _ => NoteEventKind::Create,
        };
        let content = history::canonical_markdown_string(&request.content);
        let disk_bytes = content.as_bytes();
        let parsed = parse_markdown(&path, &content);
        let hash = history::content_hash(&content);
        let visible_hash = history::disk_hash(disk_bytes);
        let mut catalog = self.lock_catalog();
        let target = checked_visible_path(&self.root, &path)?;
        if catalog.note_by_path_key(&key)?.is_some() || target.exists() {
            return Err(Error::api(ApiErrorKind::PathCollision { path }));
        }
        let note_id = crate::catalog::generate_note_id();
        history::write_snapshot_bytes(&self.state_root, &note_id, &hash, disk_bytes)?;
        catalog.insert_note_with_id(&note_id, InsertNote {
            path: &path,
            path_key: &key,
            title: &parsed.title,
            tags: &parsed.tags,
            content_hash: &hash,
            visible_hash: &visible_hash,
            kind,
            source,
            unresolved: None,
        }).map_err(|error| match error {
            Error::Sql(error) if is_unique_violation(&error) => {
                Error::api(ApiErrorKind::PathCollision { path: path.clone() })
            }
            error => error,
        })?;
        write_visible_note_bytes_new(&self.root, &path, disk_bytes)?;
        let meta = catalog
            .note_by_id(&note_id)?
            .ok_or_else(|| Error::NotFound(note_id.clone()))?;
        catalog.touch_recent(&note_id)?;
        let sync_version = catalog.sync_version()?;
        drop(catalog);
        self.enqueue_search(SearchJob::Upsert(meta.clone(), content.clone()));
        self.broadcast(ServerEventKind::NoteChanged, Vec::new());
        self.log_note_mutation("create", &meta, Some(content.len()));
        Ok(NoteMutationResponse {
            document: Some(NoteDocument {
                meta: meta.clone(),
                content,
            }),
            meta,
            sync_version,
        })
    }

    pub fn save_note(
        &self,
        note_id: &str,
        request: SaveNoteRequest,
    ) -> Result<NoteMutationResponse> {
        let _op = self.lock_op();
        let content = history::canonical_markdown_string(&request.content);
        self.save_reconstructed_note(
            note_id,
            &content,
            request.base_seq,
            &request.base_hash,
            true,
        )
    }

    pub fn save_note_delta(
        &self,
        note_id: &str,
        request: SaveNoteDeltaRequest,
    ) -> Result<NoteMutationResponse> {
        let _op = self.lock_op();
        {
            let catalog = self.lock_catalog();
            let current_row = catalog
                .note_row_by_id(note_id)?
                .ok_or_else(|| Error::NotFound(note_id.to_string()))?;
            if current_row.tombstoned || current_row.unresolved_reason.is_some() {
                return Err(Error::NotFound(note_id.to_string()));
            }
        }
        let base = match history::read_snapshot(&self.state_root, note_id, &request.base_hash) {
            Ok(base) => base,
            Err(Error::NotFound(_)) => {
                return Err(Error::BadRequest("base snapshot not found".to_string()));
            }
            Err(error) => return Err(error),
        };
        let content = apply_text_edits(&base, &request.edits)?;
        let submitted_hash = history::content_hash(&content);
        if submitted_hash != request.content_hash {
            return Err(Error::BadRequest("delta content hash mismatch".to_string()));
        }
        self.save_reconstructed_note(
            note_id,
            &content,
            request.base_seq,
            &request.base_hash,
            false,
        )
    }

    fn save_reconstructed_note(
        &self,
        note_id: &str,
        content: &str,
        base_seq: i64,
        base_hash: &str,
        include_document: bool,
    ) -> Result<NoteMutationResponse> {
        let content = history::canonical_markdown_string(content);
        let submitted_hash = history::content_hash(&content);
        let mut catalog = self.lock_catalog();
        reconcile_note_before_write(&self.root, &self.state_root, &mut catalog, note_id)?;
        let current_row = catalog
            .note_row_by_id(note_id)?
            .ok_or_else(|| Error::NotFound(note_id.to_string()))?;
        if current_row.tombstoned || current_row.unresolved_reason.is_some() {
            return Err(Error::NotFound(note_id.to_string()));
        }
        let current = current_row.meta.clone();
        if current.content_hash == submitted_hash {
            catalog.touch_recent(note_id)?;
            let sync_version = catalog.sync_version()?;
            let document = if include_document {
                Some(NoteDocument {
                    meta: current.clone(),
                    content: read_visible_or_snapshot(&self.root, &current)?,
                })
            } else {
                None
            };
            return Ok(NoteMutationResponse {
                document,
                meta: current,
                sync_version,
            });
        }
        if current.seq != base_seq || current.content_hash != base_hash {
            let draft =
                catalog.create_conflict_draft(note_id, base_seq, base_hash, &submitted_hash)?;
            history::write_conflict_draft(&self.state_root, note_id, draft.draft_id, &content)?;
            let current_doc = NoteDocument {
                meta: current.clone(),
                content: read_visible_or_snapshot(&self.root, &current)?,
            };
            return Err(Error::api(ApiErrorKind::SaveConflict {
                current: Box::new(current_doc),
                draft,
            }));
        }
        let current_bytes = read_visible_bytes(&self.root, &current.path)?;
        let source_document = history::SourceDocument::from_disk(&current_bytes)?;
        let disk_bytes = source_document.disk_bytes_for_source(&content)?;
        let disk_hash = history::disk_hash(&disk_bytes);
        history::write_snapshot_bytes(&self.state_root, note_id, &submitted_hash, &disk_bytes)?;
        let parsed = parse_markdown(&current.path, &content);
        let meta = catalog.update_note_content(
            note_id,
            &parsed.title,
            &parsed.tags,
            &submitted_hash,
            &current_row.visible_hash,
            NoteEventKind::Save,
            NoteEventSource::User,
        )?;
        catalog.touch_recent(note_id)?;
        let sync_version = catalog.sync_version()?;
        if history::disk_hash(&read_visible_bytes(&self.root, &current.path)?)
            != current_row.visible_hash
        {
            reconcile_note_before_write(&self.root, &self.state_root, &mut catalog, note_id)?;
            return Err(Error::Internal(
                "visible file changed during save materialization".to_string(),
            ));
        }
        write_visible_note_bytes_atomic(&self.root, &current.path, &disk_bytes)?;
        catalog.record_visible_hash(note_id, &disk_hash)?;
        drop(catalog);
        self.enqueue_search(SearchJob::Upsert(meta.clone(), content.clone()));
        self.broadcast(ServerEventKind::NoteChanged, Vec::new());
        self.log_note_mutation("save", &meta, Some(content.len()));
        let document = if include_document {
            Some(NoteDocument {
                meta: meta.clone(),
                content,
            })
        } else {
            None
        };
        Ok(NoteMutationResponse {
            document,
            meta,
            sync_version,
        })
    }

    pub fn rename_note(
        &self,
        note_id: &str,
        request: RenameNoteRequest,
    ) -> Result<NoteMutationResponse> {
        let _op = self.lock_op();
        {
            let mut catalog = self.lock_catalog();
            reconcile_note_before_write(&self.root, &self.state_root, &mut catalog, note_id)?;
        }
        let path = match normalize_note_path(&request.path) {
            Ok(path) => path,
            Err(reason) => {
                return Err(Error::api(ApiErrorKind::PathInvalid { reason }));
            }
        };
        let key = path_key(&path);
        let mut catalog = self.lock_catalog();
        let current = catalog
            .note_by_id(note_id)?
            .ok_or_else(|| Error::NotFound(note_id.to_string()))?;
        if let Some(existing) = catalog.note_by_path_key(&key)?
            && existing.note_id != note_id
        {
            return Err(Error::api(ApiErrorKind::PathCollision { path }));
        }
        let new_visible = checked_visible_path(&self.root, &path)?;
        if new_visible.exists() {
            return Err(Error::api(ApiErrorKind::PathCollision { path }));
        }
        let meta = match catalog.rename_note(note_id, &path, &key) {
            Ok(meta) => meta,
            Err(Error::Sql(error)) if is_unique_violation(&error) => {
                return Err(Error::api(ApiErrorKind::PathCollision { path }));
            }
            Err(error) => return Err(error),
        };
        if let Some(bytes) = read_optional_visible_bytes(&self.root, &current.path)? {
            write_visible_note_bytes_new(&self.root, &path, &bytes)?;
            remove_visible_note_file(&self.root, &current.path)?;
        }
        let content = read_visible_or_snapshot(&self.root, &meta)?;
        let sync_version = catalog.sync_version()?;
        drop(catalog);
        self.enqueue_search(SearchJob::Upsert(meta.clone(), content.clone()));
        self.broadcast(ServerEventKind::NoteChanged, Vec::new());
        self.log_note_mutation("rename", &meta, Some(content.len()));
        Ok(NoteMutationResponse {
            document: Some(NoteDocument {
                meta: meta.clone(),
                content,
            }),
            meta,
            sync_version,
        })
    }

    pub fn delete_note(&self, note_id: &str) -> Result<NoteMutationResponse> {
        let _op = self.lock_op();
        let mut catalog = self.lock_catalog();
        reconcile_note_before_write(&self.root, &self.state_root, &mut catalog, note_id)?;
        let current = catalog
            .note_by_id(note_id)?
            .ok_or_else(|| Error::NotFound(note_id.to_string()))?;
        let meta = catalog.tombstone_note(note_id, NoteEventKind::Delete, NoteEventSource::User)?;
        if read_optional_visible_bytes(&self.root, &current.path)?.is_some() {
            remove_visible_note_file(&self.root, &current.path)?;
        }
        let sync_version = catalog.sync_version()?;
        drop(catalog);
        self.enqueue_search(SearchJob::Remove(note_id.to_string(), meta.seq));
        self.broadcast(ServerEventKind::NoteDeleted, vec![note_id.to_string()]);
        self.log_note_mutation("delete", &meta, None);
        Ok(NoteMutationResponse {
            document: None,
            meta,
            sync_version,
        })
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
        let _op = self.lock_op();
        let notes = {
            let catalog = self.lock_catalog();
            catalog.live_notes()?
        };
        let hits = {
            let mut search = self.search.lock().expect("search mutex poisoned");
            search.try_search(query, &notes, limit)
        };
        self.persist_search_status();
        let hits = hits?;
        if self.logs.enabled() {
            self.logs.server_event(
                LogLevel::Info,
                "search.query",
                None,
                fields([
                    (
                        "search",
                        serde_json::json!({
                            "queryLength": query.len(),
                            "hits": hits.len(),
                            "limit": limit,
                            "notes": notes.len(),
                        }),
                    ),
                    ("vault", serde_json::json!(self.index)),
                ]),
            );
        }
        Ok(hits)
    }

    pub fn v2_search(&self, request: V2SearchRequest) -> V2Result<V2SearchResponse> {
        let _op = self.lock_op();
        validate_v2_search_limit(request.limit)?;
        let notes = self.lock_catalog().live_notes()?;
        let mut snapshots = Vec::new();
        let mut overlay_kinds = HashMap::new();
        let mut search_ids = notes
            .iter()
            .map(|note| note.note_id.clone())
            .chain(request.overlays.iter().filter_map(|overlay| match overlay {
                V2SearchOverlay::Saved { note_id, .. } => Some(note_id.clone()),
                V2SearchOverlay::New { .. } => None,
            }))
            .collect::<std::collections::HashSet<_>>();
        let mut seen_overlay_ids = std::collections::HashSet::new();
        let mut source_bytes = 0usize;
        let mut skipped = 0usize;
        for (overlay_index, overlay) in request.overlays.iter().enumerate() {
            let (is_new_draft, overlay_id) = match overlay {
                V2SearchOverlay::Saved { note_id, .. } => (false, note_id),
                V2SearchOverlay::New { local_id, .. } => (true, local_id),
            };
            if overlay_id.is_empty()
                || !seen_overlay_ids.insert((is_new_draft, overlay_id.clone()))
            {
                return Err(V2VaultError::Api(V2ApiErrorKind::BadRequest {
                    message: "search overlays must have unique nonempty identities".to_string(),
                }));
            }
            let (note_id, local_revision, title, path, source, kind, revision, source_hash) =
                match overlay {
                    V2SearchOverlay::Saved {
                        note_id,
                        base_revision,
                        base_source_hash,
                        local_revision,
                        title,
                        path,
                        content,
                    } => (
                        note_id.clone(),
                        *local_revision,
                        title,
                        path,
                        content,
                        SearchOverlayIdentityKind::Saved(note_id.clone()),
                        *base_revision,
                        base_source_hash.clone(),
                    ),
                    V2SearchOverlay::New {
                        local_id,
                        local_revision,
                        title,
                        path,
                        content,
                    } => {
                        let source_hash = history::source_hash(content);
                        let mut search_note_id = format!("tansu-local-overlay-{overlay_index}");
                        while !search_ids.insert(search_note_id.clone()) {
                            search_note_id.push('_');
                        }
                        (
                            search_note_id,
                            *local_revision,
                            title,
                            path,
                            content,
                            SearchOverlayIdentityKind::New(local_id.clone()),
                            0,
                            source_hash,
                        )
                    }
                };
            if source.contains('\r') {
                return Err(V2VaultError::Api(V2ApiErrorKind::BadRequest {
                    message: "overlay source must use LF line endings".to_string(),
                }));
            }
            if snapshots.len() == MAX_OVERLAY_NOTES
                || source_bytes.saturating_add(source.len()) > MAX_OVERLAY_BYTES
            {
                skipped = request.overlays.len() - snapshots.len();
                break;
            }
            source_bytes += source.len();
            let snapshot = dirty_note_snapshot(
                note_id.clone(),
                path.clone(),
                title.clone(),
                revision,
                source_hash,
                local_revision,
                source.clone(),
            )
            .map_err(v2_search_error)?;
            overlay_kinds.insert(note_id.clone(), kind);
            snapshots.push(snapshot);
        }
        let mode = match request.mode {
            V2SearchMode::Default => SearchMode::ExactPrefix,
            V2SearchMode::TypoOnly => SearchMode::TypoOnly,
        };
        let results = {
            let mut search = self.search.lock().expect("search mutex poisoned");
            search.try_search_with_overlay(
                &request.query,
                &notes,
                usize::from(request.limit),
                mode,
                &snapshots,
            )
        };
        self.persist_search_status();
        let results = results.map_err(v2_search_error)?;
        let hits = results
            .hits
            .into_iter()
            .map(|result| -> V2Result<V2SearchHit> {
                let identity = if let Some(local_revision) = result.local_revision {
                    match overlay_kinds.get(&result.note_id) {
                        Some(SearchOverlayIdentityKind::Saved(note_id)) => {
                            V2SearchHitIdentity::SavedOverlay {
                                note_id: note_id.clone(),
                                local_revision,
                                source_hash: result.source_hash.clone(),
                            }
                        }
                        Some(SearchOverlayIdentityKind::New(local_id)) => {
                            V2SearchHitIdentity::NewLocalDraft {
                                local_id: local_id.clone(),
                                local_revision,
                                source_hash: result.source_hash.clone(),
                            }
                        }
                        None => {
                            return Err(V2VaultError::Internal(Error::Internal(
                                "search overlay result has no request identity".to_string(),
                            )));
                        }
                    }
                } else {
                    V2SearchHitIdentity::Canonical {
                        note_id: result.note_id.clone(),
                        revision: result.revision,
                        source_hash: result.source_hash.clone(),
                    }
                };
                Ok(V2SearchHit {
                    identity,
                    title: result.title,
                    path: result.path,
                    score: result.score,
                    excerpt: result.excerpt,
                    excerpt_ranges: result
                        .excerpt_ranges
                        .into_iter()
                        .map(|range| V2ExcerptRange {
                            start_utf16: range.start(),
                            end_utf16: range.end(),
                        })
                        .collect(),
                    source_range: result.source_reveal_range.map(|range| V2SourceRange {
                        start_utf16: range.start(),
                        end_utf16: range.end(),
                    }),
                })
            })
            .collect::<V2Result<Vec<_>>>()?;
        let skipped = if skipped == 0 {
            results.skipped_notes
        } else {
            skipped
        };
        let overlay_coverage = if skipped == 0 {
            V2OverlayCoverage::Complete
        } else {
            V2OverlayCoverage::Partial {
                skipped_note_count: u16::try_from(skipped).map_err(|_| {
                    V2VaultError::Api(V2ApiErrorKind::BadRequest {
                        message: "search request contains too many overlays".to_string(),
                    })
                })?,
            }
        };
        Ok(V2SearchResponse { hits, overlay_coverage })
    }

    pub fn v2_quick_open(
        &self,
        request: V2QuickOpenRequest,
    ) -> V2Result<V2QuickOpenResponse> {
        let _op = self.lock_op();
        validate_v2_search_limit(request.limit)?;
        let notes = self.lock_catalog().live_notes()?;
        let result = {
            let mut search = self.search.lock().expect("search mutex poisoned");
            search.quick_open(
                &request.query,
                &notes,
                &request.pinned_note_ids,
                &request.recent_note_ids,
                usize::from(request.limit),
            )
        };
        self.persist_search_status();
        let response = result.map_err(v2_search_error)?;
        let hits = response
            .hits
            .into_iter()
            .map(|hit| V2QuickOpenHit {
                note_id: hit.identity.note_id().to_owned(),
                source_hash: hit.identity.source_hash().to_owned(),
                title: hit.identity.title().to_owned(),
                path: hit.identity.path().to_owned(),
                score: f32::from(hit.score),
            })
            .collect();
        Ok(V2QuickOpenResponse { hits })
    }

    pub fn save_session(&self, session: SessionState) -> Result<()> {
        let _op = self.lock_op();
        self.lock_catalog().save_session(&session)?;
        if self.logs.enabled() {
            self.logs.server_event(
                LogLevel::Debug,
                "session.save",
                None,
                fields([
                    (
                        "session",
                        serde_json::json!({
                            "openTabs": session.open_tabs.len(),
                            "closedTabs": session.closed_tabs.len(),
                            "activeNoteId": session.active_note_id,
                        }),
                    ),
                    ("vault", serde_json::json!(self.index)),
                ]),
            );
        }
        Ok(())
    }

    pub fn settings(&self) -> Result<Settings> {
        let _op = self.lock_op();
        self.lock_catalog().settings()
    }

    pub fn save_settings(&self, settings: Settings) -> Result<Settings> {
        let _op = self.lock_op();
        let mut catalog = self.lock_catalog();
        catalog.save_settings(&settings)?;
        drop(catalog);
        self.enqueue_search(SearchJob::Rebuild);
        self.broadcast(ServerEventKind::SearchChanged, Vec::new());
        if self.logs.enabled() {
            self.logs.server_event(
                LogLevel::Info,
                "settings.save",
                None,
                fields([
                    (
                        "settings",
                        serde_json::json!({
                            "excludedFolders": settings.excluded_folders.len(),
                            "autosaveDelayMs": settings.autosave_delay_ms,
                            "undoStackMax": settings.undo_stack_max,
                            "imageWebpQuality": settings.image_webp_quality,
                        }),
                    ),
                    ("vault", serde_json::json!(self.index)),
                ]),
            );
        }
        Ok(settings)
    }

    pub fn set_pin(&self, note_id: &str, pinned: bool) -> Result<()> {
        let _op = self.lock_op();
        let mut catalog = self.lock_catalog();
        if catalog.note_by_id(note_id)?.is_none() {
            return Err(Error::NotFound(note_id.to_string()));
        }
        catalog.set_pin(note_id, pinned)?;
        let meta = catalog
            .note_by_id(note_id)?
            .ok_or_else(|| Error::NotFound(note_id.to_string()))?;
        drop(catalog);
        self.broadcast(ServerEventKind::VaultChanged, Vec::new());
        if self.logs.enabled() {
            self.logs.server_event(
                LogLevel::Info,
                "note.pin",
                None,
                fields([
                    (
                        "note",
                        serde_json::json!({
                            "id": meta.note_id,
                            "path": meta.path,
                            "vault": self.index,
                        }),
                    ),
                    ("pin", serde_json::json!({ "pinned": pinned })),
                ]),
            );
        }
        Ok(())
    }

    pub fn search_status(&self) -> Result<SearchStatus> {
        let _op = self.lock_op();
        self.lock_catalog().search_status()
    }

    pub fn revisions(&self, note_id: &str) -> Result<Vec<RevisionMeta>> {
        let _op = self.lock_op();
        if self.lock_catalog().note_row_by_id(note_id)?.is_none() {
            return Err(Error::NotFound(note_id.to_string()));
        }
        self.lock_catalog().revisions(note_id)
    }

    pub fn revision_document(&self, note_id: &str, event_id: i64) -> Result<RevisionDocument> {
        let _op = self.lock_op();
        let catalog = self.lock_catalog();
        let revision = catalog
            .revision(note_id, event_id)?
            .ok_or_else(|| Error::NotFound(format!("revision {event_id}")))?;
        let hash = revision
            .content_hash
            .as_deref()
            .ok_or_else(|| Error::NotFound(format!("revision {event_id}")))?;
        let content = history::read_snapshot(&self.state_root, note_id, hash)?;
        if self.logs.enabled() {
            self.logs.server_event(
                LogLevel::Info,
                "revision.open",
                None,
                fields([
                    (
                        "revision",
                        serde_json::json!({
                            "eventId": event_id,
                            "noteId": note_id,
                            "contentHash": hash,
                            "bytes": content.len(),
                        }),
                    ),
                    ("vault", serde_json::json!(self.index)),
                ]),
            );
        }
        Ok(RevisionDocument { revision, content })
    }

    pub fn restore_revision(&self, note_id: &str, event_id: i64) -> Result<NoteMutationResponse> {
        let _op = self.lock_op();
        let mut catalog = self.lock_catalog();
        reconcile_note_before_write(&self.root, &self.state_root, &mut catalog, note_id)?;
        let current = catalog
            .note_by_id(note_id)?
            .ok_or_else(|| Error::NotFound(note_id.to_string()))?;
        let current_row = catalog
            .note_row_by_id(note_id)?
            .ok_or_else(|| Error::NotFound(note_id.to_string()))?;
        let revision = catalog
            .revision(note_id, event_id)?
            .ok_or_else(|| Error::NotFound(format!("revision {event_id}")))?;
        let hash = revision
            .content_hash
            .as_deref()
            .ok_or_else(|| Error::NotFound(format!("revision {event_id}")))?;
        let content = history::read_snapshot(&self.state_root, note_id, hash)?;
        let old_disk_bytes = read_visible_bytes(&self.root, &current.path)?;
        let current_source = history::SourceDocument::from_disk(&old_disk_bytes)?;
        let disk_bytes = current_source.disk_bytes_for_source(&content)?;
        let disk_hash = history::disk_hash(&disk_bytes);
        let source_hash = history::content_hash(&content);
        history::write_snapshot_bytes(&self.state_root, note_id, &source_hash, &disk_bytes)?;
        let parsed = parse_markdown(&current.path, &content);
        let meta = catalog.update_note_content(
            note_id,
            &parsed.title,
            &parsed.tags,
            &source_hash,
            &current_row.visible_hash,
            NoteEventKind::Save,
            NoteEventSource::User,
        )?;
        catalog.touch_recent(note_id)?;
        let sync_version = catalog.sync_version()?;
        write_visible_note_bytes_atomic(&self.root, &current.path, &disk_bytes)?;
        catalog.record_visible_hash(note_id, &disk_hash)?;
        drop(catalog);
        self.enqueue_search(SearchJob::Upsert(meta.clone(), content.clone()));
        self.broadcast(ServerEventKind::NoteChanged, Vec::new());
        self.log_note_mutation("restore", &meta, Some(content.len()));
        Ok(NoteMutationResponse {
            document: Some(NoteDocument {
                meta: meta.clone(),
                content,
            }),
            meta,
            sync_version,
        })
    }

    pub fn conflict_draft(
        &self,
        note_id: &str,
        draft_id: i64,
    ) -> Result<crate::api_types::ConflictDraftDocument> {
        let _op = self.lock_op();
        let catalog = self.lock_catalog();
        let draft = catalog
            .conflict_draft(note_id, draft_id)?
            .ok_or_else(|| Error::NotFound(format!("conflict draft {draft_id}")))?;
        let content = history::read_conflict_draft(
            &self.state_root,
            note_id,
            draft.draft_id,
            &draft.content_hash,
        )?;
        Ok(crate::api_types::ConflictDraftDocument { draft, content })
    }

    pub fn restore_conflict_draft(
        &self,
        note_id: &str,
        draft_id: i64,
    ) -> Result<NoteMutationResponse> {
        let _op = self.lock_op();
        let mut catalog = self.lock_catalog();
        reconcile_note_before_write(&self.root, &self.state_root, &mut catalog, note_id)?;
        let current = catalog
            .note_by_id(note_id)?
            .ok_or_else(|| Error::NotFound(note_id.to_string()))?;
        let current_row = catalog
            .note_row_by_id(note_id)?
            .ok_or_else(|| Error::NotFound(note_id.to_string()))?;
        let draft = catalog
            .conflict_draft(note_id, draft_id)?
            .ok_or_else(|| Error::NotFound(format!("conflict draft {draft_id}")))?;
        let content = history::read_conflict_draft(
            &self.state_root,
            note_id,
            draft.draft_id,
            &draft.content_hash,
        )?;
        let old_disk_bytes = read_visible_bytes(&self.root, &current.path)?;
        let current_source = history::SourceDocument::from_disk(&old_disk_bytes)?;
        let disk_bytes = current_source.disk_bytes_for_source(&content)?;
        let disk_hash = history::disk_hash(&disk_bytes);
        let source_hash = history::content_hash(&content);
        history::write_snapshot_bytes(&self.state_root, note_id, &source_hash, &disk_bytes)?;
        let parsed = parse_markdown(&current.path, &content);
        let meta = catalog.update_note_content(
            note_id,
            &parsed.title,
            &parsed.tags,
            &source_hash,
            &current_row.visible_hash,
            NoteEventKind::ConflictRecovery,
            NoteEventSource::User,
        )?;
        catalog.touch_recent(note_id)?;
        let sync_version = catalog.sync_version()?;
        write_visible_note_bytes_atomic(&self.root, &current.path, &disk_bytes)?;
        catalog.record_visible_hash(note_id, &disk_hash)?;
        drop(catalog);
        self.enqueue_search(SearchJob::Upsert(meta.clone(), content.clone()));
        self.broadcast(ServerEventKind::NoteChanged, Vec::new());
        self.log_note_mutation("restore_conflict", &meta, Some(content.len()));
        Ok(NoteMutationResponse {
            document: Some(NoteDocument {
                meta: meta.clone(),
                content,
            }),
            meta,
            sync_version,
        })
    }

    pub fn upload_image(&self, bytes: &[u8]) -> Result<crate::api_types::ImageUploadResponse> {
        if bytes.is_empty() {
            return Err(Error::BadRequest("image body is empty".to_string()));
        }
        let name = format!(
            "z-images/image-{}-{}.webp",
            now_ms(),
            crate::catalog::generate_note_id()
        );
        write_vault_asset_new(&self.root, &name, bytes)?;
        if self.logs.enabled() {
            self.logs.server_event(
                LogLevel::Info,
                "asset.upload",
                None,
                fields([(
                    "asset",
                    serde_json::json!({
                        "name": name,
                        "bytes": bytes.len(),
                        "vault": self.index,
                    }),
                )]),
            );
        }
        Ok(crate::api_types::ImageUploadResponse {
            markdown: format!("![[{name}]]"),
            name,
        })
    }

    pub fn read_asset(&self, name: &str) -> Result<Vec<u8>> {
        let path = normalize_asset_path(name)?;
        read_vault_asset(&self.root, &path.to_string_lossy())
    }

    fn enqueue_search(&self, job: SearchJob) {
        let mut catalog = self.lock_catalog();
        self.enqueue_search_with_catalog(&mut catalog, job);
    }

    fn enqueue_search_with_catalog(&self, catalog: &mut Catalog, job: SearchJob) {
        let degraded = self
            .search
            .lock()
            .expect("search mutex poisoned")
            .search_status()
            .degraded;
        if let Err(error) = catalog.set_search_dirty(true, degraded) {
            self.log_search_failure("persist queued search status", &error.to_string());
        }
        match self.search_tx.try_send(job) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                self.search_needs_reconciliation
                    .store(true, Ordering::Release);
                if let Err(error) = catalog.set_search_dirty(true, true) {
                    self.log_search_failure("persist search queue overflow", &error.to_string());
                }
                self.log_search_failure("search queue overflow", "scheduled canonical rebuild");
            }
            Err(TrySendError::Disconnected(_)) => {
                self.search_needs_reconciliation
                    .store(true, Ordering::Release);
                if let Err(error) = catalog.set_search_dirty(true, true) {
                    self.log_search_failure("persist stopped search worker", &error.to_string());
                }
                self.log_search_failure("search worker stopped", "scheduled canonical rebuild");
            }
        }
    }

    fn run_search_job(&self, job: SearchJob) -> bool {
        let result = match job {
            SearchJob::Upsert(meta, content) => {
                self.search
                    .lock()
                    .expect("search mutex poisoned")
                    .try_index_note(meta, &content)
            }
            SearchJob::Remove(note_id, revision) => {
                self.search
                    .lock()
                    .expect("search mutex poisoned")
                    .try_remove_note(&note_id, revision)
            }
            SearchJob::Rebuild => {
                let notes = match self.catalog.lock() {
                    Ok(catalog) => catalog.live_notes(),
                    Err(_) => Err(Error::Internal("catalog mutex poisoned".to_string())),
                };
                match notes {
                    Ok(notes) => self
                        .search
                        .lock()
                        .expect("search mutex poisoned")
                        .rebuild(&self.root, &notes),
                    Err(error) => Err(error),
                }
            }
        };
        let mut search = self.search.lock().expect("search mutex poisoned");
        if let Err(error) = &result {
            search.mark_needs_reconciliation(true);
            self.search_needs_reconciliation
                .store(true, Ordering::Release);
            self.log_search_failure("update search index", &error.to_string());
        }
        let status = search.search_status();
        if search.needs_reconciliation() {
            self.search_needs_reconciliation
                .store(true, Ordering::Release);
        }
        drop(search);
        if let Ok(mut catalog) = self.catalog.lock() {
            if let Err(error) = catalog.set_search_dirty(status.dirty, status.degraded) {
                self.log_search_failure("persist search status", &error.to_string());
            }
        }
        result.is_ok()
    }

    fn persist_search_status(&self) {
        let (status, needs_reconciliation) = {
            let search = self.search.lock().expect("search mutex poisoned");
            (search.search_status(), search.needs_reconciliation())
        };
        if needs_reconciliation {
            self.search_needs_reconciliation
                .store(true, Ordering::Release);
        }
        match self.catalog.lock() {
            Ok(mut catalog) => {
                if let Err(error) = catalog.set_search_dirty(status.dirty, status.degraded) {
                    self.log_search_failure("persist search status", &error.to_string());
                }
            }
            Err(_) => self.log_search_failure("persist search status", "catalog mutex poisoned"),
        }
    }

    fn log_search_failure(&self, action: &str, detail: &str) {
        if self.logs.enabled() {
            self.logs.server_event(
                LogLevel::Warn,
                "system.event",
                None,
                fields([
                    (
                        "system",
                        serde_json::json!({
                            "component": "vault",
                            "action": "search_failure",
                            "operation": action,
                            "detail": detail,
                        }),
                    ),
                    ("vault", serde_json::json!(self.index)),
                ]),
            );
        }
    }

    fn reconcile_from_watcher(&self) -> Result<()> {
        let _op = self.lock_op();
        let mut catalog = self.lock_catalog();
        let before = catalog
            .all_rows()?
            .into_iter()
            .filter(|row| !row.tombstoned && row.unresolved_reason.is_none())
            .map(|row| (row.meta.note_id.clone(), (row.meta, row.visible_hash)))
            .collect::<HashMap<_, _>>();
        let settings = catalog.settings()?;
        reconcile_vault(
            &self.root,
            &self.state_root,
            &mut catalog,
            &settings.excluded_folders,
        )?;
        let notes = catalog.live_notes()?;
        let after = catalog
            .all_rows()?
            .into_iter()
            .filter(|row| !row.tombstoned && row.unresolved_reason.is_none())
            .map(|row| (row.meta.note_id.clone(), (row.meta, row.visible_hash)))
            .collect::<HashMap<_, _>>();
        let mut deleted = before
            .keys()
            .filter(|note_id| !after.contains_key(*note_id))
            .cloned()
            .collect::<Vec<_>>();
        let mut changed_v2_notes = Vec::new();
        for (note_id, (meta, visible_hash)) in &after {
            let unchanged = before.get(note_id).is_some_and(|(previous_meta, previous_hash)| {
                previous_meta == meta && previous_hash == visible_hash
            });
            if !unchanged {
                changed_v2_notes.push(v2_note_meta(meta, visible_hash)?);
            }
        }
        deleted.sort();
        changed_v2_notes.sort_by(|left, right| left.path.cmp(&right.path));
        let changed = !deleted.is_empty() || !changed_v2_notes.is_empty();
        drop(catalog);
        self.enqueue_search(SearchJob::Rebuild);
        if changed {
            for note_id in &deleted {
                self.record_v2_event(V2ServerEventUpdate::NoteDeleted {
                    note_id: note_id.clone(),
                })?;
            }
            for note in changed_v2_notes {
                self.record_v2_event(V2ServerEventUpdate::VaultChanged { notes: vec![note] })?;
            }
        }
        self.broadcast(ServerEventKind::VaultChanged, deleted);
        if self.logs.enabled() {
            self.logs.server_event(
                LogLevel::Info,
                "system.event",
                None,
                fields([
                    (
                        "system",
                        serde_json::json!({ "component": "watcher", "action": "reconcile" }),
                    ),
                    ("vault", serde_json::json!(self.index)),
                    ("notes", serde_json::json!(notes.len())),
                ]),
            );
        }
        Ok(())
    }

    fn log_note_mutation(&self, action: &str, meta: &NoteMeta, content_bytes: Option<usize>) {
        if !self.logs.enabled() {
            return;
        }
        self.logs.server_event(
            LogLevel::Info,
            "note.mutation",
            None,
            fields([
                (
                    "note",
                    serde_json::json!({
                        "id": meta.note_id,
                        "path": meta.path,
                        "vault": self.index,
                        "contentHash": meta.content_hash,
                        "seq": meta.seq,
                    }),
                ),
                ("mutation", serde_json::json!({ "action": action })),
                ("contentBytes", serde_json::json!(content_bytes)),
            ]),
        );
    }

    fn log_note_read(&self, action: &str, meta: &NoteMeta, content_bytes: Option<usize>) {
        if !self.logs.enabled() {
            return;
        }
        self.logs.server_event(
            LogLevel::Info,
            "note.read",
            None,
            fields([
                (
                    "note",
                    serde_json::json!({
                        "id": meta.note_id,
                        "path": meta.path,
                        "vault": self.index,
                        "contentHash": meta.content_hash,
                        "seq": meta.seq,
                    }),
                ),
                ("read", serde_json::json!({ "action": action })),
                ("contentBytes", serde_json::json!(content_bytes)),
            ]),
        );
    }

    fn server_event(
        &self,
        kind: ServerEventKind,
        deleted_note_ids: Vec<String>,
    ) -> Result<ServerEvent> {
        let catalog = self.lock_catalog();
        Ok(ServerEvent {
            kind,
            vault: self.index,
            notes: catalog.live_notes()?,
            deleted_note_ids,
            search_status: catalog.search_status()?,
        })
    }

    fn broadcast(&self, kind: ServerEventKind, deleted_note_ids: Vec<String>) {
        let Ok(event) = self.server_event(kind, deleted_note_ids) else {
            return;
        };
        let mut subscribers = self.subscribers.lock().expect("subscribers mutex poisoned");
        subscribers.retain(|tx| tx.send(event.clone()).is_ok());
    }

    fn lock_op(&self) -> MutexGuard<'_, ()> {
        self.op_lock.lock().expect("vault operation mutex poisoned")
    }

    fn lock_catalog(&self) -> MutexGuard<'_, Catalog> {
        self.catalog.lock().expect("catalog mutex poisoned")
    }
}

fn read_visible_or_snapshot(
    root: &std::path::Path,
    meta: &NoteMeta,
) -> Result<String> {
    match read_visible_bytes(root, &meta.path) {
        Ok(bytes) => match history::SourceDocument::from_disk(&bytes) {
            Ok(document) => Ok(document.source),
            Err(_) => Err(Error::api(ApiErrorKind::UnresolvedNote {
                note_id: meta.note_id.clone(),
                reason: crate::api_types::UnresolvedReason::InvalidUtf8,
            })),
        },
        Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            Err(Error::NotFound(meta.note_id.clone()))
        }
        Err(error) => Err(error),
    }
}

fn apply_text_edits(base: &str, edits: &[TextEdit]) -> Result<String> {
    let base = normalize_markdown_lf(base);
    let mut ranges = Vec::with_capacity(edits.len());
    let mut previous_start: Option<&TextPosition> = None;
    let mut previous_end: Option<&TextPosition> = None;
    for edit in edits {
        if edit.text.contains('\r') {
            return Err(Error::BadRequest("delta edit text contains CR".to_string()));
        }
        if compare_position(&edit.start, &edit.end).is_gt() {
            return Err(Error::BadRequest(
                "delta edit range is reversed".to_string(),
            ));
        }
        if let Some(previous_start) = previous_start
            && (compare_position(&edit.start, previous_start).is_eq()
                || compare_position(&edit.start, previous_end.expect("previous end")).is_lt())
            {
                return Err(Error::BadRequest(
                    "delta edits must be sorted and non-overlapping".to_string(),
                ));
            }
        let start = text_position_to_byte_offset(&base, &edit.start)?;
        let end = text_position_to_byte_offset(&base, &edit.end)?;
        if start > end {
            return Err(Error::BadRequest(
                "delta edit range is reversed".to_string(),
            ));
        }
        ranges.push((start, end, edit.text.as_str()));
        previous_start = Some(&edit.start);
        previous_end = Some(&edit.end);
    }

    let mut content = base;
    for (start, end, text) in ranges.into_iter().rev() {
        content.replace_range(start..end, text);
    }
    Ok(content)
}

fn normalize_markdown_lf(content: &str) -> String {
    content.replace("\r\n", "\n").replace('\r', "\n")
}

fn compare_position(left: &TextPosition, right: &TextPosition) -> std::cmp::Ordering {
    left.line
        .cmp(&right.line)
        .then_with(|| left.character.cmp(&right.character))
}

fn text_position_to_byte_offset(content: &str, position: &TextPosition) -> Result<usize> {
    let mut line_start = 0;
    for (line, segment) in content.split('\n').enumerate() {
        if line == position.line {
            return utf16_character_to_byte_offset(segment, position.character)
                .map(|column| line_start + column);
        }
        line_start += segment.len() + 1;
    }
    Err(Error::BadRequest(
        "delta edit position is outside the base document".to_string(),
    ))
}

fn utf16_character_to_byte_offset(line: &str, character: usize) -> Result<usize> {
    let mut utf16_offset = 0;
    for (byte_offset, ch) in line.char_indices() {
        if utf16_offset == character {
            return Ok(byte_offset);
        }
        utf16_offset += ch.len_utf16();
        if utf16_offset > character {
            return Err(Error::BadRequest(
                "delta edit position splits a UTF-16 surrogate pair".to_string(),
            ));
        }
    }
    if utf16_offset == character {
        Ok(line.len())
    } else {
        Err(Error::BadRequest(
            "delta edit position is outside the base document".to_string(),
        ))
    }
}

fn initialize_state_dir(root: &Path, state_root: &Path) -> Result<()> {
    let legacy = root.join(".tansu");
    let should_copy_legacy = legacy.join("vault.db").exists()
        && !state_root.join("vault.db").exists()
        && (!state_root.exists() || state_dir_is_empty(state_root)?);
    if should_copy_legacy {
        copy_dir_recursive(&legacy, state_root)?;
    } else {
        fs::create_dir_all(state_root)?;
    }
    Ok(())
}

fn state_dir_is_empty(path: &Path) -> Result<bool> {
    match fs::read_dir(path) {
        Ok(mut entries) => Ok(entries.next().is_none()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(Error::Io(error)),
    }
}

fn copy_dir_recursive(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let source = entry.path();
        let target = to.join(entry.file_name());
        if source.is_dir() {
            copy_dir_recursive(&source, &target)?;
        } else {
            fs::copy(&source, &target)?;
        }
    }
    Ok(())
}

fn normalize_asset_path(path: &str) -> Result<PathBuf> {
    let raw = Path::new(path);
    if raw.is_absolute() {
        return Err(Error::BadRequest("asset path must be relative".to_string()));
    }
    let mut normalized = PathBuf::new();
    for component in raw.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            _ => return Err(Error::BadRequest("invalid asset path".to_string())),
        }
    }
    if normalized
        .components()
        .any(|part| part.as_os_str() == ".tansu")
    {
        return Err(Error::BadRequest("invalid asset path".to_string()));
    }
    Ok(normalized)
}

fn is_unique_violation(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(inner, _)
            if inner.code == ErrorCode::ConstraintViolation
                || inner.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE
    )
}

#[cfg(test)]
mod tests {
    use crate::api_types::{
        PathValidationReason, SaveNoteDeltaRequest, SaveNoteRequest, TextEdit, TextPosition,
        V2CreateNoteRequest, V2DeleteNoteRequest, V2MutationOutcome, V2NotePrecondition,
        V2RenameNoteRequest, V2RestoreConflictRequest,
        V2RestoreRevisionRequest, V2SaveNoteRequest,
    };
    use crate::paths::visible_path;

    use super::*;

    #[test]
    fn v2_boundary_helpers_validate_and_translate_errors() {
        assert!(validate_mutation_id("x").is_ok());
        assert!(validate_mutation_id(&"x".repeat(128)).is_ok());
        assert!(validate_mutation_id("").is_err());
        assert!(validate_mutation_id(&"x".repeat(129)).is_err());
        assert!(v2_source("# Note\n").is_ok());
        assert!(matches!(
            v2_source("# Note\r\n"),
            Err(V2VaultError::Api(V2ApiErrorKind::BadRequest { .. }))
        ));
        assert!(validate_v2_search_limit(1).is_ok());
        assert!(validate_v2_search_limit(tansu_search::SearchLimit::MAX as u16).is_ok());
        assert!(validate_v2_search_limit(0).is_err());
        assert!(validate_v2_search_limit((tansu_search::SearchLimit::MAX + 1) as u16).is_err());

        assert!(matches!(
            v2_search_error(tansu_search::SearchError::InvalidInput { field: "query" }),
            V2VaultError::Api(V2ApiErrorKind::BadRequest { .. })
        ));
        assert!(matches!(
            v2_search_error(tansu_search::SearchError::Io(std::io::Error::other("index"))),
            V2VaultError::Internal(Error::Internal(_))
        ));
        assert_eq!(v2_unresolved_reason(Some("case_fold_collision")), UnresolvedReason::CaseFoldCollision);
        assert_eq!(v2_unresolved_reason(Some("invalid_utf8")), UnresolvedReason::InvalidUtf8);
        assert_eq!(v2_unresolved_reason(Some("missing_snapshot")), UnresolvedReason::MissingSnapshot);
        assert_eq!(v2_unresolved_reason(Some("corrupt_snapshot")), UnresolvedReason::CorruptSnapshot);
        assert_eq!(v2_unresolved_reason(None), UnresolvedReason::FileCatalogMismatch);

        let api_error = V2ApiErrorKind::NotImplemented;
        assert_eq!(V2VaultError::Api(api_error.clone()).to_string(), format!("{api_error:?}"));
        assert!(matches!(
            V2VaultError::from(Error::BadRequest("invalid".to_string())),
            V2VaultError::Internal(Error::BadRequest(_))
        ));
        let json_error = serde_json::from_slice::<serde_json::Value>(b"{").unwrap_err();
        assert!(matches!(
            V2VaultError::from(json_error),
            V2VaultError::Internal(Error::Json(_))
        ));
    }

    #[test]
    fn settings_mutations_replay_only_for_the_original_payload() {
        let vault = test_vault();
        let request = V2SettingsRequest {
            mutation_id: "settings-once".to_string(),
            settings: Settings::default(),
        };
        let accepted = vault.v2_save_settings(request.clone()).unwrap();
        let replay = vault.v2_save_settings(request.clone()).unwrap();
        assert_eq!(
            serde_json::to_value(accepted).unwrap(),
            serde_json::to_value(replay).unwrap()
        );

        let mut changed = request;
        changed.settings.autosave_delay_ms += 1;
        assert!(matches!(
            vault.v2_save_settings(changed),
            Err(V2VaultError::Api(V2ApiErrorKind::MutationIdReuse { .. }))
        ));
    }

    #[test]
    fn preconditions_reject_stale_source_disk_and_revision_values() {
        let vault = test_vault();
        let content = "# Note\n";
        vault
            .v2_create_note(V2CreateNoteRequest {
                mutation_id: "precondition-note".to_string(),
                path: "note.md".to_string(),
                content: content.to_string(),
                source_hash: history::source_hash(content),
            })
            .unwrap();
        let meta = vault.v2_notes().unwrap().remove(0);
        let row = vault
            .lock_catalog()
            .note_row_by_id(&meta.note_id)
            .unwrap()
            .unwrap();
        let valid = V2NotePrecondition {
            base_revision: meta.revision,
            base_source_hash: meta.source_hash,
            base_disk_hash: meta.disk_hash,
        };
        assert!(v2_check_precondition(&row, &valid).is_ok());

        let mut stale_source = valid.clone();
        stale_source.base_source_hash = "stale-source".to_string();
        assert!(matches!(
            v2_check_precondition(&row, &stale_source),
            Err(V2VaultError::Api(V2ApiErrorKind::SourceHashMismatch { .. }))
        ));

        let mut stale_disk = valid.clone();
        stale_disk.base_disk_hash = "stale-disk".to_string();
        assert!(matches!(
            v2_check_precondition(&row, &stale_disk),
            Err(V2VaultError::Api(V2ApiErrorKind::DiskHashMismatch { .. }))
        ));

        let mut stale_revision = valid;
        stale_revision.base_revision += 1;
        assert!(matches!(
            v2_check_precondition(&row, &stale_revision),
            Err(V2VaultError::Api(V2ApiErrorKind::BadRequest { .. }))
        ));
    }

    #[test]
    fn create_path_validation_returns_typed_api_error() {
        let vault = test_vault();
        let error = vault
            .create_note(CreateNoteRequest {
                path: "../bad.md".to_string(),
                content: "# Bad\n".to_string(),
                source: None,
            })
            .unwrap_err();

        let Error::Api(error) = error else {
            panic!("expected API error");
        };
        assert!(matches!(
            *error,
            ApiErrorKind::PathInvalid {
                reason: PathValidationReason::Traversal
            }
        ));
    }

    #[test]
    fn v2_create_rejects_invalid_source_and_colliding_paths() {
        let vault = test_vault();
        let invalid_id = V2CreateNoteRequest {
            mutation_id: String::new(),
            path: "valid.md".to_string(),
            content: "# Valid\n".to_string(),
            source_hash: history::source_hash("# Valid\n"),
        };
        assert!(matches!(
            vault.v2_create_note(invalid_id),
            Err(V2VaultError::Api(V2ApiErrorKind::BadRequest { .. }))
        ));

        let invalid_source = V2CreateNoteRequest {
            mutation_id: "invalid-source".to_string(),
            path: "valid.md".to_string(),
            content: "# Valid\r\n".to_string(),
            source_hash: history::source_hash("# Valid\r\n"),
        };
        assert!(matches!(
            vault.v2_create_note(invalid_source),
            Err(V2VaultError::Api(V2ApiErrorKind::BadRequest { .. }))
        ));

        let wrong_hash = V2CreateNoteRequest {
            mutation_id: "wrong-source-hash".to_string(),
            path: "valid.md".to_string(),
            content: "# Valid\n".to_string(),
            source_hash: history::source_hash("# Other\n"),
        };
        assert!(matches!(
            vault.v2_create_note(wrong_hash),
            Err(V2VaultError::Api(V2ApiErrorKind::SourceHashMismatch { .. }))
        ));

        let invalid_path = V2CreateNoteRequest {
            mutation_id: "invalid-path".to_string(),
            path: "../outside.md".to_string(),
            content: "# Outside\n".to_string(),
            source_hash: history::source_hash("# Outside\n"),
        };
        assert!(matches!(
            vault.v2_create_note(invalid_path),
            Err(V2VaultError::Api(V2ApiErrorKind::PathInvalid { .. }))
        ));

        let content = "# Existing\n";
        vault
            .v2_create_note(V2CreateNoteRequest {
                mutation_id: "create-existing".to_string(),
                path: "existing.md".to_string(),
                content: content.to_string(),
                source_hash: history::source_hash(content),
            })
            .unwrap();
        let catalog_collision = vault.v2_create_note(V2CreateNoteRequest {
            mutation_id: "catalog-collision".to_string(),
            path: "existing.md".to_string(),
            content: content.to_string(),
            source_hash: history::source_hash(content),
        });
        assert!(matches!(
            catalog_collision,
            Err(V2VaultError::Api(V2ApiErrorKind::PathCollision { .. }))
        ));

        fs::write(vault.root.join("untracked.md"), "# Untracked\n").unwrap();
        let disk_collision = vault.v2_create_note(V2CreateNoteRequest {
            mutation_id: "disk-collision".to_string(),
            path: "untracked.md".to_string(),
            content: "# Untracked\n".to_string(),
            source_hash: history::source_hash("# Untracked\n"),
        });
        assert!(matches!(
            disk_collision,
            Err(V2VaultError::Api(V2ApiErrorKind::PathCollision { .. }))
        ));
        assert_eq!(
            fs::read(vault.root.join("untracked.md")).unwrap(),
            b"# Untracked\n"
        );
    }

    #[test]
    fn v2_search_returns_saved_overlay_identity_and_source_ranges() {
        let vault = test_vault_with_note("A.md", "# Moon\n\ncomet vintage\n");
        let meta = vault.lock_catalog().live_notes().unwrap().remove(0);
        let response = vault
            .v2_search(V2SearchRequest {
                query: "comet".to_string(),
                mode: V2SearchMode::Default,
                limit: 10,
                overlays: vec![V2SearchOverlay::Saved {
                    note_id: meta.note_id.clone(),
                    base_revision: meta.seq,
                    base_source_hash: meta.content_hash.clone(),
                    local_revision: 4,
                    title: "Moon".to_string(),
                    path: "A.md".to_string(),
                    content: "# Moon\n\n😀 comet rocket\n".to_string(),
                }],
            })
            .unwrap();

        assert_eq!(response.hits.len(), 1);
        assert!(matches!(
            &response.hits[0].identity,
            V2SearchHitIdentity::SavedOverlay {
                note_id,
                local_revision: 4,
                ..
            } if note_id == &meta.note_id
        ));
        assert!(response.hits[0].excerpt.contains("rocket"));
        assert!(!response.hits[0].excerpt.contains("vintage"));
        assert!(response.hits[0].source_range.is_some());
        assert_eq!(response.overlay_coverage, V2OverlayCoverage::Complete);
    }

    #[test]
    fn new_draft_identity_does_not_suppress_a_canonical_note() {
        let vault = test_vault_with_note("A.md", "# Moon\n\ncomet vintage\n");
        let meta = vault.lock_catalog().live_notes().unwrap().remove(0);
        let response = vault
            .v2_search(V2SearchRequest {
                query: "comet".to_string(),
                mode: V2SearchMode::Default,
                limit: 10,
                overlays: vec![V2SearchOverlay::New {
                    local_id: meta.note_id.clone(),
                    local_revision: 2,
                    title: "Draft".to_string(),
                    path: "draft.md".to_string(),
                    content: "comet rocket\n".to_string(),
                }],
            })
            .unwrap();

        assert_eq!(response.hits.len(), 2);
        assert!(response.hits.iter().any(|hit| matches!(
            &hit.identity,
            V2SearchHitIdentity::Canonical { note_id, .. } if note_id == &meta.note_id
        )));
        assert!(response.hits.iter().any(|hit| matches!(
            &hit.identity,
            V2SearchHitIdentity::NewLocalDraft {
                local_id,
                local_revision: 2,
                ..
            } if local_id == &meta.note_id
        )));
    }

    #[test]
    fn v2_quick_open_returns_pinned_note_metadata() {
        let vault = test_vault_with_note("A.md", "# Moon\n\ncontent\n");
        let meta = vault.lock_catalog().live_notes().unwrap().remove(0);
        let response = vault
            .v2_quick_open(V2QuickOpenRequest {
                query: String::new(),
                pinned_note_ids: vec![meta.note_id.clone()],
                recent_note_ids: Vec::new(),
                limit: 10,
            })
            .unwrap();

        assert_eq!(response.hits.len(), 1);
        assert_eq!(response.hits[0].note_id, meta.note_id);
        assert_eq!(response.hits[0].source_hash, meta.content_hash);
        assert_eq!(response.hits[0].title, "Moon");
        assert_eq!(response.hits[0].score, 0.0);
    }

    #[test]
    fn failed_search_index_does_not_reject_accepted_note_write() {
        let dir = tempfile::tempdir().unwrap().keep();
        let state_path = dir.join("state");
        fs::create_dir_all(&state_path).unwrap();
        fs::write(state_path.join("search"), "not a directory").unwrap();
        let vault = VaultRuntime::open(
            0,
            &VaultConfig {
                name: "Test".to_string(),
                path: dir.clone(),
                state_path: state_path.clone(),
                excluded_folders: Vec::new(),
            },
            LogHub::new(crate::logging::LogMode::Off),
        )
        .unwrap();
        let content = "# A\n\naccepted\n";
        let response = vault
            .v2_create_note(V2CreateNoteRequest {
                mutation_id: "search-failure-create".to_string(),
                path: "A.md".to_string(),
                content: content.to_string(),
                source_hash: history::source_hash(content),
            })
            .unwrap();

        assert!(matches!(
            response.outcome,
            V2MutationOutcome::Accepted { result: Some(_) }
        ));
        let status = vault.search_status().unwrap();
        assert!(status.dirty);
        assert!(status.degraded);
    }

    #[test]
    fn stale_save_returns_typed_conflict_with_draft_metadata() {
        let vault = test_vault();
        let created = vault
            .create_note(CreateNoteRequest {
                path: "A.md".to_string(),
                content: "# A\n\nold\n".to_string(),
                source: None,
            })
            .unwrap();
        let base_seq = created.meta.seq;
        let base_hash = created.meta.content_hash.clone();
        vault
            .save_note(
                &created.meta.note_id,
                SaveNoteRequest {
                    content: "# A\n\naccepted\n".to_string(),
                    base_seq,
                    base_hash: base_hash.clone(),
                    checkpoint: None,
                },
            )
            .unwrap();

        let error = vault
            .save_note(
                &created.meta.note_id,
                SaveNoteRequest {
                    content: "# A\n\nstale\n".to_string(),
                    base_seq,
                    base_hash,
                    checkpoint: None,
                },
            )
            .unwrap_err();

        let Error::Api(error) = error else {
            panic!("expected save conflict");
        };
        let ApiErrorKind::SaveConflict { current, draft } = *error else {
            panic!("expected save conflict");
        };
        assert_eq!(current.meta.note_id, created.meta.note_id);
        assert_eq!(draft.note_id, created.meta.note_id);
        assert_eq!(draft.base_seq, base_seq);
    }

    #[test]
    fn save_after_external_write_before_watcher_reconcile_preserves_external_bytes() {
        let vault = test_vault();
        let created = vault
            .create_note(CreateNoteRequest {
                path: "A.md".to_string(),
                content: "# A\n\nbase\n".to_string(),
                source: None,
            })
            .unwrap();
        fs::write(
            visible_path(&vault.root, &created.meta.path),
            "# A\n\nexternal\n",
        )
        .unwrap();

        let result = vault.save_note(
            &created.meta.note_id,
            SaveNoteRequest {
                content: "# A\n\nlocal draft\n".to_string(),
                base_seq: created.meta.seq,
                base_hash: created.meta.content_hash.clone(),
                checkpoint: None,
            },
        );

        assert!(matches!(
            result,
            Err(Error::Api(error)) if matches!(*error, ApiErrorKind::SaveConflict { .. })
        ));
        assert_eq!(
            fs::read(visible_path(&vault.root, &created.meta.path)).unwrap(),
            b"# A\n\nexternal\n"
        );
        assert_eq!(
            vault.open_note(&created.meta.note_id).unwrap().content,
            "# A\n\nexternal\n"
        );
    }

    #[test]
    fn no_op_open_search_and_save_preserve_exact_disk_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = b"\xef\xbb\xbf# A\r\none\nlast\r";
        fs::write(dir.path().join("A.md"), bytes).unwrap();
        let vault = VaultRuntime::open(
            0,
            &VaultConfig {
                name: "Test".to_string(),
                path: dir.path().to_path_buf(),
                state_path: dir.path().join("state"),
                excluded_folders: Vec::new(),
            },
            LogHub::new(crate::logging::LogMode::Off),
        )
        .unwrap();
        let note = vault.bootstrap(Vec::new(), 0).unwrap().notes.remove(0);
        let opened = vault.open_note(&note.note_id).unwrap();
        assert_eq!(opened.content, "\u{feff}# A\none\nlast\n");
        vault.search("A", 10).unwrap();
        vault
            .save_note(
                &note.note_id,
                SaveNoteRequest {
                    content: opened.content,
                    base_seq: note.seq,
                    base_hash: note.content_hash,
                    checkpoint: None,
                },
            )
            .unwrap();

        assert_eq!(fs::read(dir.path().join("A.md")).unwrap(), bytes);
    }

    #[test]
    fn v2_create_save_retry_and_conflict_preserve_mutation_identity_and_events() {
        let vault = test_vault();
        let created_content = "\u{feff}# A\nold\n";
        let create = V2CreateNoteRequest {
            mutation_id: "create-1".to_string(),
            path: "A.md".to_string(),
            content: created_content.to_string(),
            source_hash: history::source_hash(created_content),
        };
        let created = vault.v2_create_note(create.clone()).unwrap();
        let V2MutationOutcome::Accepted { result: Some(meta) } = &created.outcome else {
            panic!("create did not return an accepted note");
        };
        assert_eq!(
            fs::read(vault.root.join("A.md")).unwrap(),
            created_content.as_bytes()
        );
        let legacy_payload = v2_request_hash_for_source("create", None, &create, created_content).unwrap();
        let mut legacy_result = serde_json::to_value(&created).unwrap();
        legacy_result["outcome"]["result"]["sourceHash"] =
            history::legacy_source_hash_v2(created_content).into();
        legacy_result["outcome"]["result"]["sourceHashFormatVersion"] = 2.into();
        legacy_result["outcome"]["result"]["diskHash"] =
            history::legacy_disk_hash(created_content.as_bytes()).into();
        legacy_result["outcome"]["result"]["diskHashFormatVersion"] = 1.into();
        let connection = rusqlite::Connection::open(vault.state_root.join("vault.db")).unwrap();
        connection.execute(
            "UPDATE mutation_operations SET payload_hash=?2, result_json=?3 WHERE mutation_id=?1",
            rusqlite::params!["create-1", legacy_payload.legacy, serde_json::to_string(&legacy_result).unwrap()],
        ).unwrap();
        drop(connection);
        let retried = vault.v2_create_note(create.clone()).unwrap();
        assert_eq!(
            legacy_result,
            serde_json::to_value(&retried).unwrap()
        );

        fs::write(vault.root.join("A.md"), "\u{feff}# A\r\nold\r\n").unwrap();
        let opened = vault.v2_open_note(&meta.note_id).unwrap();
        let base = V2NotePrecondition {
            base_revision: opened.meta.revision,
            base_source_hash: opened.meta.source_hash.clone(),
            base_disk_hash: opened.meta.disk_hash.clone(),
        };
        let content = "\u{feff}# A\nupdated\n";
        let save = V2SaveNoteRequest {
            mutation_id: "save-1".to_string(),
            precondition: base.clone(),
            content: content.to_string(),
            source_hash: history::source_hash(content),
        };
        let current_event_version = {
            vault
                .lock_catalog()
                .latest_vault_event_version()
                .unwrap()
        };
        let subscription = vault
            .subscribe_v2_events(Some(current_event_version))
            .unwrap();
        let saved = vault.v2_save_note(&meta.note_id, save.clone()).unwrap();
        assert!(matches!(saved.outcome, V2MutationOutcome::Accepted { .. }));
        assert_eq!(fs::read(vault.root.join("A.md")).unwrap(), "\u{feff}# A\r\nupdated\r\n".as_bytes());
        let event = subscription
            .events
            .recv_timeout(Duration::from_millis(10))
            .unwrap();
        assert!(event.event_version > subscription.current_version);
        assert_eq!(event.payload["eventVersion"], event.event_version);

        let retry = vault.v2_save_note(&meta.note_id, save.clone()).unwrap();
        assert_eq!(
            serde_json::to_value(&saved).unwrap(),
            serde_json::to_value(&retry).unwrap()
        );
        let reused = V2SaveNoteRequest {
            mutation_id: save.mutation_id.clone(),
            precondition: base.clone(),
            content: "different".to_string(),
            source_hash: history::source_hash("different"),
        };
        assert!(matches!(
            vault.v2_save_note(&meta.note_id, reused),
            Err(V2VaultError::Api(V2ApiErrorKind::MutationIdReuse { .. }))
        ));

        let stale_content = "\u{feff}# A\nstale\n";
        let stale = V2SaveNoteRequest {
            mutation_id: "save-stale".to_string(),
            precondition: base,
            content: stale_content.to_string(),
            source_hash: history::source_hash(stale_content),
        };
        let conflict = vault.v2_save_note(&meta.note_id, stale.clone()).unwrap();
        assert!(matches!(conflict.outcome, V2MutationOutcome::Conflict { .. }));
        let retried_conflict = vault.v2_save_note(&meta.note_id, stale).unwrap();
        assert_eq!(
            serde_json::to_value(&conflict).unwrap(),
            serde_json::to_value(&retried_conflict).unwrap()
        );
        assert_eq!(
            fs::read(vault.root.join("A.md")).unwrap(),
            "\u{feff}# A\r\nupdated\r\n".as_bytes()
        );
    }

    #[test]
    fn v2_restore_revision_uses_recoverable_idempotent_mutation() {
        let vault = test_vault();
        let first_content = "# A\nfirst\n";
        let created = vault
            .v2_create_note(V2CreateNoteRequest {
                mutation_id: "create-restore".to_string(),
                path: "A.md".to_string(),
                content: first_content.to_string(),
                source_hash: history::source_hash(first_content),
            })
            .unwrap();
        let V2MutationOutcome::Accepted {
            result: Some(created),
        } = created.outcome
        else {
            panic!("expected accepted create");
        };
        let changed = "# A\nsecond\n";
        vault
            .v2_save_note(
                &created.note_id,
                V2SaveNoteRequest {
                    mutation_id: "save-restore".to_string(),
                    precondition: V2NotePrecondition {
                        base_revision: created.revision,
                        base_source_hash: created.source_hash,
                        base_disk_hash: created.disk_hash,
                    },
                    content: changed.to_string(),
                    source_hash: history::source_hash(changed),
                },
            )
            .unwrap();
        let first_revision = vault
            .revisions(&created.note_id)
            .unwrap()
            .into_iter()
            .find(|revision| revision.content_hash.as_deref() == Some(&history::source_hash(first_content)))
            .unwrap();
        let current = vault.v2_open_note(&created.note_id).unwrap();
        let request = V2RestoreRevisionRequest {
            mutation_id: "restore-revision".to_string(),
            precondition: V2NotePrecondition {
                base_revision: current.meta.revision,
                base_source_hash: current.meta.source_hash,
                base_disk_hash: current.meta.disk_hash,
            },
        };
        let restored = vault
            .v2_restore_revision(&created.note_id, first_revision.event_id, request.clone())
            .unwrap();
        assert!(matches!(restored.outcome, V2MutationOutcome::Accepted { .. }));
        assert_eq!(
            vault.v2_open_note(&created.note_id).unwrap().content,
            first_content
        );
        assert_eq!(
            serde_json::to_value(&restored).unwrap(),
            serde_json::to_value(
                vault
                    .v2_restore_revision(&created.note_id, first_revision.event_id, request)
                    .unwrap()
            )
            .unwrap()
        );
    }

    #[test]
    fn v2_restore_conflict_uses_recoverable_idempotent_mutation() {
        let vault = test_vault();
        let first_content = "# A\nfirst\n";
        let created = vault
            .v2_create_note(V2CreateNoteRequest {
                mutation_id: "create-conflict-restore".to_string(),
                path: "A.md".to_string(),
                content: first_content.to_string(),
                source_hash: history::source_hash(first_content),
            })
            .unwrap();
        let V2MutationOutcome::Accepted {
            result: Some(created),
        } = created.outcome
        else {
            panic!("expected accepted create");
        };
        let base = V2NotePrecondition {
            base_revision: created.revision,
            base_source_hash: created.source_hash.clone(),
            base_disk_hash: created.disk_hash.clone(),
        };
        let accepted_content = "# A\naccepted\n";
        vault
            .v2_save_note(
                &created.note_id,
                V2SaveNoteRequest {
                    mutation_id: "save-before-conflict-restore".to_string(),
                    precondition: base.clone(),
                    content: accepted_content.to_string(),
                    source_hash: history::source_hash(accepted_content),
                },
            )
            .unwrap();
        let draft_content = "# A\ndraft\n";
        let conflict = vault
            .v2_save_note(
                &created.note_id,
                V2SaveNoteRequest {
                    mutation_id: "conflict-before-restore".to_string(),
                    precondition: base,
                    content: draft_content.to_string(),
                    source_hash: history::source_hash(draft_content),
                },
            )
            .unwrap();
        let V2MutationOutcome::Conflict { draft, .. } = conflict.outcome else {
            panic!("expected conflict draft");
        };
        let current = vault.v2_open_note(&created.note_id).unwrap();
        let request = V2RestoreConflictRequest {
            mutation_id: "restore-conflict".to_string(),
            precondition: V2NotePrecondition {
                base_revision: current.meta.revision,
                base_source_hash: current.meta.source_hash,
                base_disk_hash: current.meta.disk_hash,
            },
        };
        let restored = vault
            .v2_restore_conflict(&created.note_id, draft.draft_id, request.clone())
            .unwrap();
        assert!(matches!(restored.outcome, V2MutationOutcome::Accepted { .. }));
        assert_eq!(
            vault.v2_open_note(&created.note_id).unwrap().content,
            draft_content
        );
        assert_eq!(
            serde_json::to_value(&restored).unwrap(),
            serde_json::to_value(
                vault
                    .v2_restore_conflict(&created.note_id, draft.draft_id, request)
                    .unwrap()
            )
            .unwrap()
        );
    }

    #[test]
    fn v2_rename_delete_retry_and_materialize_paths() {
        let vault = test_vault();
        let content = "# A\ncontent\n";
        let created = vault
            .v2_create_note(V2CreateNoteRequest {
                mutation_id: "create-rename-delete".to_string(),
                path: "A.md".to_string(),
                content: content.to_string(),
                source_hash: history::source_hash(content),
            })
            .unwrap();
        let V2MutationOutcome::Accepted {
            result: Some(created),
        } = created.outcome
        else {
            panic!("expected accepted create");
        };
        let opened = vault.v2_open_note(&created.note_id).unwrap();
        let rename = V2RenameNoteRequest {
            mutation_id: "rename-1".to_string(),
            precondition: V2NotePrecondition {
                base_revision: opened.meta.revision,
                base_source_hash: opened.meta.source_hash,
                base_disk_hash: opened.meta.disk_hash,
            },
            path: "nested/B.md".to_string(),
        };
        let renamed = vault
            .v2_rename_note(&created.note_id, rename.clone())
            .unwrap();
        assert!(matches!(renamed.outcome, V2MutationOutcome::Accepted { .. }));
        assert!(!vault.root.join("A.md").exists());
        assert_eq!(fs::read(vault.root.join("nested/B.md")).unwrap(), content.as_bytes());
        assert_eq!(
            serde_json::to_value(&renamed).unwrap(),
            serde_json::to_value(vault.v2_rename_note(&created.note_id, rename).unwrap()).unwrap()
        );

        let opened = vault.v2_open_note(&created.note_id).unwrap();
        let delete = V2DeleteNoteRequest {
            mutation_id: "delete-1".to_string(),
            precondition: V2NotePrecondition {
                base_revision: opened.meta.revision,
                base_source_hash: opened.meta.source_hash,
                base_disk_hash: opened.meta.disk_hash,
            },
        };
        let deleted = vault
            .v2_delete_note(&created.note_id, delete.clone())
            .unwrap();
        assert!(matches!(
            deleted.outcome,
            V2MutationOutcome::Accepted { result: None }
        ));
        assert!(!vault.root.join("nested/B.md").exists());
        assert_eq!(
            serde_json::to_value(&deleted).unwrap(),
            serde_json::to_value(vault.v2_delete_note(&created.note_id, delete).unwrap()).unwrap()
        );
    }

    #[test]
    fn startup_repairs_pending_content_mutation_before_reconciliation() {
        let dir = tempfile::tempdir().unwrap().keep();
        let state_path = dir.join("state");
        fs::write(dir.join("A.md"), "# A\nold\n").unwrap();
        let config = VaultConfig {
            name: "Test".to_string(),
            path: dir.clone(),
            state_path: state_path.clone(),
            excluded_folders: Vec::new(),
        };
        let vault = VaultRuntime::open(
            0,
            &config,
            LogHub::new(crate::logging::LogMode::Off),
        )
        .unwrap();
        let row = vault.lock_catalog().all_rows().unwrap().remove(0);
        let candidate = "# A\naccepted before crash\n";
        let source_hash = history::source_hash(candidate);
        let disk_bytes = candidate.as_bytes();
        let disk_hash = history::disk_hash(disk_bytes);
        history::write_snapshot_bytes(&state_path, &row.meta.note_id, &source_hash, disk_bytes)
            .unwrap();
        let pending = v2_pending_response("pending-save");
        {
            let mut catalog = vault.lock_catalog();
            catalog
                .prepare_mutation(MutationIntent {
                    mutation_id: "pending-save",
                    payload_hash: "payload",
                    kind: "save",
                    note_id: Some(&row.meta.note_id),
                    path: Some(&row.meta.path),
                    old_path: None,
                    expected_disk_hash: Some(&row.visible_hash),
                    source_hash: Some(&source_hash),
                    disk_hash: Some(&disk_hash),
                })
                .unwrap();
            let parsed = parse_markdown(&row.meta.path, candidate);
            catalog
                .accept_note_content_mutation(
                    "pending-save",
                    &row.meta.note_id,
                    &parsed.title,
                    &parsed.tags,
                    &source_hash,
                    &row.visible_hash,
                    NoteEventKind::Save,
                    NoteEventSource::User,
                    &serde_json::to_string(&pending).unwrap(),
                )
                .unwrap();
        }
        drop(vault);

        let reopened = VaultRuntime::open(
            0,
            &config,
            LogHub::new(crate::logging::LogMode::Off),
        )
        .unwrap();
        assert_eq!(fs::read(dir.join("A.md")).unwrap(), disk_bytes);
        let mutation = reopened
            .lock_catalog()
            .mutation("pending-save")
            .unwrap()
            .unwrap();
        assert_eq!(mutation.state, "accepted");
        let result: V2MutationResponse =
            serde_json::from_str(mutation.result_json.as_deref().unwrap()).unwrap();
        assert!(matches!(result.outcome, V2MutationOutcome::Accepted { .. }));
    }

    #[test]
    fn startup_pending_repair_preserves_unexpected_external_bytes() {
        let dir = tempfile::tempdir().unwrap().keep();
        let state_path = dir.join("state");
        let visible = dir.join("A.md");
        fs::write(&visible, "# A\nold\n").unwrap();
        let config = VaultConfig {
            name: "Test".to_string(),
            path: dir.clone(),
            state_path: state_path.clone(),
            excluded_folders: Vec::new(),
        };
        let vault = VaultRuntime::open(
            0,
            &config,
            LogHub::new(crate::logging::LogMode::Off),
        )
        .unwrap();
        let row = vault.lock_catalog().all_rows().unwrap().remove(0);
        let candidate = "# A\naccepted before crash\n";
        let source_hash = history::source_hash(candidate);
        let disk_bytes = candidate.as_bytes();
        let disk_hash = history::disk_hash(disk_bytes);
        history::write_snapshot_bytes(&state_path, &row.meta.note_id, &source_hash, disk_bytes)
            .unwrap();
        let pending = v2_pending_response("pending-save");
        {
            let mut catalog = vault.lock_catalog();
            catalog
                .prepare_mutation(MutationIntent {
                    mutation_id: "pending-save",
                    payload_hash: "payload",
                    kind: "save",
                    note_id: Some(&row.meta.note_id),
                    path: Some(&row.meta.path),
                    old_path: None,
                    expected_disk_hash: Some(&row.visible_hash),
                    source_hash: Some(&source_hash),
                    disk_hash: Some(&disk_hash),
                })
                .unwrap();
            let parsed = parse_markdown(&row.meta.path, candidate);
            catalog
                .accept_note_content_mutation(
                    "pending-save",
                    &row.meta.note_id,
                    &parsed.title,
                    &parsed.tags,
                    &source_hash,
                    &row.visible_hash,
                    NoteEventKind::Save,
                    NoteEventSource::User,
                    &serde_json::to_string(&pending).unwrap(),
                )
                .unwrap();
        }
        let external = b"# A\nexternal after acceptance\n";
        fs::write(&visible, external).unwrap();
        drop(vault);

        assert!(VaultRuntime::open(
            0,
            &config,
            LogHub::new(crate::logging::LogMode::Off),
        )
        .is_err());
        assert_eq!(fs::read(&visible).unwrap(), external);
    }

    #[test]
    fn v2_save_restart_recovers_at_each_durable_boundary() {
        use crate::failure_point::{self, FailurePoint};

        let points = [
            FailurePoint::IntentCommitted,
            FailurePoint::SnapshotWritePermissionDenied,
            FailurePoint::SnapshotWritten,
            FailurePoint::CatalogTransitionCommitted,
            FailurePoint::VisibleFileStorageFull,
            FailurePoint::VisibleFileReplaced,
            FailurePoint::DirectorySynced,
            FailurePoint::CompletionCommitted,
            FailurePoint::BeforeEventPublish,
            FailurePoint::AfterEventPublish,
            FailurePoint::ResponseReady,
        ];

        for point in points {
            let directory = tempfile::tempdir().unwrap();
            let dir = directory.path().to_path_buf();
            let state_path = dir.join("state");
            let visible = dir.join("A.md");
            fs::write(&visible, "# A\nold\n").unwrap();
            let config = VaultConfig {
                name: "Test".to_string(),
                path: dir.clone(),
                state_path,
                excluded_folders: Vec::new(),
            };
            let vault = VaultRuntime::open(
                0,
                &config,
                LogHub::new(crate::logging::LogMode::Off),
            )
            .unwrap();
            let note = vault.v2_notes().unwrap().remove(0);
            let base = vault.v2_open_note(&note.note_id).unwrap();
            let baseline = vault
                .lock_catalog()
                .latest_vault_event_version()
                .unwrap();
            let subscription = vault.subscribe_v2_events(Some(baseline)).unwrap();
            let content = "# A\nnew\n";
            let request = V2SaveNoteRequest {
                mutation_id: format!("save-{point:?}"),
                precondition: V2NotePrecondition {
                    base_revision: base.meta.revision,
                    base_source_hash: base.meta.source_hash,
                    base_disk_hash: base.meta.disk_hash,
                },
                content: content.to_string(),
                source_hash: history::source_hash(content),
            };

            failure_point::inject(point);
            let first = vault.v2_save_note(&note.note_id, request.clone());
            assert!(!failure_point::is_armed(), "{point:?} was not reached");
            if point == FailurePoint::SnapshotWritePermissionDenied {
                assert!(matches!(
                    first.as_ref(),
                    Err(V2VaultError::Internal(Error::Io(error)))
                        if error.kind() == std::io::ErrorKind::PermissionDenied
                ));
            }
            if matches!(
                point,
                FailurePoint::VisibleFileStorageFull
                    | FailurePoint::VisibleFileReplaced
                    | FailurePoint::DirectorySynced
            ) {
                assert!(matches!(
                    first.unwrap().outcome,
                    V2MutationOutcome::PendingMaterialization { .. }
                ));
            } else {
                assert!(first.is_err(), "{point:?} unexpectedly returned a response");
            }
            let live_event = subscription
                .events
                .recv_timeout(Duration::from_millis(10));
            if matches!(point, FailurePoint::AfterEventPublish | FailurePoint::ResponseReady) {
                assert_eq!(live_event.unwrap().payload["update"]["kind"], "noteChanged");
            } else {
                assert!(matches!(
                    live_event,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                ));
            }

            drop(subscription);
            drop(vault);
            let reopened = VaultRuntime::open(
                0,
                &config,
                LogHub::new(crate::logging::LogMode::Off),
            )
            .unwrap();
            let recovered_before_retry = reopened.v2_open_note(&note.note_id).unwrap();
            if matches!(
                point,
                FailurePoint::IntentCommitted
                    | FailurePoint::SnapshotWritePermissionDenied
                    | FailurePoint::SnapshotWritten
            ) {
                assert_eq!(recovered_before_retry.content, "# A\nold\n", "{point:?}");
            } else {
                assert_eq!(recovered_before_retry.content, content, "{point:?}");
            }

            let retried = reopened
                .v2_save_note(&note.note_id, request.clone())
                .unwrap();
            assert!(matches!(retried.outcome, V2MutationOutcome::Accepted { .. }));
            assert_eq!(
                serde_json::to_value(&retried).unwrap(),
                serde_json::to_value(reopened.v2_save_note(&note.note_id, request).unwrap())
                    .unwrap(),
                "{point:?}"
            );
            assert_eq!(reopened.v2_open_note(&note.note_id).unwrap().meta.revision, base.meta.revision + 1);
            let replay = reopened.subscribe_v2_events(Some(baseline)).unwrap();
            assert!(!replay.resync_required, "{point:?}");
            assert_eq!(replay.replay.len(), 1, "{point:?}");
            assert_eq!(replay.replay[0].payload["update"]["kind"], "noteChanged");
            assert_eq!(replay.current_version, baseline + 1, "{point:?}");
        }
    }

    #[test]
    fn v2_create_rename_delete_restart_after_catalog_transition() {
        use crate::failure_point::{self, FailurePoint};

        for operation in ["create", "rename", "delete"] {
            let directory = tempfile::tempdir().unwrap();
            let dir = directory.path().to_path_buf();
            let state_path = dir.join("state");
            if operation != "create" {
                fs::write(dir.join("A.md"), "# A\noriginal\n").unwrap();
            }
            let config = VaultConfig {
                name: "Test".to_string(),
                path: dir.clone(),
                state_path,
                excluded_folders: Vec::new(),
            };
            let vault = VaultRuntime::open(
                0,
                &config,
                LogHub::new(crate::logging::LogMode::Off),
            )
            .unwrap();
            let note_id = if operation == "create" {
                String::new()
            } else {
                vault.v2_notes().unwrap().remove(0).note_id
            };
            let precondition = if operation == "create" {
                None
            } else {
                let note = vault.v2_open_note(&note_id).unwrap();
                Some(V2NotePrecondition {
                    base_revision: note.meta.revision,
                    base_source_hash: note.meta.source_hash,
                    base_disk_hash: note.meta.disk_hash,
                })
            };
            let baseline = vault
                .lock_catalog()
                .latest_vault_event_version()
                .unwrap();
            failure_point::inject(FailurePoint::CatalogTransitionCommitted);
            let first = match operation {
                "create" => {
                    let content = "# Created\ncreated\n";
                    vault.v2_create_note(V2CreateNoteRequest {
                        mutation_id: "create-restart".to_string(),
                        path: "Created.md".to_string(),
                        content: content.to_string(),
                        source_hash: history::source_hash(content),
                    })
                }
                "rename" => vault.v2_rename_note(
                    &note_id,
                    V2RenameNoteRequest {
                        mutation_id: "rename-restart".to_string(),
                        precondition: precondition.clone().unwrap(),
                        path: "B.md".to_string(),
                    },
                ),
                "delete" => vault.v2_delete_note(
                    &note_id,
                    V2DeleteNoteRequest {
                        mutation_id: "delete-restart".to_string(),
                        precondition: precondition.clone().unwrap(),
                    },
                ),
                _ => unreachable!(),
            };
            assert!(first.is_err(), "{operation} transition did not fail");
            assert!(!failure_point::is_armed(), "{operation} transition was not reached");
            drop(vault);

            let reopened = VaultRuntime::open(
                0,
                &config,
                LogHub::new(crate::logging::LogMode::Off),
            )
            .unwrap();
            let retry = match operation {
                "create" => {
                    assert_eq!(fs::read(dir.join("Created.md")).unwrap(), b"# Created\ncreated\n");
                    reopened.v2_create_note(V2CreateNoteRequest {
                        mutation_id: "create-restart".to_string(),
                        path: "Created.md".to_string(),
                        content: "# Created\ncreated\n".to_string(),
                        source_hash: history::source_hash("# Created\ncreated\n"),
                    }).unwrap()
                }
                "rename" => {
                    assert!(!dir.join("A.md").exists());
                    assert_eq!(fs::read(dir.join("B.md")).unwrap(), b"# A\noriginal\n");
                    reopened.v2_rename_note(
                        &note_id,
                        V2RenameNoteRequest {
                            mutation_id: "rename-restart".to_string(),
                            precondition: precondition.clone().unwrap(),
                            path: "B.md".to_string(),
                        },
                    ).unwrap()
                }
                "delete" => {
                    assert!(!dir.join("A.md").exists());
                    reopened.v2_delete_note(
                        &note_id,
                        V2DeleteNoteRequest {
                            mutation_id: "delete-restart".to_string(),
                            precondition: precondition.unwrap(),
                        },
                    ).unwrap()
                }
                _ => unreachable!(),
            };
            assert!(matches!(retry.outcome, V2MutationOutcome::Accepted { .. }));
            let replay = reopened.subscribe_v2_events(Some(baseline)).unwrap();
            assert_eq!(replay.replay.len(), 1, "{operation}");
            assert_eq!(replay.current_version, baseline + 1, "{operation}");
            assert_eq!(
                replay.replay[0].payload["update"]["kind"],
                if operation == "delete" { "noteDeleted" } else { "noteChanged" },
                "{operation}"
            );
        }
    }

    #[test]
    fn retry_repairs_pending_mutation_and_publishes_its_event() {
        let vault = test_vault();
        let created = vault
            .create_note(CreateNoteRequest {
                path: "A.md".to_string(),
                content: "# A\nold\n".to_string(),
                source: None,
            })
            .unwrap();
        let row = vault
            .lock_catalog()
            .note_row_by_id(&created.meta.note_id)
            .unwrap()
            .unwrap();
        let current_event_version = vault
            .lock_catalog()
            .latest_vault_event_version()
            .unwrap();
        let subscription = vault
            .subscribe_v2_events(Some(current_event_version))
            .unwrap();
        let candidate = "# A\naccepted before retry\n";
        let source_hash = history::source_hash(candidate);
        let disk_bytes = candidate.as_bytes();
        let disk_hash = history::disk_hash(disk_bytes);
        history::write_snapshot_bytes(
            &vault.state_root,
            &row.meta.note_id,
            &source_hash,
            disk_bytes,
        )
        .unwrap();
        let pending = serde_json::to_string(&v2_pending_response("retry-pending-save")).unwrap();
        {
            let mut catalog = vault.lock_catalog();
            catalog
                .prepare_mutation(MutationIntent {
                    mutation_id: "retry-pending-save",
                    payload_hash: "payload",
                    kind: "save",
                    note_id: Some(&row.meta.note_id),
                    path: Some(&row.meta.path),
                    old_path: None,
                    expected_disk_hash: Some(&row.visible_hash),
                    source_hash: Some(&source_hash),
                    disk_hash: Some(&disk_hash),
                })
                .unwrap();
            let parsed = parse_markdown(&row.meta.path, candidate);
            catalog
                .accept_note_content_mutation(
                    "retry-pending-save",
                    &row.meta.note_id,
                    &parsed.title,
                    &parsed.tags,
                    &source_hash,
                    &row.visible_hash,
                    NoteEventKind::Save,
                    NoteEventSource::User,
                    &pending,
                )
                .unwrap();
        }

        let response = {
            let mut catalog = vault.lock_catalog();
            v2_existing_mutation(
                &vault,
                &vault.root,
                &vault.state_root,
                &mut catalog,
                "retry-pending-save",
                &V2PayloadHashes {
                    current: "payload".to_string(),
                    legacy: "payload".to_string(),
                },
            )
            .unwrap()
            .unwrap()
        };
        assert!(matches!(response.outcome, V2MutationOutcome::Accepted { .. }));
        let event = subscription
            .events
            .recv_timeout(Duration::from_millis(10))
            .unwrap();
        assert!(event.event_version > current_event_version);
        assert_eq!(event.payload["update"]["kind"], "noteChanged");
        assert_eq!(fs::read(vault.root.join("A.md")).unwrap(), disk_bytes);
    }

    #[test]
    fn v2_event_overflow_emits_a_terminal_resync_event() {
        let vault = test_vault();
        let subscription = vault.subscribe_v2_events(None).unwrap();
        for _ in 0..=EVENT_SUBSCRIBER_CAPACITY {
            vault
                .record_v2_event(V2ServerEventUpdate::Ready)
                .unwrap();
            assert_eq!(subscription.events.capacity(), EVENT_SUBSCRIBER_CAPACITY);
        }
        let mut latest = None;
        while let Ok(event) = subscription
            .events
            .recv_timeout(Duration::from_millis(1))
        {
            latest = Some(event);
        }
        assert!(latest.unwrap().payload["resyncRequired"].as_bool().unwrap());
    }

    #[test]
    fn watcher_reconciliation_publishes_bounded_v2_note_events() {
        let vault = test_vault();
        let subscription = vault.subscribe_v2_events(None).unwrap();

        vault.reconcile_from_watcher().unwrap();
        assert!(matches!(
            subscription.events.recv_timeout(Duration::from_millis(10)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));

        fs::write(vault.root.join("outside.md"), "# Outside\n\nedit\n").unwrap();
        vault.reconcile_from_watcher().unwrap();
        let added = subscription
            .events
            .recv_timeout(Duration::from_millis(100))
            .unwrap();
        assert_eq!(added.payload["update"]["kind"], "vaultChanged");
        let added_note = &added.payload["update"]["notes"][0];
        assert_eq!(added_note["path"], "outside.md");
        assert_eq!(added.payload["update"]["notes"].as_array().unwrap().len(), 1);
        let note_id = added_note["noteId"].as_str().unwrap();
        let source_hash = added_note["sourceHash"].as_str().unwrap();
        let disk_hash = added_note["diskHash"].as_str().unwrap();

        fs::write(vault.root.join("outside.md"), b"# Outside\r\n\r\nedit\r\n").unwrap();
        vault.reconcile_from_watcher().unwrap();
        let line_endings = subscription
            .events
            .recv_timeout(Duration::from_millis(100))
            .unwrap();
        assert_eq!(line_endings.payload["update"]["kind"], "vaultChanged");
        let changed_note = &line_endings.payload["update"]["notes"][0];
        assert_eq!(changed_note["path"], "outside.md");
        assert_eq!(line_endings.payload["update"]["notes"].as_array().unwrap().len(), 1);
        assert_eq!(changed_note["sourceHash"], source_hash);
        assert_ne!(changed_note["diskHash"], disk_hash);

        fs::remove_file(vault.root.join("outside.md")).unwrap();
        vault.reconcile_from_watcher().unwrap();
        let deleted = subscription
            .events
            .recv_timeout(Duration::from_millis(100))
            .unwrap();
        assert_eq!(deleted.payload["update"]["kind"], "noteDeleted");
        assert_eq!(deleted.payload["update"]["noteId"], note_id);
    }

    #[test]
    fn edited_source_keeps_bom_and_untouched_mixed_line_endings() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("A.md"), b"\xef\xbb\xbf# A\r\none\nlast\r").unwrap();
        let vault = VaultRuntime::open(
            0,
            &VaultConfig {
                name: "Test".to_string(),
                path: dir.path().to_path_buf(),
                state_path: dir.path().join("state"),
                excluded_folders: Vec::new(),
            },
            LogHub::new(crate::logging::LogMode::Off),
        )
        .unwrap();
        let note = vault.bootstrap(Vec::new(), 0).unwrap().notes.remove(0);
        let saved = vault
            .save_note(
                &note.note_id,
                SaveNoteRequest {
                    content: "\u{feff}# A\nchanged\nlast\n".to_string(),
                    base_seq: note.seq,
                    base_hash: note.content_hash,
                    checkpoint: None,
                },
            )
            .unwrap();

        assert_eq!(saved.document.unwrap().content, "\u{feff}# A\nchanged\nlast\n");
        assert_eq!(
            fs::read(dir.path().join("A.md")).unwrap(),
            b"\xef\xbb\xbf# A\r\nchanged\nlast\r"
        );
    }

    #[test]
    fn invalid_utf8_is_unresolved_and_read_only() {
        let dir = tempfile::tempdir().unwrap();
        let invalid_bytes = [0xff, 0xfe, 0x61];
        fs::write(dir.path().join("Bad.md"), invalid_bytes).unwrap();
        let vault = VaultRuntime::open(
            0,
            &VaultConfig {
                name: "Test".to_string(),
                path: dir.path().to_path_buf(),
                state_path: dir.path().join("state"),
                excluded_folders: Vec::new(),
            },
            LogHub::new(crate::logging::LogMode::Off),
        )
        .unwrap();
        let row = vault.lock_catalog().all_rows().unwrap().remove(0);
        assert!(matches!(
            vault.open_note(&row.meta.note_id),
            Err(Error::Api(error)) if matches!(
                *error,
                ApiErrorKind::UnresolvedNote {
                    reason: crate::api_types::UnresolvedReason::InvalidUtf8,
                    ..
                }
            )
        ));
        assert_eq!(fs::read(dir.path().join("Bad.md")).unwrap(), invalid_bytes);
    }

    #[test]
    fn revision_restore_appends_recoverable_event() {
        let vault = test_vault();
        let created = vault
            .create_note(CreateNoteRequest {
                path: "A.md".to_string(),
                content: "# A\n\nfirst\n".to_string(),
                source: None,
            })
            .unwrap();
        vault
            .save_note(
                &created.meta.note_id,
                SaveNoteRequest {
                    content: "# A\n\nsecond\n".to_string(),
                    base_seq: created.meta.seq,
                    base_hash: created.meta.content_hash.clone(),
                    checkpoint: Some(true),
                },
            )
            .unwrap();

        let revisions = vault.revisions(&created.meta.note_id).unwrap();
        let oldest = revisions.last().unwrap();
        let restored = vault
            .restore_revision(&created.meta.note_id, oldest.event_id)
            .unwrap();

        assert_eq!(restored.document.unwrap().content, "# A\n\nfirst\n");
        assert!(vault.revisions(&created.meta.note_id).unwrap().len() >= 3);
    }

    #[test]
    fn conflict_draft_can_be_restored_without_losing_current_snapshot() {
        let vault = test_vault();
        let created = vault
            .create_note(CreateNoteRequest {
                path: "A.md".to_string(),
                content: "# A\n\nbase\n".to_string(),
                source: None,
            })
            .unwrap();
        vault
            .save_note(
                &created.meta.note_id,
                SaveNoteRequest {
                    content: "# A\n\naccepted\n".to_string(),
                    base_seq: created.meta.seq,
                    base_hash: created.meta.content_hash.clone(),
                    checkpoint: None,
                },
            )
            .unwrap();
        let error = vault
            .save_note(
                &created.meta.note_id,
                SaveNoteRequest {
                    content: "# A\n\ndraft\n".to_string(),
                    base_seq: created.meta.seq,
                    base_hash: created.meta.content_hash,
                    checkpoint: None,
                },
            )
            .unwrap_err();
        let Error::Api(error) = error else {
            panic!("expected conflict");
        };
        let ApiErrorKind::SaveConflict { draft, .. } = *error else {
            panic!("expected conflict");
        };

        let draft_doc = vault
            .conflict_draft(&created.meta.note_id, draft.draft_id)
            .unwrap();
        assert_eq!(draft_doc.content, "# A\n\ndraft\n");
        let restored = vault
            .restore_conflict_draft(&created.meta.note_id, draft.draft_id)
            .unwrap();

        assert_eq!(restored.document.unwrap().content, "# A\n\ndraft\n");
        let revisions = vault.revisions(&created.meta.note_id).unwrap();
        assert!(
            revisions
                .iter()
                .any(|revision| matches!(revision.kind, NoteEventKind::ConflictRecovery))
        );
    }

    #[test]
    fn text_edits_apply_utf16_ranges_and_multiline_text() {
        let content = apply_text_edits(
            "alpha\nemoji 😀\nomega\n",
            &[
                TextEdit {
                    start: TextPosition {
                        line: 1,
                        character: 6,
                    },
                    end: TextPosition {
                        line: 1,
                        character: 8,
                    },
                    text: "😁".to_string(),
                },
                TextEdit {
                    start: TextPosition {
                        line: 2,
                        character: 5,
                    },
                    end: TextPosition {
                        line: 2,
                        character: 5,
                    },
                    text: "\ntrail".to_string(),
                },
            ],
        )
        .unwrap();

        assert_eq!(content, "alpha\nemoji 😁\nomega\ntrail\n");
    }

    #[test]
    fn text_edits_reject_invalid_ranges() {
        let split_pair = apply_text_edits(
            "😀\n",
            &[TextEdit {
                start: TextPosition {
                    line: 0,
                    character: 1,
                },
                end: TextPosition {
                    line: 0,
                    character: 1,
                },
                text: "x".to_string(),
            }],
        );
        assert!(matches!(split_pair, Err(Error::BadRequest(_))));

        let overlapping = apply_text_edits(
            "abcd",
            &[
                TextEdit {
                    start: TextPosition {
                        line: 0,
                        character: 1,
                    },
                    end: TextPosition {
                        line: 0,
                        character: 3,
                    },
                    text: "x".to_string(),
                },
                TextEdit {
                    start: TextPosition {
                        line: 0,
                        character: 2,
                    },
                    end: TextPosition {
                        line: 0,
                        character: 4,
                    },
                    text: "y".to_string(),
                },
            ],
        );
        assert!(matches!(overlapping, Err(Error::BadRequest(_))));
    }

    #[test]
    fn delta_save_writes_snapshot_without_echoing_document() {
        let vault = test_vault();
        let created = vault
            .create_note(CreateNoteRequest {
                path: "A.md".to_string(),
                content: "# A\n\nbase\n".to_string(),
                source: None,
            })
            .unwrap();
        let next = "# A\n\nchanged\n";
        let response = vault
            .save_note_delta(
                &created.meta.note_id,
                SaveNoteDeltaRequest {
                    base_seq: created.meta.seq,
                    base_hash: created.meta.content_hash.clone(),
                    content_hash: history::content_hash(next),
                    edits: vec![TextEdit {
                        start: TextPosition {
                            line: 2,
                            character: 0,
                        },
                        end: TextPosition {
                            line: 2,
                            character: 4,
                        },
                        text: "changed".to_string(),
                    }],
                    checkpoint: None,
                },
            )
            .unwrap();

        assert!(response.document.is_none());
        assert_eq!(
            history::read_snapshot(
                &vault.state_root,
                &created.meta.note_id,
                &response.meta.content_hash
            )
            .unwrap(),
            "# A\n\nchanged\n"
        );
        assert_eq!(
            fs::read_to_string(visible_path(&vault.root, &response.meta.path)).unwrap(),
            "# A\n\nchanged\n"
        );
    }

    #[test]
    fn stale_delta_save_creates_conflict_draft_from_reconstructed_content() {
        let vault = test_vault();
        let created = vault
            .create_note(CreateNoteRequest {
                path: "A.md".to_string(),
                content: "# A\n\nbase\n".to_string(),
                source: None,
            })
            .unwrap();
        vault
            .save_note(
                &created.meta.note_id,
                SaveNoteRequest {
                    content: "# A\n\naccepted\n".to_string(),
                    base_seq: created.meta.seq,
                    base_hash: created.meta.content_hash.clone(),
                    checkpoint: None,
                },
            )
            .unwrap();
        let stale = "# A\n\nstale\n";
        let error = vault
            .save_note_delta(
                &created.meta.note_id,
                SaveNoteDeltaRequest {
                    base_seq: created.meta.seq,
                    base_hash: created.meta.content_hash,
                    content_hash: history::content_hash(stale),
                    edits: vec![TextEdit {
                        start: TextPosition {
                            line: 2,
                            character: 0,
                        },
                        end: TextPosition {
                            line: 2,
                            character: 4,
                        },
                        text: "stale".to_string(),
                    }],
                    checkpoint: None,
                },
            )
            .unwrap_err();

        let Error::Api(error) = error else {
            panic!("expected save conflict");
        };
        let ApiErrorKind::SaveConflict { draft, .. } = *error else {
            panic!("expected save conflict");
        };
        let draft = vault
            .conflict_draft(&created.meta.note_id, draft.draft_id)
            .unwrap();
        assert_eq!(draft.content, "# A\n\nstale\n");
    }

    #[test]
    fn delta_hash_mismatch_mutates_nothing() {
        let vault = test_vault();
        let created = vault
            .create_note(CreateNoteRequest {
                path: "A.md".to_string(),
                content: "# A\n\nbase\n".to_string(),
                source: None,
            })
            .unwrap();
        let error = vault
            .save_note_delta(
                &created.meta.note_id,
                SaveNoteDeltaRequest {
                    base_seq: created.meta.seq,
                    base_hash: created.meta.content_hash.clone(),
                    content_hash: history::content_hash("# wrong\n"),
                    edits: vec![TextEdit {
                        start: TextPosition {
                            line: 2,
                            character: 0,
                        },
                        end: TextPosition {
                            line: 2,
                            character: 4,
                        },
                        text: "changed".to_string(),
                    }],
                    checkpoint: None,
                },
            )
            .unwrap_err();

        assert!(matches!(error, Error::BadRequest(_)));
        assert_eq!(
            vault.open_note(&created.meta.note_id).unwrap().content,
            "# A\n\nbase\n"
        );
        assert_eq!(
            vault.open_note(&created.meta.note_id).unwrap().meta.seq,
            created.meta.seq
        );
    }

    #[test]
    fn uploaded_images_are_vault_scoped_assets() {
        let vault = test_vault();
        let uploaded = vault.upload_image(b"webp").unwrap();

        assert!(uploaded.name.starts_with("z-images/"));
        assert_eq!(vault.read_asset(&uploaded.name).unwrap(), b"webp");
        assert!(vault.read_asset("../bad.webp").is_err());
    }

    #[test]
    fn state_lives_outside_vault_and_legacy_dot_tansu_is_copied() {
        let dir = tempfile::tempdir().unwrap().keep();
        let legacy_state = dir.join(".tansu");
        fs::write(dir.join("A.md"), "# A\n").unwrap();
        let mut catalog = Catalog::open(&legacy_state.join("vault.db")).unwrap();
        reconcile_vault(&dir, &legacy_state, &mut catalog, &[]).unwrap();
        let legacy_note = catalog.live_notes().unwrap().remove(0);
        drop(catalog);

        let state_path = dir.join("state");
        let vault = VaultRuntime::open(
            0,
            &VaultConfig {
                name: "Test".to_string(),
                path: dir.clone(),
                state_path: state_path.clone(),
                excluded_folders: Vec::new(),
            },
            LogHub::new(crate::logging::LogMode::Off),
        )
        .unwrap();

        assert!(state_path.join("vault.db").exists());
        assert!(state_path.join("history").exists());
        assert_eq!(
            vault.bootstrap(vec![], 0).unwrap().notes[0].note_id,
            legacy_note.note_id
        );
    }

    fn test_vault_with_note(path: &str, content: &str) -> VaultRuntime {
        let dir = tempfile::tempdir().unwrap().keep();
        fs::write(dir.join(path), content).unwrap();
        let state_path = dir.join("state");
        VaultRuntime::open(
            0,
            &VaultConfig {
                name: "Test".to_string(),
                path: dir.clone(),
                state_path,
                excluded_folders: Vec::new(),
            },
            LogHub::new(crate::logging::LogMode::Off),
        )
        .unwrap()
    }

    fn test_vault() -> VaultRuntime {
        let dir = tempfile::tempdir().unwrap().keep();
        let state_path = dir.join("state");
        VaultRuntime::open(
            0,
            &VaultConfig {
                name: "Test".to_string(),
                path: dir.clone(),
                state_path,
                excluded_folders: Vec::new(),
            },
            LogHub::new(crate::logging::LogMode::Off),
        )
        .unwrap()
    }
}
