use std::fs::{self, File};
use std::collections::{HashMap, VecDeque};
use std::ops::ControlFlow;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, Weak};
use std::time::{Duration, Instant};
use std::thread;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::ErrorCode;
use serde::de::DeserializeOwned;

use crate::api_types::{
    ApiErrorKind, NoteEventKind, NoteEventSource, NoteMeta, Settings,
    V2ApiErrorKind, ValidatedSettings,
    V2CreateNoteRequest, V2DeleteNoteRequest, V2MutationOutcome,
    V2MutationResponse, V2NoteDocument, V2NoteMeta, V2NotePrecondition, V2RenameNoteRequest,
    V2SearchHit,
    V2SearchHitIdentity, V2SearchMode, V2SearchOverlay, V2SearchRequest, V2SearchResponse,
    V2SourceRange, V2ExcerptRange, V2OverlayCoverage,
    V2RestoreConflictRequest, V2RestoreRevisionRequest, V2RevisionDocument, V2RevisionMeta,
    V2ConflictDraftDocument, V2SettingsRequest, V2SettingsResponse, V2ImageUploadResponse,
    V2SaveNoteDeltaRequest,
    V2SaveNoteRequest, V2ServerEvent, V2ServerEventUpdate, V2VaultBootstrapResponse,
    V2VaultMeta, UnresolvedReason, V2Backlink, V2LinkedNote, V2NoteLinksResponse, V2NotePreview,
};
use crate::catalog::{Catalog, InsertNote, MutationIntent, MutationRecord, NoteRow, now_ms};
use crate::config::VaultConfig;
use crate::history;
use crate::links;
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
use tansu_note_core::{
    MutationIdError, NoteState, NoteUnavailable, PreconditionMismatch, SaveVerdict, SourceDocument,
    SourceNotLf, SubmittedSource, SubmittedSourceError, plan_save, validate_mutation_id,
};
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
    index: usize,
    name: String,
    vault_id: String,
    root: PathBuf,
    state_root: PathBuf,
    catalog: Mutex<Catalog>,
    search: Mutex<SearchIndex>,
    op_lock: Mutex<()>,
    v2_subscribers: Arc<Mutex<Vec<(u64, Weak<EventQueue<V2EventEnvelope>>)>>>,
    next_subscriber_id: AtomicU64,
    workers: Mutex<VaultWorkers>,
    search_tx: SyncSender<SearchCommand>,
    search_needs_reconciliation: AtomicBool,
    logs: LogHub,
    _owner_lock: VaultOwnerLock,
}

struct VaultWorkers {
    search: SearchWorkerSlot,
    watcher: WatcherWorkerSlot,
}

enum SearchWorkerSlot {
    Idle(Receiver<SearchCommand>),
    Running(SearchWorker),
    Stopped,
}

enum WatcherWorkerSlot {
    Idle,
    Running(WatcherWorker),
    Stopped,
}

struct StopSignal {
    stopped: Mutex<bool>,
    changed: Condvar,
}

impl StopSignal {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            stopped: Mutex::new(false),
            changed: Condvar::new(),
        })
    }

    fn stop(&self) {
        *self.stopped.lock().unwrap_or_else(PoisonError::into_inner) = true;
        self.changed.notify_all();
    }

    fn is_stopped(&self) -> bool {
        *self.stopped.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn sleep(&self, duration: Duration) -> bool {
        let guard = self.stopped.lock().unwrap_or_else(PoisonError::into_inner);
        *self
            .changed
            .wait_timeout_while(guard, duration, |stopped| !*stopped)
            .unwrap_or_else(PoisonError::into_inner)
            .0
    }
}

struct SearchWorker {
    stop: Arc<StopSignal>,
    handle: thread::JoinHandle<()>,
}

struct WatcherWorker {
    stop: Arc<StopSignal>,
    watcher: RecommendedWatcher,
    wake: WatcherTrigger,
    handle: thread::JoinHandle<()>,
}

fn join_worker(runtime: &VaultRuntime, name: &str, handle: thread::JoinHandle<()>) {
    if handle.thread().id() == thread::current().id() {
        return;
    }
    if handle.join().is_err() {
        runtime.log_worker_panic(name);
    }
}

struct VaultOwnerLock {
    _directory: File,
}

impl VaultOwnerLock {
    fn acquire(root: &Path) -> Result<Self> {
        let directory = File::open(root)?;
        match directory.try_lock() {
            Ok(()) => Ok(Self {
                _directory: directory,
            }),
            Err(fs::TryLockError::WouldBlock) => Err(Error::VaultAlreadyOwned {
                root: root.to_path_buf(),
            }),
            Err(fs::TryLockError::Error(error)) => Err(Error::Io(error)),
        }
    }
}

impl Drop for VaultRuntime {
    fn drop(&mut self) {
        self.shutdown();
    }
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

fn v2_request_hash<T: serde::Serialize>(kind: &str, target: Option<&str>, request: &T) -> V2Result<String> {
    let bytes = serde_json::to_vec(&(kind, target, request))?;
    Ok(tansu_note_core::disk_hash(&bytes))
}

fn v2_existing_result<T: DeserializeOwned>(
    catalog: &mut Catalog,
    mutation_id: &str,
    payload_hash: &str,
) -> V2Result<Option<T>> {
    let Some(record) = catalog.mutation(mutation_id)? else {
        return Ok(None);
    };
    if payload_hash != record.payload_hash {
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
    payload_hash: &str,
) -> V2Result<Option<V2MutationResponse>> {
    let Some(mut record) = catalog.mutation(mutation_id)? else {
        return Ok(None);
    };
    if payload_hash != record.payload_hash {
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

impl From<MutationIdError> for V2VaultError {
    fn from(error: MutationIdError) -> Self {
        Self::Api(V2ApiErrorKind::BadRequest {
            message: error.to_string(),
        })
    }
}

impl From<SourceNotLf> for V2VaultError {
    fn from(error: SourceNotLf) -> Self {
        Self::Internal(error.into())
    }
}

fn v2_submitted_source_error(error: SubmittedSourceError) -> V2VaultError {
    V2VaultError::Api(match error {
        SubmittedSourceError::HashMismatch { expected, received } => {
            V2ApiErrorKind::SourceHashMismatch { expected, received }
        }
        error => V2ApiErrorKind::BadRequest {
            message: error.to_string(),
        },
    })
}

fn v2_precondition_error(mismatch: PreconditionMismatch) -> V2VaultError {
    V2VaultError::Api(match mismatch {
        PreconditionMismatch::SourceHash { expected, received } => {
            V2ApiErrorKind::SourceHashMismatch { expected, received }
        }
        PreconditionMismatch::DiskHash { expected, received } => {
            V2ApiErrorKind::DiskHashMismatch { expected, received }
        }
        PreconditionMismatch::Revision => V2ApiErrorKind::BadRequest {
            message: "note revision changed".to_string(),
        },
    })
}

fn v2_note_unavailable(note_id: &str, unavailable: NoteUnavailable) -> V2VaultError {
    V2VaultError::Api(match unavailable {
        NoteUnavailable::NotFound => V2ApiErrorKind::NoteNotFound {
            note_id: note_id.to_string(),
        },
        NoteUnavailable::Unresolved(reason) => V2ApiErrorKind::UnresolvedNote {
            note_id: note_id.to_string(),
            reason,
        },
    })
}

fn v2_note_row(catalog: &Catalog, note_id: &str) -> V2Result<NoteRow> {
    catalog
        .note_row_by_id(note_id)?
        .ok_or_else(|| v2_note_unavailable(note_id, NoteUnavailable::NotFound))
}

fn v2_untombstoned_note_row(catalog: &Catalog, note_id: &str) -> V2Result<NoteRow> {
    let row = v2_note_row(catalog, note_id)?;
    if row.state == NoteState::Tombstoned {
        return Err(v2_note_unavailable(note_id, NoteUnavailable::NotFound));
    }
    Ok(row)
}

fn v2_live_note_row(catalog: &Catalog, note_id: &str) -> V2Result<NoteRow> {
    let row = v2_note_row(catalog, note_id)?;
    row.state
        .require_live()
        .map_err(|unavailable| v2_note_unavailable(note_id, unavailable))?;
    Ok(row)
}

fn v2_read_source_document(root: &Path, note_id: &str, meta: &NoteMeta) -> V2Result<SourceDocument> {
    let bytes = read_visible_bytes(root, &meta.path)?;
    SourceDocument::from_disk(&bytes).map_err(|_| {
        v2_note_unavailable(note_id, NoteUnavailable::Unresolved(UnresolvedReason::InvalidUtf8))
    })
}

fn v2_note_error(note_id: &str, error: Error) -> V2VaultError {
    match error {
        Error::Api(error) => match *error {
            ApiErrorKind::UnresolvedNote { reason, .. } => {
                V2VaultError::Api(V2ApiErrorKind::UnresolvedNote {
                    note_id: note_id.to_string(),
                    reason,
                })
            }
            error => V2VaultError::Internal(Error::Api(Box::new(error))),
        },
        Error::NotFound(_) => V2VaultError::Api(V2ApiErrorKind::NoteNotFound {
            note_id: note_id.to_string(),
        }),
        error => V2VaultError::Internal(error),
    }
}

fn v2_reconcile_note_before_write(
    root: &Path,
    state_root: &Path,
    catalog: &mut Catalog,
    note_id: &str,
) -> V2Result<bool> {
    reconcile_note_before_write(root, state_root, catalog, note_id)
        .map_err(|error| v2_note_error(note_id, error))
}

fn v2_document(meta: &NoteMeta, disk_hash: &str, content: String) -> Result<V2NoteDocument> {
    Ok(V2NoteDocument {
        meta: v2_note_meta(meta, disk_hash)?,
        content,
    })
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
            if tansu_note_core::disk_hash(&bytes) != expected_disk_hash {
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
                if tansu_note_core::disk_hash(&bytes) != expected {
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
    let expected = tansu_note_core::disk_hash(candidate_bytes);
    match read_optional_visible_bytes(root, path)? {
        Some(bytes) if tansu_note_core::disk_hash(&bytes) == expected => {
            sync_visible_note_parent(root, path)
        }
        Some(bytes) => {
            if expected_before.is_none_or(|hash| tansu_note_core::disk_hash(&bytes) != hash) {
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
        if tansu_note_core::disk_hash(bytes) != expected_hash {
            return Err(Error::Internal(format!(
                "pending rename found unexpected bytes at {new_path}"
            )));
        }
    }
    if let Some(bytes) = &old_bytes {
        if tansu_note_core::disk_hash(bytes) != expected_hash {
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

enum SearchCommand {
    Run(SearchJob),
    Stop,
}

enum SearchOverlayIdentityKind {
    Saved(String),
    New(String),
}

fn run_search_worker(
    runtime: Weak<VaultRuntime>,
    receiver: Receiver<SearchCommand>,
    stop: Arc<StopSignal>,
) {
    loop {
        if stop.is_stopped() {
            return;
        }
        let rebuild_failed = match runtime.upgrade() {
            Some(runtime) => {
                runtime
                    .search_needs_reconciliation
                    .swap(false, Ordering::AcqRel)
                    && !runtime.run_search_job(SearchJob::Rebuild)
            }
            None => return,
        };
        if rebuild_failed && stop.sleep(Duration::from_secs(1)) {
            return;
        }
        let mut job = match receiver.recv_timeout(Duration::from_secs(1)) {
            Ok(SearchCommand::Run(job)) => job,
            Ok(SearchCommand::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => return,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
        };
        let Some(runtime) = runtime.upgrade() else {
            return;
        };
        loop {
            runtime.run_search_job(job);
            if stop.is_stopped() {
                return;
            }
            match receiver.try_recv() {
                Ok(SearchCommand::Run(next)) => job = next,
                Ok(SearchCommand::Stop) | Err(TryRecvError::Disconnected) => return,
                Err(TryRecvError::Empty) => break,
            }
        }
    }
}

#[derive(Clone)]
struct WatcherTrigger(SyncSender<()>);

impl WatcherTrigger {
    fn notify(&self) {
        match self.0.try_send(()) {
            Ok(()) | Err(TrySendError::Full(())) | Err(TrySendError::Disconnected(())) => {}
        }
    }
}

fn watcher_trigger() -> (WatcherTrigger, Receiver<()>) {
    let (tx, rx) = mpsc::sync_channel(1);
    (WatcherTrigger(tx), rx)
}

fn run_watcher_worker(runtime: Weak<VaultRuntime>, events: Receiver<()>, stop: Arc<StopSignal>) {
    drain_watcher_triggers(&events, &stop, || match runtime.upgrade() {
        Some(runtime) => {
            if let Err(error) = runtime.reconcile_from_watcher() {
                runtime.log_watcher_reconcile_error(&error);
            }
            ControlFlow::Continue(())
        }
        None => ControlFlow::Break(()),
    });
}

fn drain_watcher_triggers(
    events: &Receiver<()>,
    stop: &StopSignal,
    mut reconcile: impl FnMut() -> ControlFlow<()>,
) {
    while events.recv().is_ok() {
        while events.recv_timeout(Duration::from_millis(150)).is_ok() {
            if stop.is_stopped() {
                return;
            }
        }
        if stop.is_stopped() {
            return;
        }
        if reconcile().is_break() {
            return;
        }
    }
}

impl VaultRuntime {
    pub fn open(index: usize, config: &VaultConfig, logs: LogHub) -> Result<Self> {
        fs::create_dir_all(&config.path)?;
        let owner_lock = VaultOwnerLock::acquire(&config.path)?;
        fs::create_dir_all(&config.state_path)?;
        let vault_id = config
            .state_path
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .ok_or_else(|| Error::BadRequest("vault state directory needs an opaque ID".to_string()))?
            .to_string();
        let mut catalog = Catalog::open(&config.state_path.join("vault.db"))?;
        let settings = catalog.settings()?;
        let excluded = settings.excluded_folders;
        catalog.clear_unrecoverable_prepared_mutations()?;
        repair_pending_mutations(&config.path, &config.state_path, &mut catalog)?;
        reconcile_vault(&config.path, &config.state_path, &mut catalog, &excluded)?;
        if catalog.watcher_reconcile_pending()? {
            let payload_json = serde_json::to_string(&V2ServerEventUpdate::ResyncRequired)?;
            catalog.append_watcher_resync_event(&payload_json, EVENT_REPLAY_LIMIT)?;
        }
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
            v2_subscribers: Arc::new(Mutex::new(Vec::new())),
            next_subscriber_id: AtomicU64::new(1),
            workers: Mutex::new(VaultWorkers {
                search: SearchWorkerSlot::Idle(search_rx),
                watcher: WatcherWorkerSlot::Idle,
            }),
            search_tx,
            search_needs_reconciliation: AtomicBool::new(search_needs_reconciliation),
            logs,
            _owner_lock: owner_lock,
        })
    }

    pub fn index(&self) -> usize {
        self.index
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn vault_id(&self) -> &str {
        &self.vault_id
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn start_search_worker(self: &Arc<Self>) -> Result<()> {
        let mut workers = self.lock_workers();
        let receiver = match std::mem::replace(&mut workers.search, SearchWorkerSlot::Stopped) {
            SearchWorkerSlot::Idle(receiver) => receiver,
            other => {
                workers.search = other;
                return Err(Error::Internal(
                    "search worker is already started or stopped".to_string(),
                ));
            }
        };
        let stop = StopSignal::new();
        let runtime = Arc::downgrade(self);
        let worker_stop = Arc::clone(&stop);
        let handle = thread::Builder::new()
            .name(format!("tansu-search-{}", self.vault_id))
            .spawn(move || run_search_worker(runtime, receiver, worker_stop))?;
        workers.search = SearchWorkerSlot::Running(SearchWorker { stop, handle });
        Ok(())
    }

    pub fn start_watcher(self: &Arc<Self>) -> Result<()> {
        let mut workers = self.lock_workers();
        if !matches!(workers.watcher, WatcherWorkerSlot::Idle) {
            return Err(Error::Internal(
                "watcher is already started or stopped".to_string(),
            ));
        }
        let root = self.root.clone();
        let state_root = self.state_root.clone();
        let (trigger, rx) = watcher_trigger();
        let wake = trigger.clone();
        let mut watcher =
            notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                if let Ok(event) = result {
                    if event.paths.iter().any(|path| {
                        path.starts_with(&state_root)
                            || path.components().any(|part| part.as_os_str() == ".tansu")
                    }) {
                        return;
                    }
                    trigger.notify();
                }
            })?;
        watcher.watch(&root, RecursiveMode::Recursive)?;
        let stop = StopSignal::new();
        let runtime = Arc::downgrade(self);
        let worker_stop = Arc::clone(&stop);
        let handle = thread::Builder::new()
            .name(format!("tansu-watcher-{}", self.vault_id))
            .spawn(move || run_watcher_worker(runtime, rx, worker_stop))?;
        workers.watcher = WatcherWorkerSlot::Running(WatcherWorker {
            stop,
            watcher,
            wake,
            handle,
        });
        Ok(())
    }

    pub fn shutdown(&self) {
        let (search, watcher) = {
            let mut workers = self.lock_workers();
            (
                std::mem::replace(&mut workers.search, SearchWorkerSlot::Stopped),
                std::mem::replace(&mut workers.watcher, WatcherWorkerSlot::Stopped),
            )
        };
        if let WatcherWorkerSlot::Running(worker) = watcher {
            let WatcherWorker {
                stop,
                watcher,
                wake,
                handle,
            } = worker;
            stop.stop();
            drop(watcher);
            wake.notify();
            join_worker(self, "watcher", handle);
        }
        if let SearchWorkerSlot::Running(worker) = search {
            worker.stop.stop();
            let _ = self.search_tx.try_send(SearchCommand::Stop);
            join_worker(self, "search", worker.handle);
        }
    }

    #[cfg(test)]
    pub(crate) fn workers_stopped(&self) -> bool {
        let workers = self.lock_workers();
        matches!(workers.search, SearchWorkerSlot::Stopped)
            && matches!(workers.watcher, WatcherWorkerSlot::Stopped)
    }

    fn lock_workers(&self) -> MutexGuard<'_, VaultWorkers> {
        self.workers.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn log_worker_panic(&self, worker: &str) {
        if self.logs.enabled() {
            self.logs.server_event(
                LogLevel::Error,
                "system.event",
                None,
                fields([
                    (
                        "system",
                        serde_json::json!({
                            "component": "vault",
                            "action": "worker_panic",
                            "worker": worker,
                        }),
                    ),
                    ("vault", serde_json::json!(self.index)),
                ]),
            );
        }
    }

    fn log_watcher_reconcile_error(&self, error: &Error) {
        if self.logs.enabled() {
            self.logs.server_event(
                LogLevel::Error,
                "system.event",
                None,
                fields([
                    (
                        "system",
                        serde_json::json!({
                            "component": "watcher",
                            "action": "reconcile_error",
                        }),
                    ),
                    ("vault", serde_json::json!(self.index)),
                    ("error", serde_json::json!(error.to_string())),
                ]),
            );
        }
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
        })
    }

    pub fn v2_list_revisions(&self, note_id: &str) -> V2Result<Vec<V2RevisionMeta>> {
        let _op = self.lock_op();
        let catalog = self.lock_catalog();
        v2_untombstoned_note_row(&catalog, note_id)?;
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
        v2_untombstoned_note_row(&catalog, note_id)?;
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
        let settings = ValidatedSettings::try_from(request.settings.clone()).map_err(|error| {
            V2VaultError::Api(V2ApiErrorKind::BadRequest {
                message: error.into_message(),
            })
        })?;
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
            payload_hash: &payload_hash,
            kind: "settings",
            note_id: None,
            path: None,
            old_path: None,
            expected_disk_hash: None,
            source_hash: None,
            disk_hash: None,
        })?;
        let excluded_folders_changed =
            catalog.settings()?.excluded_folders != settings.as_settings().excluded_folders;
        catalog.save_settings(&settings)?;
        let response = V2SettingsResponse {
            mutation_id: request.mutation_id.clone(),
            settings: settings.into_settings(),
        };
        catalog.complete_noop_mutation(
            &request.mutation_id,
            &serde_json::to_string(&response)?,
        )?;
        drop(catalog);
        if excluded_folders_changed {
            self.reconcile_with_op_lock_held()?;
        }
        self.enqueue_search(SearchJob::Rebuild);
        let status = self.search.lock().expect("search mutex poisoned").search_status();
        self.record_v2_event(V2ServerEventUpdate::SearchChanged {
            dirty: status.dirty,
            degraded: status.degraded,
        })?;
        Ok(response)
    }

    pub fn v2_upload_image(&self, mutation_id: &str, bytes: &[u8]) -> V2Result<V2ImageUploadResponse> {
        validate_mutation_id(mutation_id)?;
        if bytes.is_empty() {
            return Err(V2VaultError::Api(V2ApiErrorKind::BadRequest {
                message: "image body is empty".to_string(),
            }));
        }
        let body_hash = tansu_note_core::disk_hash(bytes);
        let payload_hash = v2_request_hash("image_upload", None, &body_hash)?;
        let _op = self.lock_op();
        let mut catalog = self.lock_catalog();
        if let Some(record) = catalog.mutation(mutation_id)? {
            if payload_hash != record.payload_hash {
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
        let digest = tansu_note_core::disk_hash(mutation_id.as_bytes());
        let digest_hex = digest.strip_prefix("blake3-v2:").ok_or_else(|| {
            Error::Internal("image name hash uses an unsupported format".to_string())
        })?;
        let name = format!("z-images/image-{digest_hex}.webp");
        catalog.prepare_mutation(MutationIntent {
            mutation_id,
            payload_hash: &payload_hash,
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
        v2_note_row(&catalog, note_id)?;
        v2_reconcile_note_before_write(&self.root, &self.state_root, &mut catalog, note_id)?;
        let row = v2_live_note_row(&catalog, note_id)?;
        let content = read_visible_or_snapshot(&self.root, &row.meta)
            .map_err(|error| v2_note_error(note_id, error))?;
        Ok(v2_document(&row.meta, &row.visible_hash, content)?)
    }

    fn live_notes_containing(&self, note_id: &str) -> V2Result<Vec<NoteMeta>> {
        let notes = {
            let _op = self.lock_op();
            self.lock_catalog().live_notes()?
        };
        if notes.iter().any(|note| note.note_id == note_id) {
            Ok(notes)
        } else {
            Err(V2VaultError::Api(V2ApiErrorKind::NoteNotFound {
                note_id: note_id.to_string(),
            }))
        }
    }

    pub fn v2_note_preview(&self, note_id: &str) -> V2Result<V2NotePreview> {
        let notes = self.live_notes_containing(note_id)?;
        let meta = notes.iter().find(|note| note.note_id == note_id).expect("checked");
        let content = read_visible_or_snapshot(&self.root, meta)
            .map_err(|error| v2_note_error(note_id, error))?;
        Ok(V2NotePreview {
            note_id: note_id.to_string(),
            preview: links::preview(&content),
        })
    }

    pub fn v2_note_links(&self, note_id: &str) -> V2Result<V2NoteLinksResponse> {
        let notes = self.live_notes_containing(note_id)?;
        let linked = |note: &NoteMeta| V2LinkedNote {
            note_id: note.note_id.clone(),
            path: note.path.clone(),
            title: note.title.clone(),
        };
        let mut backlinks = Vec::new();
        let mut outgoing: Vec<V2LinkedNote> = Vec::new();
        for source in &notes {
            let Ok(content) = read_visible_or_snapshot(&self.root, source) else {
                continue;
            };
            let mut mentions = Vec::new();
            for link in links::extract_links(&content) {
                let links::Resolution::Resolved(target) = links::resolve(&link.target, &source.path, &notes)
                else {
                    continue;
                };
                if source.note_id == note_id {
                    if !outgoing.iter().any(|existing| existing.note_id == target.note_id) {
                        outgoing.push(linked(target));
                    }
                } else if target.note_id == note_id {
                    mentions.push(link.mention);
                }
            }
            if !mentions.is_empty() {
                backlinks.push(V2Backlink { note: linked(source), mentions });
            }
        }
        Ok(V2NoteLinksResponse { backlinks, outgoing })
    }

    pub fn v2_save_note(
        &self,
        note_id: &str,
        request: V2SaveNoteRequest,
    ) -> V2Result<V2MutationResponse> {
        validate_mutation_id(&request.mutation_id)?;
        let submitted = SubmittedSource::from_editor(&request.content, &request.source_hash)
            .map_err(v2_submitted_source_error)?;
        let payload_hash = v2_request_hash("save", Some(note_id), &request)?;
        self.v2_save_source(
            note_id,
            &request.mutation_id,
            &request.precondition,
            &submitted,
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
            v2_untombstoned_note_row(&catalog, note_id)?;
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
        let submitted = SubmittedSource::from_delta(&base, &request.edits, &request.source_hash)
            .map_err(v2_submitted_source_error)?;
        let payload_hash = v2_request_hash("save_delta", Some(note_id), &request)?;
        self.v2_save_source(
            note_id,
            &request.mutation_id,
            &request.precondition,
            &submitted,
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
        self.v2_save_source(
            note_id,
            &request.mutation_id,
            &request.precondition,
            &SubmittedSource::from_stored(&content),
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
        self.v2_save_source(
            note_id,
            &request.mutation_id,
            &request.precondition,
            &SubmittedSource::from_stored(&content),
            &payload_hash,
            "restore_conflict",
        )
    }

    fn v2_save_source(
        &self,
        note_id: &str,
        mutation_id: &str,
        precondition: &V2NotePrecondition,
        submitted: &SubmittedSource,
        payload_hash: &str,
        kind: &str,
    ) -> V2Result<V2MutationResponse> {
        let _op = self.lock_op();
        let mut catalog = self.lock_catalog();
        if let Some(response) = v2_existing_mutation(self, &self.root, &self.state_root, &mut catalog, mutation_id, payload_hash)? {
            return Ok(response);
        }
        v2_reconcile_note_before_write(&self.root, &self.state_root, &mut catalog, note_id)?;
        let mut row = v2_live_note_row(&catalog, note_id)?;
        let mut on_disk = v2_read_source_document(&self.root, note_id, &row.meta)?;
        if on_disk.disk_hash() != row.visible_hash {
            v2_reconcile_note_before_write(&self.root, &self.state_root, &mut catalog, note_id)?;
            row = v2_live_note_row(&catalog, note_id)?;
            on_disk = v2_read_source_document(&self.root, note_id, &row.meta)?;
        }
        let plan = plan_save(row.recorded(), &on_disk, precondition, submitted)?;
        let submitted_hash = submitted.source_hash();
        let content = submitted.content();
        let candidate_disk_bytes = plan.candidate_disk_bytes;
        let candidate_disk_hash = plan.candidate_disk_hash;
        let current = row.meta.clone();
        catalog.prepare_mutation(MutationIntent {
            mutation_id,
            payload_hash,
            kind,
            note_id: Some(note_id),
            path: Some(&current.path),
            old_path: None,
            expected_disk_hash: Some(&row.visible_hash),
            source_hash: Some(submitted_hash),
            disk_hash: Some(&candidate_disk_hash),
        })?;
        match plan.verdict {
            SaveVerdict::Conflict => {
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
            SaveVerdict::Unchanged => {
                let response = v2_accepted_response(
                    mutation_id,
                    Some(v2_note_meta(&current, &row.visible_hash)?),
                );
                catalog.complete_noop_mutation(
                    mutation_id,
                    &serde_json::to_string(&response)?,
                )?;
                return Ok(response);
            }
            SaveVerdict::Write => {}
        }
        history::write_snapshot_bytes(
            &self.state_root,
            note_id,
            &submitted_hash,
            &candidate_disk_bytes,
        )?;
        let current_check = read_visible_bytes(&self.root, &current.path)?;
        if tansu_note_core::disk_hash(&current_check) != row.visible_hash {
            catalog.clear_prepared_mutation(mutation_id)?;
            v2_reconcile_note_before_write(&self.root, &self.state_root, &mut catalog, note_id)?;
            let latest = catalog.note_row_by_id(note_id)?.ok_or_else(|| {
                V2VaultError::Api(V2ApiErrorKind::NoteNotFound {
                    note_id: note_id.to_string(),
                })
            })?;
            catalog.prepare_mutation(MutationIntent {
                mutation_id,
                payload_hash: &payload_hash,
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
        if tansu_note_core::disk_hash(&read_visible_bytes(&self.root, &current.path)?) != row.visible_hash {
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
        let submitted = SubmittedSource::from_editor(&request.content, &request.source_hash)
            .map_err(v2_submitted_source_error)?;
        let content = submitted.content();
        let source_hash = submitted.source_hash();
        let path = normalize_note_path(&request.path).map_err(|reason| {
            V2VaultError::Api(V2ApiErrorKind::PathInvalid { reason })
        })?;
        let payload_hash = v2_request_hash("create", None, &request)?;
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
        let disk_hash = tansu_note_core::disk_hash(disk_bytes);
        catalog.prepare_mutation(MutationIntent {
            mutation_id: &request.mutation_id,
            payload_hash: &payload_hash,
            kind: "create",
            note_id: Some(&note_id),
            path: Some(&path),
            old_path: None,
            expected_disk_hash: None,
            source_hash: Some(source_hash),
            disk_hash: Some(&disk_hash),
        })?;
        history::write_snapshot_bytes(&self.state_root, &note_id, source_hash, disk_bytes)?;
        if read_optional_visible_bytes(&self.root, &path)?.is_some() {
                catalog.clear_prepared_mutation(&request.mutation_id)?;
                return Err(V2VaultError::Api(V2ApiErrorKind::PathCollision { path }));
        }
        let parsed = parse_markdown(&path, content);
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
                    content_hash: source_hash,
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
        self.enqueue_search(SearchJob::Upsert(meta.clone(), content.to_string()));
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
        v2_reconcile_note_before_write(&self.root, &self.state_root, &mut catalog, note_id)?;
        let row = v2_live_note_row(&catalog, note_id)?;
        row.recorded()
            .check(&request.precondition)
            .map_err(v2_precondition_error)?;
        if path == row.meta.path {
            let response = v2_accepted_response(
                &request.mutation_id,
                Some(v2_note_meta(&row.meta, &row.visible_hash)?),
            );
            catalog.prepare_mutation(MutationIntent {
                mutation_id: &request.mutation_id,
                payload_hash: &payload_hash,
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
        if tansu_note_core::disk_hash(&source_bytes) != row.visible_hash {
            v2_reconcile_note_before_write(&self.root, &self.state_root, &mut catalog, note_id)?;
            return Err(V2VaultError::Api(V2ApiErrorKind::DiskHashMismatch {
                expected: catalog
                    .note_row_by_id(note_id)?
                    .map(|current| current.visible_hash)
                    .unwrap_or_default(),
                received: row.visible_hash,
            }));
        }
        let source_document = tansu_note_core::SourceDocument::from_disk(&source_bytes).map_err(|_| {
            V2VaultError::Api(V2ApiErrorKind::UnresolvedNote {
                note_id: note_id.to_string(),
                reason: UnresolvedReason::InvalidUtf8,
            })
        })?;
        let content_hash = tansu_note_core::source_hash(&source_document.source);
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
            payload_hash: &payload_hash,
            kind: "rename",
            note_id: Some(note_id),
            path: Some(&path),
            old_path: Some(&row.meta.path),
            expected_disk_hash: Some(&row.visible_hash),
            source_hash: Some(&content_hash),
            disk_hash: Some(&row.visible_hash),
        })?;
        let current_check = read_visible_bytes(&self.root, &row.meta.path)?;
        if tansu_note_core::disk_hash(&current_check) != row.visible_hash {
            catalog.clear_prepared_mutation(&request.mutation_id)?;
            v2_reconcile_note_before_write(&self.root, &self.state_root, &mut catalog, note_id)?;
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
        if tansu_note_core::disk_hash(&read_visible_bytes(&self.root, &row.meta.path)?) != row.visible_hash
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
        v2_reconcile_note_before_write(&self.root, &self.state_root, &mut catalog, note_id)?;
        let row = v2_live_note_row(&catalog, note_id)?;
        row.recorded()
            .check(&request.precondition)
            .map_err(v2_precondition_error)?;
        let bytes = read_visible_bytes(&self.root, &row.meta.path)?;
        let source_document = tansu_note_core::SourceDocument::from_disk(&bytes).map_err(|_| {
            V2VaultError::Api(V2ApiErrorKind::UnresolvedNote {
                note_id: note_id.to_string(),
                reason: UnresolvedReason::InvalidUtf8,
            })
        })?;
        let disk_hash = tansu_note_core::disk_hash(&bytes);
        history::write_snapshot_bytes(
            &self.state_root,
            note_id,
            &tansu_note_core::source_hash(&source_document.source),
            &bytes,
        )?;
        catalog.prepare_mutation(MutationIntent {
            mutation_id: &request.mutation_id,
            payload_hash: &payload_hash,
            kind: "delete",
            note_id: Some(note_id),
            path: None,
            old_path: Some(&row.meta.path),
            expected_disk_hash: Some(&disk_hash),
            source_hash: Some(&row.meta.content_hash),
            disk_hash: Some(&disk_hash),
        })?;
        let check = read_visible_bytes(&self.root, &row.meta.path)?;
        if tansu_note_core::disk_hash(&check) != disk_hash {
            catalog.clear_prepared_mutation(&request.mutation_id)?;
            v2_reconcile_note_before_write(&self.root, &self.state_root, &mut catalog, note_id)?;
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
        if tansu_note_core::disk_hash(&check) != disk_hash
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
        let resync_required = catalog.watcher_reconcile_pending()?
            || too_old
            || too_new
            || replay_too_large;
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

    fn record_watcher_resync_event(&self) -> Result<V2EventEnvelope> {
        let update = V2ServerEventUpdate::ResyncRequired;
        let payload_json = serde_json::to_string(&update)?;
        let version = self
            .lock_catalog()
            .append_watcher_resync_event(&payload_json, EVENT_REPLAY_LIMIT)?;
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

    pub fn v2_search(&self, request: V2SearchRequest) -> V2Result<V2SearchResponse> {
        let _op = self.lock_op();
        validate_v2_search_limit(request.limit)?;
        let (notes, settings) = {
            let catalog = self.lock_catalog();
            (catalog.live_notes()?, catalog.settings()?)
        };
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
                        let source_hash = tansu_note_core::source_hash(content);
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
                &settings,
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

    pub fn settings(&self) -> Result<Settings> {
        let _op = self.lock_op();
        self.lock_catalog().settings()
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
        match self.search_tx.try_send(SearchCommand::Run(job)) {
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
        self.reconcile_with_op_lock_held()
    }

    fn reconcile_with_op_lock_held(&self) -> Result<()> {
        let mut catalog = self.lock_catalog();
        let pending_resync = catalog.watcher_reconcile_pending()?;
        catalog.mark_watcher_reconcile_pending()?;
        let before = catalog
            .all_rows()?
            .into_iter()
            .filter(|row| row.state.is_live())
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
            .filter(|row| row.state.is_live())
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
        #[cfg(test)]
        crate::failure_point::check(crate::failure_point::FailurePoint::WatcherReconciled)?;
        if pending_resync {
            self.record_watcher_resync_event()?;
        } else if changed {
            for note_id in &deleted {
                self.record_v2_event(V2ServerEventUpdate::NoteDeleted {
                    note_id: note_id.clone(),
                })?;
            }
            for note in changed_v2_notes {
                self.record_v2_event(V2ServerEventUpdate::VaultChanged { notes: vec![note] })?;
            }
        }
        if !pending_resync {
            self.lock_catalog()
                .clear_watcher_reconcile_pending()?;
        }
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
        Ok(bytes) => match tansu_note_core::SourceDocument::from_disk(&bytes) {
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
        TextEdit, TextPosition,
        V2CreateNoteRequest, V2DeleteNoteRequest, V2MutationOutcome, V2NotePrecondition,
        V2RenameNoteRequest, V2RestoreConflictRequest,
        V2RestoreRevisionRequest, V2SaveNoteRequest,
    };

    use super::*;

    #[test]
    fn v2_boundary_helpers_validate_and_translate_errors() {
        assert!(matches!(
            V2VaultError::from(MutationIdError),
            V2VaultError::Api(V2ApiErrorKind::BadRequest { .. })
        ));
        assert!(matches!(
            v2_submitted_source_error(SubmittedSourceError::NotLf),
            V2VaultError::Api(V2ApiErrorKind::BadRequest { .. })
        ));
        assert!(matches!(
            v2_submitted_source_error(SubmittedSourceError::HashMismatch {
                expected: "expected".to_string(),
                received: "received".to_string(),
            }),
            V2VaultError::Api(V2ApiErrorKind::SourceHashMismatch { .. })
        ));
        assert!(matches!(
            v2_note_unavailable("note", NoteUnavailable::NotFound),
            V2VaultError::Api(V2ApiErrorKind::NoteNotFound { .. })
        ));
        assert!(matches!(
            v2_note_unavailable("note", NoteUnavailable::Unresolved(UnresolvedReason::CorruptSnapshot)),
            V2VaultError::Api(V2ApiErrorKind::UnresolvedNote {
                reason: UnresolvedReason::CorruptSnapshot,
                ..
            })
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

    fn invalid_settings_variants() -> Vec<(&'static str, Settings)> {
        let valid = Settings::default();
        vec![
            ("autosave below minimum", Settings { autosave_delay_ms: 149, ..valid.clone() }),
            ("autosave above maximum", Settings { autosave_delay_ms: u64::MAX, ..valid.clone() }),
            ("undo below minimum", Settings { undo_stack_max: 19, ..valid.clone() }),
            ("undo above maximum", Settings { undo_stack_max: usize::MAX, ..valid.clone() }),
            ("quality below minimum", Settings { image_webp_quality: 0.05, ..valid.clone() }),
            ("quality above maximum", Settings { image_webp_quality: 1.5, ..valid.clone() }),
            ("quality nan", Settings { image_webp_quality: f32::NAN, ..valid.clone() }),
            ("title weight nan", Settings { search_title_weight: f32::NAN, ..valid.clone() }),
            ("heading weight infinite", Settings { search_heading_weight: f32::INFINITY, ..valid.clone() }),
            ("tag weight negative", Settings { search_tag_weight: -1.0, ..valid.clone() }),
            ("content weight huge", Settings { search_content_weight: 1.0e9, ..valid.clone() }),
            ("recency boost nan", Settings { recency_boost: f32::NAN, ..valid.clone() }),
            ("empty excluded folder", Settings { excluded_folders: vec![String::new()], ..valid.clone() }),
            ("nested excluded folder", Settings { excluded_folders: vec!["a/b".to_string()], ..valid.clone() }),
            ("dot excluded folder", Settings { excluded_folders: vec!["..".to_string()], ..valid }),
        ]
    }

    #[test]
    fn v2_save_settings_rejects_invalid_values_without_persisting() {
        let vault = test_vault();
        let before = serde_json::to_value(vault.settings().unwrap()).unwrap();
        for (label, settings) in invalid_settings_variants() {
            let result = vault.v2_save_settings(V2SettingsRequest {
                mutation_id: "settings-invalid".to_string(),
                settings,
            });
            assert!(
                matches!(result, Err(V2VaultError::Api(V2ApiErrorKind::BadRequest { .. }))),
                "{label}"
            );
            assert_eq!(serde_json::to_value(vault.settings().unwrap()).unwrap(), before, "{label}");
        }
        vault
            .v2_save_settings(V2SettingsRequest {
                mutation_id: "settings-invalid".to_string(),
                settings: Settings { autosave_delay_ms: 150, undo_stack_max: 20, image_webp_quality: 0.1, ..Settings::default() },
            })
            .unwrap();
    }

    #[test]
    fn saving_excluded_folders_reconciles_search_immediately() {
        let vault = Arc::new(test_vault_with_note("keep.md", "# Keep\n\nquasar\n"));
        vault.start_search_worker().unwrap();
        fs::create_dir_all(vault.root.join("Archive/deep")).unwrap();
        fs::write(vault.root.join("Archive/old.md"), "# Old\n\nquasar\n").unwrap();
        fs::write(vault.root.join("Archive/deep/older.md"), "# Older\n\nquasar\n").unwrap();
        vault.reconcile_from_watcher().unwrap();
        let search = || {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            while vault.lock_catalog().search_status().unwrap().dirty {
                assert!(std::time::Instant::now() < deadline, "search index never settled");
                std::thread::sleep(Duration::from_millis(10));
            }
            let mut paths = vault
                .v2_search(V2SearchRequest {
                    query: "quasar".to_string(),
                    mode: V2SearchMode::Default,
                    limit: 10,
                    overlays: Vec::new(),
                })
                .unwrap()
                .hits
                .into_iter()
                .map(|hit| hit.path)
                .collect::<Vec<_>>();
            paths.sort();
            paths
        };
        assert_eq!(search(), ["Archive/deep/older.md", "Archive/old.md", "keep.md"]);

        let mut settings = vault.settings().unwrap();
        settings.excluded_folders = vec!["Archive".to_string()];
        vault
            .v2_save_settings(V2SettingsRequest { mutation_id: "exclude-archive".to_string(), settings: settings.clone() })
            .unwrap();
        assert_eq!(search(), ["keep.md"]);

        settings.excluded_folders = Vec::new();
        vault
            .v2_save_settings(V2SettingsRequest { mutation_id: "include-archive".to_string(), settings })
            .unwrap();
        assert_eq!(search(), ["Archive/deep/older.md", "Archive/old.md", "keep.md"]);
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
                source_hash: tansu_note_core::source_hash(content),
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
        assert!(row.recorded().check(&valid).is_ok());

        let mut stale_source = valid.clone();
        stale_source.base_source_hash = "stale-source".to_string();
        assert!(matches!(
            row.recorded().check(&stale_source).map_err(v2_precondition_error),
            Err(V2VaultError::Api(V2ApiErrorKind::SourceHashMismatch { .. }))
        ));

        let mut stale_disk = valid.clone();
        stale_disk.base_disk_hash = "stale-disk".to_string();
        assert!(matches!(
            row.recorded().check(&stale_disk).map_err(v2_precondition_error),
            Err(V2VaultError::Api(V2ApiErrorKind::DiskHashMismatch { .. }))
        ));

        let mut stale_revision = valid;
        stale_revision.base_revision += 1;
        assert!(matches!(
            row.recorded().check(&stale_revision).map_err(v2_precondition_error),
            Err(V2VaultError::Api(V2ApiErrorKind::BadRequest { .. }))
        ));
    }

    #[test]
    fn v2_create_rejects_invalid_source_and_colliding_paths() {
        let vault = test_vault();
        let invalid_id = V2CreateNoteRequest {
            mutation_id: String::new(),
            path: "valid.md".to_string(),
            content: "# Valid\n".to_string(),
            source_hash: tansu_note_core::source_hash("# Valid\n"),
        };
        assert!(matches!(
            vault.v2_create_note(invalid_id),
            Err(V2VaultError::Api(V2ApiErrorKind::BadRequest { .. }))
        ));

        let invalid_source = V2CreateNoteRequest {
            mutation_id: "invalid-source".to_string(),
            path: "valid.md".to_string(),
            content: "# Valid\r\n".to_string(),
            source_hash: tansu_note_core::source_hash("# Valid\r\n"),
        };
        assert!(matches!(
            vault.v2_create_note(invalid_source),
            Err(V2VaultError::Api(V2ApiErrorKind::BadRequest { .. }))
        ));

        let wrong_hash = V2CreateNoteRequest {
            mutation_id: "wrong-source-hash".to_string(),
            path: "valid.md".to_string(),
            content: "# Valid\n".to_string(),
            source_hash: tansu_note_core::source_hash("# Other\n"),
        };
        assert!(matches!(
            vault.v2_create_note(wrong_hash),
            Err(V2VaultError::Api(V2ApiErrorKind::SourceHashMismatch { .. }))
        ));

        let invalid_path = V2CreateNoteRequest {
            mutation_id: "invalid-path".to_string(),
            path: "../outside.md".to_string(),
            content: "# Outside\n".to_string(),
            source_hash: tansu_note_core::source_hash("# Outside\n"),
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
                source_hash: tansu_note_core::source_hash(content),
            })
            .unwrap();
        let catalog_collision = vault.v2_create_note(V2CreateNoteRequest {
            mutation_id: "catalog-collision".to_string(),
            path: "existing.md".to_string(),
            content: content.to_string(),
            source_hash: tansu_note_core::source_hash(content),
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
            source_hash: tansu_note_core::source_hash("# Untracked\n"),
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
    fn v2_search_ranks_a_frontmatter_tag_match_above_a_body_mention() {
        let vault = test_vault_with_notes(&[
            (
                "body.md",
                "# Garden diary\n\nalpha beta gamma delta epsilon gardening zeta eta theta iota kappa\n",
            ),
            (
                "tagged.md",
                "---\ntags:\n  - gardening\n---\n\n# Weekend plans\n\nalpha beta gamma delta epsilon zeta eta theta iota kappa\n",
            ),
        ]);
        let response = vault
            .v2_search(V2SearchRequest {
                query: "gardening".to_string(),
                mode: V2SearchMode::Default,
                limit: 10,
                overlays: Vec::new(),
            })
            .unwrap();

        let paths = response.hits.iter().map(|hit| hit.path.as_str()).collect::<Vec<_>>();
        assert_eq!(paths, ["tagged.md", "body.md"]);
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
                source_hash: tansu_note_core::source_hash(content),
            })
            .unwrap();

        assert!(matches!(
            response.outcome,
            V2MutationOutcome::Accepted { result: Some(_) }
        ));
        let status = vault.lock_catalog().search_status().unwrap();
        assert!(status.dirty);
        assert!(status.degraded);
    }

    #[test]
    fn save_after_external_write_before_watcher_reconcile_preserves_external_bytes() {
        let vault = test_vault();
        let created = v2_create(&vault, "A.md", "# A\n\nbase\n");
        fs::write(vault.root.join("A.md"), "# A\n\nexternal\n").unwrap();

        let result = v2_save(&vault, &created, "save-local", "# A\n\nlocal draft\n").unwrap();

        assert!(matches!(result.outcome, V2MutationOutcome::Conflict { .. }));
        assert_eq!(
            fs::read(vault.root.join("A.md")).unwrap(),
            b"# A\n\nexternal\n"
        );
        assert_eq!(
            vault.v2_open_note(&created.note_id).unwrap().content,
            "# A\n\nexternal\n"
        );
    }

    #[test]
    fn no_op_open_search_and_save_preserve_exact_disk_bytes() {
        let bytes = b"\xef\xbb\xbf# A\r\none\nlast\r";
        let vault = test_vault_with_bytes("A.md", bytes);
        let note = vault.v2_notes().unwrap().remove(0);
        let opened = vault.v2_open_note(&note.note_id).unwrap();
        assert_eq!(opened.content, "\u{feff}# A\none\nlast\n");
        vault
            .v2_search(V2SearchRequest {
                query: "A".to_string(),
                mode: V2SearchMode::Default,
                limit: 10,
                overlays: Vec::new(),
            })
            .unwrap();
        v2_save(&vault, &opened.meta, "save-noop", &opened.content).unwrap();

        assert_eq!(fs::read(vault.root.join("A.md")).unwrap(), bytes);
    }

    #[test]
    fn v2_create_save_retry_and_conflict_preserve_mutation_identity_and_events() {
        let vault = test_vault();
        let created_content = "\u{feff}# A\nold\n";
        let create = V2CreateNoteRequest {
            mutation_id: "create-1".to_string(),
            path: "A.md".to_string(),
            content: created_content.to_string(),
            source_hash: tansu_note_core::source_hash(created_content),
        };
        let created = vault.v2_create_note(create.clone()).unwrap();
        let V2MutationOutcome::Accepted { result: Some(meta) } = &created.outcome else {
            panic!("create did not return an accepted note");
        };
        assert_eq!(
            fs::read(vault.root.join("A.md")).unwrap(),
            created_content.as_bytes()
        );
        let retried = vault.v2_create_note(create.clone()).unwrap();
        assert_eq!(
            serde_json::to_value(&created).unwrap(),
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
            source_hash: tansu_note_core::source_hash(content),
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
            source_hash: tansu_note_core::source_hash("different"),
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
            source_hash: tansu_note_core::source_hash(stale_content),
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
                source_hash: tansu_note_core::source_hash(first_content),
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
                    source_hash: tansu_note_core::source_hash(changed),
                },
            )
            .unwrap();
        let first_revision = vault
            .lock_catalog()
            .revisions(&created.note_id)
            .unwrap()
            .into_iter()
            .find(|revision| revision.content_hash.as_deref() == Some(&tansu_note_core::source_hash(first_content)))
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
                source_hash: tansu_note_core::source_hash(first_content),
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
                    source_hash: tansu_note_core::source_hash(accepted_content),
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
                    source_hash: tansu_note_core::source_hash(draft_content),
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
                source_hash: tansu_note_core::source_hash(content),
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

        };
        let vault = VaultRuntime::open(
            0,
            &config,
            LogHub::new(crate::logging::LogMode::Off),
        )
        .unwrap();
        let row = vault.lock_catalog().all_rows().unwrap().remove(0);
        let candidate = "# A\naccepted before crash\n";
        let source_hash = tansu_note_core::source_hash(candidate);
        let disk_bytes = candidate.as_bytes();
        let disk_hash = tansu_note_core::disk_hash(disk_bytes);
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
    fn startup_fails_on_malformed_persisted_tags() {
        let dir = tempfile::tempdir().unwrap().keep();
        let state_path = dir.join("state");
        fs::write(dir.join("A.md"), "# A\n").unwrap();
        let config = VaultConfig {
            name: "Test".to_string(),
            path: dir.clone(),
            state_path: state_path.clone(),
        };
        let vault = VaultRuntime::open(0, &config, LogHub::new(crate::logging::LogMode::Off)).unwrap();
        drop(vault);
        rusqlite::Connection::open(state_path.join("vault.db"))
            .unwrap()
            .execute("UPDATE notes SET tags_json='[not json'", [])
            .unwrap();

        assert!(VaultRuntime::open(0, &config, LogHub::new(crate::logging::LogMode::Off)).is_err());
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

        };
        let vault = VaultRuntime::open(
            0,
            &config,
            LogHub::new(crate::logging::LogMode::Off),
        )
        .unwrap();
        let row = vault.lock_catalog().all_rows().unwrap().remove(0);
        let candidate = "# A\naccepted before crash\n";
        let source_hash = tansu_note_core::source_hash(candidate);
        let disk_bytes = candidate.as_bytes();
        let disk_hash = tansu_note_core::disk_hash(disk_bytes);
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
                source_hash: tansu_note_core::source_hash(content),
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
                        source_hash: tansu_note_core::source_hash(content),
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
                        source_hash: tansu_note_core::source_hash("# Created\ncreated\n"),
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
        let created = v2_create(&vault, "A.md", "# A\nold\n");
        let row = vault
            .lock_catalog()
            .note_row_by_id(&created.note_id)
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
        let source_hash = tansu_note_core::source_hash(candidate);
        let disk_bytes = candidate.as_bytes();
        let disk_hash = tansu_note_core::disk_hash(disk_bytes);
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
                "payload",
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
    fn watcher_reconciliation_crash_replays_resync_after_restart() {
        let vault = test_vault();
        let baseline = vault.subscribe_v2_events(None).unwrap().current_version;
        let config = VaultConfig {
            name: vault.name.clone(),
            path: vault.root.clone(),
            state_path: vault.state_root.clone(),

        };
        fs::write(vault.root.join("outside.md"), "# Outside\n\nedit\n").unwrap();
        crate::failure_point::inject(
            crate::failure_point::FailurePoint::WatcherReconciled,
        );
        assert!(vault.reconcile_from_watcher().is_err());
        let interrupted = vault.subscribe_v2_events(Some(baseline)).unwrap();
        assert!(interrupted.resync_required);
        assert!(interrupted.replay.is_empty());
        drop(vault);

        let restarted = VaultRuntime::open(
            0,
            &config,
            LogHub::new(crate::logging::LogMode::Off),
        )
        .unwrap();
        let replay = restarted.subscribe_v2_events(Some(baseline)).unwrap();

        assert!(replay.replay.iter().any(|event| {
            event.payload["update"]["kind"] == "resyncRequired"
        }));
    }

    #[test]
    fn edited_source_keeps_bom_and_untouched_mixed_line_endings() {
        let vault = test_vault_with_bytes("A.md", b"\xef\xbb\xbf# A\r\none\nlast\r");
        let note = vault.v2_notes().unwrap().remove(0);
        let opened = vault.v2_open_note(&note.note_id).unwrap();
        let saved = v2_save(&vault, &opened.meta, "save-edit", "\u{feff}# A\nchanged\nlast\n").unwrap();

        assert!(matches!(saved.outcome, V2MutationOutcome::Accepted { .. }));
        assert_eq!(
            vault.v2_open_note(&note.note_id).unwrap().content,
            "\u{feff}# A\nchanged\nlast\n"
        );
        assert_eq!(
            fs::read(vault.root.join("A.md")).unwrap(),
            b"\xef\xbb\xbf# A\r\nchanged\nlast\r"
        );
    }

    #[test]
    fn invalid_utf8_is_unresolved_and_read_only() {
        let invalid_bytes = [0xff, 0xfe, 0x61];
        let vault = test_vault_with_bytes("Bad.md", b"# Bad\n");
        let note_id = vault.lock_catalog().all_rows().unwrap().remove(0).meta.note_id;
        fs::write(vault.root.join("Bad.md"), invalid_bytes).unwrap();
        let error = vault.v2_open_note(&note_id).unwrap_err();
        assert!(matches!(
            &error,
            V2VaultError::Api(V2ApiErrorKind::UnresolvedNote {
                note_id: error_note_id,
                reason: UnresolvedReason::InvalidUtf8,
            }) if error_note_id == &note_id
        ), "unexpected error: {error:?}");
        let row = vault.lock_catalog().all_rows().unwrap().remove(0);
        assert_eq!(row.state, NoteState::Unresolved(UnresolvedReason::InvalidUtf8));
        assert_eq!(fs::read(vault.root.join("Bad.md")).unwrap(), invalid_bytes);
    }

    #[test]
    fn delta_save_writes_snapshot_and_disk_bytes() {
        let vault = test_vault();
        let created = v2_create(&vault, "A.md", "# A\n\nbase\n");
        let response = vault
            .v2_save_note_delta(&created.note_id, v2_delta(&created, "delta-1", "changed", "# A\n\nchanged\n"))
            .unwrap();

        let V2MutationOutcome::Accepted { result: Some(meta) } = response.outcome else {
            panic!("expected accepted delta save");
        };
        assert_eq!(
            history::read_snapshot(&vault.state_root, &created.note_id, &meta.source_hash).unwrap(),
            "# A\n\nchanged\n"
        );
        assert_eq!(
            fs::read_to_string(vault.root.join("A.md")).unwrap(),
            "# A\n\nchanged\n"
        );
    }

    #[test]
    fn stale_delta_save_creates_conflict_draft_from_reconstructed_content() {
        let vault = test_vault();
        let created = v2_create(&vault, "A.md", "# A\n\nbase\n");
        v2_save(&vault, &created, "save-accepted", "# A\n\naccepted\n").unwrap();
        let response = vault
            .v2_save_note_delta(&created.note_id, v2_delta(&created, "delta-stale", "stale", "# A\n\nstale\n"))
            .unwrap();

        let V2MutationOutcome::Conflict { draft, .. } = response.outcome else {
            panic!("expected save conflict");
        };
        let draft = vault.v2_open_conflict_draft(&created.note_id, draft.draft_id).unwrap();
        assert_eq!(draft.content, "# A\n\nstale\n");
    }

    #[test]
    fn delta_hash_mismatch_mutates_nothing() {
        let vault = test_vault();
        let created = v2_create(&vault, "A.md", "# A\n\nbase\n");
        let result = vault.v2_save_note_delta(
            &created.note_id,
            v2_delta(&created, "delta-bad", "changed", "# wrong\n"),
        );
        let error = result.unwrap_err();
        match &error {
            V2VaultError::Api(V2ApiErrorKind::SourceHashMismatch { expected, received }) => {
                assert_eq!(expected, &tansu_note_core::source_hash("# A\n\nchanged\n"));
                assert_eq!(received, &tansu_note_core::source_hash("# wrong\n"));
            }
            _ => panic!("expected source hash mismatch, got {error:?}"),
        }

        let opened = vault.v2_open_note(&created.note_id).unwrap();
        assert_eq!(opened.content, "# A\n\nbase\n");
        assert_eq!(opened.meta.revision, created.revision);
    }

    #[test]
    fn uploaded_images_are_vault_scoped_assets() {
        let vault = test_vault();
        let uploaded = vault.v2_upload_image("upload-1", b"webp").unwrap();

        assert!(uploaded.name.starts_with("z-images/"));
        assert_eq!(vault.read_asset(&uploaded.name).unwrap(), b"webp");
        assert!(vault.read_asset("../bad.webp").is_err());
    }

    #[test]
    fn prepared_image_upload_survives_restart_and_retry() {
        let dir = tempfile::tempdir().unwrap().keep();
        let state_path = dir.join("state");
        let config = VaultConfig {
            name: "Test".to_string(),
            path: dir.clone(),
            state_path: state_path.clone(),

        };
        let bytes = b"webp";
        let mutation_id = "interrupted-image-upload";
        let body_hash = tansu_note_core::disk_hash(bytes);
        let payload_hash = v2_request_hash("image_upload", None, &body_hash).unwrap();
        let digest = tansu_note_core::disk_hash(mutation_id.as_bytes());
        let name = format!(
            "z-images/image-{}.webp",
            digest.strip_prefix("blake3-v2:").unwrap()
        );
        let initial = VaultRuntime::open(
            0,
            &config,
            LogHub::new(crate::logging::LogMode::Off),
        )
        .unwrap();
        drop(initial);
        let mut catalog = Catalog::open(&state_path.join("vault.db")).unwrap();
        catalog
            .prepare_mutation(MutationIntent {
                mutation_id,
                payload_hash: &payload_hash,
                kind: "image_upload",
                note_id: None,
                path: Some(&name),
                old_path: None,
                expected_disk_hash: None,
                source_hash: None,
                disk_hash: Some(&body_hash),
            })
            .unwrap();
        write_vault_asset_new(&dir, &name, bytes).unwrap();
        drop(catalog);

        let restarted = VaultRuntime::open(
            0,
            &config,
            LogHub::new(crate::logging::LogMode::Off),
        )
        .unwrap();
        let response = restarted.v2_upload_image(mutation_id, bytes).unwrap();

        assert_eq!(response.name, name);
        assert_eq!(restarted.read_asset(&response.name).unwrap(), bytes);
        assert_eq!(
            restarted.lock_catalog().mutation(mutation_id).unwrap().unwrap().state,
            "accepted"
        );
    }

    #[test]
    fn configured_state_survives_restart_outside_vault() {
        let dir = tempfile::tempdir().unwrap().keep();
        fs::write(dir.join("A.md"), "# A\n").unwrap();
        let config = config_for(&dir, dir.join("state"));
        let vault = VaultRuntime::open(
            0,
            &config,
            LogHub::new(crate::logging::LogMode::Off),
        )
        .unwrap();
        let first_note_id = vault.v2_vault_bootstrap().unwrap().notes[0].note_id.clone();
        drop(vault);

        let reopened = VaultRuntime::open(
            0,
            &config,
            LogHub::new(crate::logging::LogMode::Off),
        )
        .unwrap();

        assert_eq!(reopened.v2_vault_bootstrap().unwrap().notes[0].note_id, first_note_id);
    }

    fn config_for(root: &Path, state_path: PathBuf) -> VaultConfig {
        VaultConfig {
            name: "Test".to_string(),
            path: root.to_path_buf(),
            state_path,
        }
    }

    #[test]
    fn second_open_of_the_same_root_is_rejected_until_the_owner_drops() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let state = tempfile::tempdir().unwrap();
        let logs = || LogHub::new(crate::logging::LogMode::Off);

        let owner =
            VaultRuntime::open(0, &config_for(&root, state.path().join("first")), logs()).unwrap();
        let rejected =
            VaultRuntime::open(1, &config_for(&root, state.path().join("second")), logs());
        assert!(matches!(
            rejected,
            Err(Error::VaultAlreadyOwned { root: ref rejected_root }) if *rejected_root == root
        ));
        assert!(!state.path().join("second").join("vault.db").exists());

        drop(owner);
        VaultRuntime::open(0, &config_for(&root, state.path().join("second")), logs()).unwrap();
    }

    #[test]
    fn dropping_a_runtime_with_started_workers_releases_the_vault_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let state = tempfile::tempdir().unwrap();
        let logs = || LogHub::new(crate::logging::LogMode::Off);

        let runtime = Arc::new(
            VaultRuntime::open(0, &config_for(&root, state.path().join("first")), logs()).unwrap(),
        );
        runtime.start_search_worker().unwrap();
        runtime.start_watcher().unwrap();
        assert_eq!(Arc::strong_count(&runtime), 1);
        drop(runtime);

        VaultRuntime::open(0, &config_for(&root, state.path().join("second")), logs()).unwrap();
    }

    #[test]
    fn watcher_trigger_burst_leaves_one_pending_notification() {
        let (trigger, events) = watcher_trigger();
        for _ in 0..10_000 {
            trigger.notify();
        }

        assert!(events.try_recv().is_ok());
        assert!(matches!(events.try_recv(), Err(TryRecvError::Empty)));
    }

    #[test]
    fn watcher_trigger_burst_during_reconcile_causes_exactly_one_follow_up() {
        let (trigger, events) = watcher_trigger();
        let stop = StopSignal::new();
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let reconciles = Arc::new(AtomicU64::new(0));
        let worker_reconciles = Arc::clone(&reconciles);
        let worker_stop = Arc::clone(&stop);
        let worker = thread::spawn(move || {
            drain_watcher_triggers(&events, &worker_stop, || {
                if worker_reconciles.fetch_add(1, Ordering::SeqCst) == 0 {
                    started_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                } else {
                    started_tx.send(()).unwrap();
                }
                ControlFlow::Continue(())
            });
        });

        trigger.notify();
        started_rx.recv().unwrap();
        for _ in 0..10_000 {
            trigger.notify();
        }
        release_tx.send(()).unwrap();
        started_rx.recv().unwrap();
        drop(trigger);
        worker.join().unwrap();

        assert_eq!(reconciles.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn shutdown_joins_both_workers_while_other_handles_remain() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let state = tempfile::tempdir().unwrap();
        let runtime = Arc::new(
            VaultRuntime::open(
                0,
                &config_for(&root, state.path().join("state")),
                LogHub::new(crate::logging::LogMode::Off),
            )
            .unwrap(),
        );
        runtime.start_search_worker().unwrap();
        runtime.start_watcher().unwrap();
        let other_handle = Arc::clone(&runtime);

        runtime.shutdown();

        assert!(matches!(
            runtime.search_tx.try_send(SearchCommand::Run(SearchJob::Rebuild)),
            Err(TrySendError::Disconnected(_))
        ));
        assert!(matches!(runtime.start_watcher(), Err(Error::Internal(_))));
        assert!(matches!(runtime.start_search_worker(), Err(Error::Internal(_))));
        runtime.shutdown();
        drop(other_handle);
    }

    #[test]
    fn a_failed_watcher_start_leaves_no_running_watcher_and_drop_stops_the_search_worker() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let state = tempfile::tempdir().unwrap();
        let logs = || LogHub::new(crate::logging::LogMode::Off);
        let runtime = Arc::new(
            VaultRuntime::open(0, &config_for(&root, state.path().join("first")), logs()).unwrap(),
        );
        runtime.start_search_worker().unwrap();
        fs::remove_dir_all(&root).unwrap();
        assert!(runtime.start_watcher().is_err());
        assert!(matches!(
            runtime.lock_workers().watcher,
            WatcherWorkerSlot::Idle
        ));
        drop(runtime);

        VaultRuntime::open(0, &config_for(&root, state.path().join("second")), logs()).unwrap();
    }

    #[test]
    fn watcher_reconciliation_errors_are_logged() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        fs::create_dir(&root).unwrap();
        let state = tempfile::tempdir().unwrap();
        let logs = LogHub::new(crate::logging::LogMode::Buffer);
        let runtime = Arc::new(
            VaultRuntime::open(
                0,
                &config_for(&root, state.path().join("state")),
                logs.clone(),
            )
            .unwrap(),
        );
        let events = logs.subscribe().unwrap();
        runtime.start_watcher().unwrap();
        let operation = runtime.lock_op();
        fs::remove_dir(&root).unwrap();
        fs::write(&root, b"not a directory").unwrap();
        if let WatcherWorkerSlot::Running(worker) = &runtime.lock_workers().watcher {
            worker.wake.notify();
        } else {
            panic!("watcher did not start");
        }
        drop(operation);

        let event = events.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(event.level, LogLevel::Error);
        assert_eq!(event.fields["system"]["component"], "watcher");
        assert_eq!(event.fields["system"]["action"], "reconcile_error");
        assert!(event.fields["error"].as_str().is_some_and(|error| !error.is_empty()));
    }

    #[test]
    fn second_open_through_a_symlinked_root_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        fs::create_dir(&root).unwrap();
        let alias = dir.path().join("alias");
        std::os::unix::fs::symlink(&root, &alias).unwrap();
        let state = tempfile::tempdir().unwrap();
        let logs = || LogHub::new(crate::logging::LogMode::Off);

        let _owner =
            VaultRuntime::open(0, &config_for(&root, state.path().join("first")), logs()).unwrap();
        let rejected =
            VaultRuntime::open(1, &config_for(&alias, state.path().join("second")), logs());
        assert!(matches!(rejected, Err(Error::VaultAlreadyOwned { .. })));
    }

    #[test]
    fn saved_search_weights_change_the_next_search_ranking() {
        let vault = test_vault_with_notes(&[
            ("title.md", "# needle\nplain\n"),
            ("body.md", "# other\nneedle needle needle\n"),
        ]);
        let order = |vault: &VaultRuntime| {
            vault
                .v2_search(V2SearchRequest {
                    query: "needle".to_string(),
                    mode: V2SearchMode::Default,
                    limit: 10,
                    overlays: Vec::new(),
                })
                .unwrap()
                .hits
                .into_iter()
                .map(|hit| hit.path)
                .collect::<Vec<_>>()
        };
        assert_eq!(order(&vault), ["title.md", "body.md"]);
        vault
            .v2_save_settings(V2SettingsRequest {
                mutation_id: "weights".to_string(),
                settings: Settings {
                    search_title_weight: 0.0,
                    search_heading_weight: 0.0,
                    search_content_weight: 50.0,
                    ..Settings::default()
                },
            })
            .unwrap();
        assert_eq!(order(&vault), ["body.md", "title.md"]);
    }

    fn note_id_at(vault: &VaultRuntime, path: &str) -> String {
        vault
            .lock_catalog()
            .live_notes()
            .unwrap()
            .into_iter()
            .find(|note| note.path == path)
            .unwrap()
            .note_id
    }

    #[test]
    fn v2_note_links_report_backlinks_and_outgoing_by_note_id() {
        let vault = test_vault_with_notes(&[
            ("A.md", "# A\nSee [[B]] and [again](B.md) here.\n[[Same]] [[Missing]]\n"),
            ("B.md", "# B\nBack to [[/A|a]].\n"),
            ("C.md", "# C\nNothing.\n"),
            ("Same.md", "# Same\n"),
        ]);
        fs::create_dir_all(vault.root.join("x")).unwrap();
        fs::write(vault.root.join("x/Same.md"), "# Same two\n").unwrap();
        vault.reconcile_from_watcher().unwrap();

        let b = note_id_at(&vault, "B.md");
        let links = vault.v2_note_links(&b).unwrap();
        assert_eq!(links.backlinks.len(), 1);
        assert_eq!(links.backlinks[0].note.path, "A.md");
        assert_eq!(links.backlinks[0].mentions.len(), 2);
        assert_eq!(links.outgoing.iter().map(|n| n.path.as_str()).collect::<Vec<_>>(), vec!["A.md"]);

        let a = note_id_at(&vault, "A.md");
        let a_links = vault.v2_note_links(&a).unwrap();
        assert_eq!(a_links.outgoing.iter().map(|n| n.path.as_str()).collect::<Vec<_>>(), vec!["B.md"]);
        assert!(vault.v2_note_links("missing").is_err());
    }

    #[test]
    fn v2_note_links_keep_backlink_after_source_rename() {
        let vault = test_vault_with_notes(&[("A.md", "# A\n[[B]]\n"), ("B.md", "# B\n")]);
        let a = vault.v2_open_note(&note_id_at(&vault, "A.md")).unwrap();
        vault
            .v2_rename_note(
                &a.meta.note_id,
                V2RenameNoteRequest {
                    mutation_id: "rename-a".to_string(),
                    precondition: V2NotePrecondition {
                        base_revision: a.meta.revision,
                        base_source_hash: a.meta.source_hash.clone(),
                        base_disk_hash: a.meta.disk_hash.clone(),
                    },
                    path: "nested/A2.md".to_string(),
                },
            )
            .unwrap();

        let links = vault.v2_note_links(&note_id_at(&vault, "B.md")).unwrap();
        assert_eq!(links.backlinks.len(), 1);
        assert_eq!(links.backlinks[0].note.note_id, a.meta.note_id);
        assert_eq!(links.backlinks[0].note.path, "nested/A2.md");
    }

    #[test]
    fn v2_note_links_ignore_ambiguous_targets() {
        let vault = test_vault_with_notes(&[("A.md", "# A\n[[Same]]\n"), ("Same.md", "# Same\n")]);
        fs::create_dir_all(vault.root.join("x")).unwrap();
        fs::write(vault.root.join("x/Same.md"), "# Same two\n").unwrap();
        vault.reconcile_from_watcher().unwrap();
        let a = note_id_at(&vault, "A.md");
        assert!(vault.v2_note_links(&a).unwrap().outgoing.is_empty());
    }

    #[test]
    fn v2_note_preview_strips_frontmatter() {
        let vault = test_vault_with_note("A.md", "---\ntags: [x]\n---\n# A\nbody\n");
        let preview = vault.v2_note_preview(&note_id_at(&vault, "A.md")).unwrap();
        assert_eq!(preview.preview, "# A body");
    }

    fn test_vault_with_note(path: &str, content: &str) -> VaultRuntime {
        test_vault_with_notes(&[(path, content)])
    }

    fn test_vault_with_notes(notes: &[(&str, &str)]) -> VaultRuntime {
        let dir = tempfile::tempdir().unwrap().keep();
        for (path, content) in notes {
            fs::write(dir.join(path), content).unwrap();
        }
        let state_path = dir.join("state");
        VaultRuntime::open(
            0,
            &VaultConfig {
                name: "Test".to_string(),
                path: dir.clone(),
                state_path,
            },
            LogHub::new(crate::logging::LogMode::Off),
        )
        .unwrap()
    }

    fn test_vault_with_bytes(path: &str, bytes: &[u8]) -> VaultRuntime {
        let dir = tempfile::tempdir().unwrap().keep();
        fs::write(dir.join(path), bytes).unwrap();
        VaultRuntime::open(
            0,
            &VaultConfig {
                name: "Test".to_string(),
                path: dir.clone(),
                state_path: dir.join("state"),
            },
            LogHub::new(crate::logging::LogMode::Off),
        )
        .unwrap()
    }

    fn v2_create(vault: &VaultRuntime, path: &str, content: &str) -> V2NoteMeta {
        let response = vault
            .v2_create_note(V2CreateNoteRequest {
                mutation_id: format!("create-{path}"),
                path: path.to_string(),
                content: content.to_string(),
                source_hash: tansu_note_core::source_hash(content),
            })
            .unwrap();
        let V2MutationOutcome::Accepted { result: Some(meta) } = response.outcome else {
            panic!("expected accepted create");
        };
        meta
    }

    fn v2_precondition(meta: &V2NoteMeta) -> V2NotePrecondition {
        V2NotePrecondition {
            base_revision: meta.revision,
            base_source_hash: meta.source_hash.clone(),
            base_disk_hash: meta.disk_hash.clone(),
        }
    }

    fn v2_save(
        vault: &VaultRuntime,
        base: &V2NoteMeta,
        mutation_id: &str,
        content: &str,
    ) -> V2Result<V2MutationResponse> {
        vault.v2_save_note(
            &base.note_id,
            V2SaveNoteRequest {
                mutation_id: mutation_id.to_string(),
                precondition: v2_precondition(base),
                content: content.to_string(),
                source_hash: tansu_note_core::source_hash(content),
            },
        )
    }

    fn v2_delta(base: &V2NoteMeta, mutation_id: &str, text: &str, result: &str) -> V2SaveNoteDeltaRequest {
        V2SaveNoteDeltaRequest {
            mutation_id: mutation_id.to_string(),
            precondition: v2_precondition(base),
            source_hash: tansu_note_core::source_hash(result),
            edits: vec![TextEdit {
                start: TextPosition { line: 2, character: 0 },
                end: TextPosition { line: 2, character: 4 },
                text: text.to_string(),
            }],
        }
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
            },
            LogHub::new(crate::logging::LogMode::Off),
        )
        .unwrap()
    }
}
