use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crate::error::SearchError;
use crate::index::{IndexManager, IndexMutation};
use crate::overlay;
use crate::search;
use crate::types::{
    DirtyNoteSnapshot, DocumentInput, NoteIdentity, OverlaySearchResult, SearchOptions,
    SearchResult, SearchStatus, UpdateOutcome,
};

const INDEX_QUEUE_CAPACITY: usize = 128;
const MAX_INDEX_BATCH: usize = 256;
pub const MAX_REBUILD_NOTES: usize = 10_000;
pub const MAX_REBUILD_SOURCE_BYTES: usize = 128 * 1024 * 1024;
const WRITER_IDLE_TIMEOUT: Duration = Duration::from_secs(10);
const COALESCE_TIMEOUT: Duration = Duration::from_millis(4);

pub struct SearchService {
    sender: SyncSender<Message>,
    worker: Mutex<Option<JoinHandle<()>>>,
    state: Arc<SharedState>,
}

struct SharedState {
    dirty: AtomicBool,
    degraded: AtomicBool,
    needs_reconciliation: AtomicBool,
}

enum Message {
    Change {
        mutation: IndexMutation,
        reply: mpsc::SyncSender<Result<UpdateOutcome, SearchError>>,
    },
    Search {
        query: String,
        options: SearchOptions,
        current: Vec<NoteIdentity>,
        reply: mpsc::SyncSender<Result<Vec<SearchResult>, SearchError>>,
    },
    IsCurrent {
        identities: Vec<NoteIdentity>,
        reply: mpsc::SyncSender<Result<bool, SearchError>>,
    },
    Rebuild {
        documents: Vec<DocumentInput>,
        reply: mpsc::SyncSender<Result<(), SearchError>>,
    },
    Shutdown,
}

struct PendingChange {
    mutation: IndexMutation,
    replies: Vec<mpsc::SyncSender<Result<UpdateOutcome, SearchError>>>,
    stale_replies: Vec<mpsc::SyncSender<Result<UpdateOutcome, SearchError>>>,
}

impl SearchService {
    pub fn open(path: &Path) -> Result<Self, SearchError> {
        recover_backup(path)?;
        ensure_search_directory(path)?;
        let (index, recovered) = match IndexManager::open(path) {
            Ok(index) if index.metadata_initialized() => (index, false),
            Ok(mut index) => {
                index.initialize_metadata()?;
                index.close_writer();
                (index, false)
            }
            Err(
                SearchError::SchemaMismatch
                | SearchError::CorruptIndex
                | SearchError::IndexOpen { .. },
            ) => {
                (replace_index(path, &[])?, true)
            }
            Err(error) => return Err(error),
        };
        let latest = index
            .identities()?
            .into_iter()
            .map(|identity| (identity.note_id().to_owned(), (identity.revision(), false)))
            .collect();
        let state = Arc::new(SharedState {
            dirty: AtomicBool::new(recovered),
            degraded: AtomicBool::new(recovered),
            needs_reconciliation: AtomicBool::new(recovered),
        });
        let (sender, receiver) = mpsc::sync_channel(INDEX_QUEUE_CAPACITY);
        let worker_state = Arc::clone(&state);
        let worker_path = path.to_path_buf();
        let worker = thread::Builder::new()
            .name("tansu-search-index".into())
            .spawn(move || worker_loop(index, &worker_path, receiver, worker_state, latest))?;
        Ok(Self {
            sender,
            worker: Mutex::new(Some(worker)),
            state,
        })
    }

    pub fn status(&self) -> SearchStatus {
        SearchStatus {
            dirty: self.state.dirty.load(Ordering::Acquire),
            degraded: self.state.degraded.load(Ordering::Acquire),
        }
    }

    fn worker_stopped(&self) -> SearchError {
        self.state.dirty.store(true, Ordering::Release);
        self.state.degraded.store(true, Ordering::Release);
        self.state
            .needs_reconciliation
            .store(true, Ordering::Release);
        SearchError::WorkerStopped
    }

    pub fn needs_reconciliation(&self) -> bool {
        self.state.needs_reconciliation.load(Ordering::Acquire)
    }

    pub fn upsert(&self, input: DocumentInput) -> Result<UpdateOutcome, SearchError> {
        self.change(IndexMutation::Upsert(input))
    }

    pub fn remove(
        &self,
        note_id: String,
        revision: i64,
    ) -> Result<UpdateOutcome, SearchError> {
        self.change(IndexMutation::Delete { note_id, revision })
    }

    fn change(&self, mutation: IndexMutation) -> Result<UpdateOutcome, SearchError> {
        self.state.dirty.store(true, Ordering::Release);
        let (reply, response) = mpsc::sync_channel(1);
        match self.sender.try_send(Message::Change { mutation, reply }) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                self.state
                    .needs_reconciliation
                    .store(true, Ordering::Release);
                return Ok(UpdateOutcome::Overflow);
            }
            Err(TrySendError::Disconnected(_)) => {
                self.state.degraded.store(true, Ordering::Release);
                self.state
                    .needs_reconciliation
                    .store(true, Ordering::Release);
                return Err(SearchError::WorkerStopped);
            }
        }
        match response.recv().map_err(|_| self.worker_stopped())? {
            Ok(outcome) => Ok(outcome),
            Err(error) => {
                self.state.dirty.store(true, Ordering::Release);
                self.state.degraded.store(true, Ordering::Release);
                self.state
                    .needs_reconciliation
                    .store(true, Ordering::Release);
                Err(error)
            }
        }
    }

    pub fn search(
        &self,
        query: String,
        options: SearchOptions,
        current: Vec<NoteIdentity>,
    ) -> Result<Vec<SearchResult>, SearchError> {
        let (reply, response) = mpsc::sync_channel(1);
        self.sender
            .send(Message::Search {
                query,
                options,
                current,
                reply,
            })
            .map_err(|_| self.worker_stopped())?;
        response.recv().map_err(|_| self.worker_stopped())?
    }

    pub fn search_with_overlay(
        &self,
        query: String,
        options: SearchOptions,
        current: Vec<NoteIdentity>,
        snapshots: &[DirtyNoteSnapshot],
    ) -> Result<OverlaySearchResult, SearchError> {
        let mut canonical = self.search(query.clone(), options, current)?;
        let overlay_result = overlay::search(&query, options, snapshots)?;
        canonical.retain(|hit| !overlay_result.covered_note_ids.contains(&hit.note_id));
        canonical.extend(overlay_result.result.hits);
        canonical.sort_by(|left, right| {
            right
                .score
                .partial_cmp(&left.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| left.path.cmp(&right.path))
                .then_with(|| left.note_id.cmp(&right.note_id))
        });
        canonical.truncate(options.limit.get());
        Ok(OverlaySearchResult { hits: canonical })
    }

    pub fn is_current(&self, identities: Vec<NoteIdentity>) -> Result<bool, SearchError> {
        let (reply, response) = mpsc::sync_channel(1);
        self.sender
            .send(Message::IsCurrent { identities, reply })
            .map_err(|_| self.worker_stopped())?;
        response.recv().map_err(|_| self.worker_stopped())?
    }

    pub fn rebuild(&self, documents: Vec<DocumentInput>) -> Result<(), SearchError> {
        check_rebuild_bounds(&documents)?;
        self.state.dirty.store(true, Ordering::Release);
        let (reply, response) = mpsc::sync_channel(1);
        self.sender
            .send(Message::Rebuild { documents, reply })
            .map_err(|_| self.worker_stopped())?;
        match response.recv().map_err(|_| self.worker_stopped())? {
            Ok(()) => Ok(()),
            Err(error) => {
                self.state.dirty.store(true, Ordering::Release);
                self.state.degraded.store(true, Ordering::Release);
                self.state
                    .needs_reconciliation
                    .store(true, Ordering::Release);
                Err(error)
            }
        }
    }
}

impl Drop for SearchService {
    fn drop(&mut self) {
        let _ = self.sender.send(Message::Shutdown);
        if let Some(worker) = self
            .worker
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            let _ = worker.join();
        }
    }
}

fn worker_loop(
    mut index: IndexManager,
    path: &Path,
    receiver: Receiver<Message>,
    state: Arc<SharedState>,
    mut latest: HashMap<String, (i64, bool)>,
) {
    let mut deferred = VecDeque::new();
    loop {
        let message = match deferred.pop_front() {
            Some(message) => Ok(message),
            None => receiver.recv_timeout(WRITER_IDLE_TIMEOUT),
        };
        let message = match message {
            Ok(message) => message,
            Err(RecvTimeoutError::Timeout) => {
                index.close_writer();
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => return,
        };
        match message {
            Message::Change { mutation, reply } => {
                let mut updates = vec![(mutation, reply)];
                collect_changes(&receiver, &mut deferred, &mut updates);
                let mut next_latest = latest.clone();
                let (mutations, outcomes) = coalesce_changes(updates, &mut next_latest);
                match index.apply_batch(&mutations) {
                    Ok(applied) => {
                        latest = next_latest;
                        for (outcome, result) in outcomes.into_iter().zip(applied) {
                            let _ = outcome.send(Ok(if result {
                                UpdateOutcome::Applied
                            } else {
                                UpdateOutcome::Stale
                            }));
                        }
                        if !state.needs_reconciliation.load(Ordering::Acquire) {
                            state.dirty.store(false, Ordering::Release);
                        }
                    }
                    Err(error) => {
                        state.dirty.store(true, Ordering::Release);
                        state.degraded.store(true, Ordering::Release);
                        state
                            .needs_reconciliation
                            .store(true, Ordering::Release);
                        let mut primary = Some(error);
                        for reply in outcomes {
                            let error = primary.take().unwrap_or(SearchError::WorkerStopped);
                            let _ = reply.send(Err(error));
                        }
                    }
                }
            }
            Message::Search {
                query,
                options,
                current,
                reply,
            } => {
                let result = search::execute(&index, &query, options).map(|mut hits| {
                    let canonical = current
                        .iter()
                        .map(|identity| (identity.note_id(), identity))
                        .collect::<HashMap<_, _>>();
                    hits.retain(|hit| {
                        canonical.get(hit.note_id.as_str()).is_some_and(|identity| {
                            hit.revision == identity.revision()
                                && hit.source_hash == identity.source_hash()
                                && hit.path == identity.path()
                                && hit.title == identity.title()
                        })
                    });
                    search::rank_hits(
                        &mut hits,
                        |hit| canonical.get(hit.note_id.as_str()).map_or(0, |identity| identity.updated_at_ms()),
                        &options,
                    );
                    hits
                });
                if let Err(error) = &result {
                    mark_search_failure(&state, error);
                }
                let _ = reply.send(result);
            }
            Message::IsCurrent { identities, reply } => {
                let _ = reply.send(index.is_current(&identities));
            }
            Message::Rebuild { documents, reply } => {
                match rebuild_index(&mut index, path, &documents) {
                    Ok(()) => {
                        latest = documents
                            .iter()
                            .map(|document| {
                                (
                                    document.note_id().to_owned(),
                                    (document.revision(), false),
                                )
                            })
                            .collect();
                        state.dirty.store(false, Ordering::Release);
                        state.degraded.store(false, Ordering::Release);
                        state
                            .needs_reconciliation
                            .store(false, Ordering::Release);
                        let _ = reply.send(Ok(()));
                    }
                    Err(error) => {
                        state.dirty.store(true, Ordering::Release);
                        state.degraded.store(true, Ordering::Release);
                        state
                            .needs_reconciliation
                            .store(true, Ordering::Release);
                        let _ = reply.send(Err(error));
                    }
                }
            }
            Message::Shutdown => return,
        }
    }
}

fn mark_search_failure(state: &SharedState, error: &SearchError) {
    if matches!(
        error,
        SearchError::InvalidInput { .. }
            | SearchError::LimitOutOfRange { .. }
            | SearchError::QueryTooLong { .. }
            | SearchError::InvalidRange { .. }
            | SearchError::DuplicateOverlayNote
    ) {
        return;
    }
    state.dirty.store(true, Ordering::Release);
    state.degraded.store(true, Ordering::Release);
    state
        .needs_reconciliation
        .store(true, Ordering::Release);
}

fn collect_changes(
    receiver: &Receiver<Message>,
    deferred: &mut VecDeque<Message>,
    updates: &mut Vec<(
        IndexMutation,
        mpsc::SyncSender<Result<UpdateOutcome, SearchError>>,
    )>,
) {
    let deadline = std::time::Instant::now() + COALESCE_TIMEOUT;
    while updates.len() < MAX_INDEX_BATCH {
        match receiver.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now())) {
            Ok(Message::Change { mutation, reply }) => updates.push((mutation, reply)),
            Ok(message) => deferred.push_back(message),
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => return,
        }
    }
}

fn coalesce_changes(
    updates: Vec<(
        IndexMutation,
        mpsc::SyncSender<Result<UpdateOutcome, SearchError>>,
    )>,
    latest: &mut HashMap<String, (i64, bool)>,
) -> (
    Vec<IndexMutation>,
    Vec<mpsc::SyncSender<Result<UpdateOutcome, SearchError>>>,
) {
    let mut pending: BTreeMap<String, PendingChange> = BTreeMap::new();
    for (mutation, reply) in updates {
        let note_id = mutation.note_id().to_owned();
        let revision = mutation.revision();
        let is_delete = mutation.is_delete();
        let already_applied = latest.get(&note_id).is_some_and(|(current, deleted)| {
            *current > revision || (*current == revision && (!is_delete || *deleted))
        });
        if already_applied {
            let _ = reply.send(Ok(UpdateOutcome::Stale));
            continue;
        }
        latest.insert(note_id.clone(), (revision, is_delete));
        match pending.get_mut(&note_id) {
            Some(change) => {
                change.stale_replies.append(&mut change.replies);
                change.mutation = mutation;
                change.replies.push(reply);
            }
            None => {
                pending.insert(
                    note_id,
                    PendingChange {
                        mutation,
                        replies: vec![reply],
                        stale_replies: Vec::new(),
                    },
                );
            }
        }
    }
    let mut mutations = Vec::new();
    let mut responses = Vec::new();
    for (_, change) in pending {
        for reply in change.stale_replies {
            let _ = reply.send(Ok(UpdateOutcome::Stale));
        }
        mutations.push(change.mutation);
        responses.extend(change.replies);
    }
    (mutations, responses)
}

fn check_rebuild_bounds(documents: &[DocumentInput]) -> Result<(), SearchError> {
    if documents.len() > MAX_REBUILD_NOTES {
        return Err(SearchError::InvalidInput {
            field: "rebuild note count",
        });
    }
    let bytes = documents.iter().try_fold(0usize, |sum, document| {
        sum.checked_add(document.content().len())
    });
    if bytes.is_none_or(|bytes| bytes > MAX_REBUILD_SOURCE_BYTES) {
        return Err(SearchError::InvalidInput {
            field: "rebuild source bytes",
        });
    }
    Ok(())
}

fn rebuild_index(
    current: &mut IndexManager,
    path: &Path,
    documents: &[DocumentInput],
) -> Result<(), SearchError> {
    check_rebuild_bounds(documents)?;
    let candidate_path = unique_rebuild_path(path)?;
    let mut candidate = IndexManager::open(&candidate_path)?;
    let build_result = if documents.is_empty() {
        candidate.initialize_metadata()
    } else {
        candidate.upsert_batch(documents)
    };
    if let Err(primary) = build_result {
        candidate.close_writer();
        drop(candidate);
        return match fs::remove_dir_all(&candidate_path) {
            Ok(()) => Err(primary),
            Err(cleanup) => Err(SearchError::RebuildCleanup {
                primary: Box::new(primary),
                cleanup,
            }),
        };
    }
    candidate.close_writer();
    drop(candidate);
    current.close_writer();
    let placeholder = IndexManager::new_in_memory()?;
    let previous = std::mem::replace(current, placeholder);
    drop(previous);
    let swap_result = swap_index_directory(&candidate_path, path);
    let reopen_result = IndexManager::open(path);
    match (swap_result, reopen_result) {
        (Ok(()), Ok(reopened)) => {
            *current = reopened;
            Ok(())
        }
        (Err(primary), Ok(reopened)) => {
            *current = reopened;
            cleanup_failed_rebuild(&candidate_path, primary)
        }
        (Err(primary), Err(_)) => cleanup_failed_rebuild(&candidate_path, primary),
        (Ok(()), Err(reopen)) => Err(reopen),
    }
}

fn cleanup_failed_rebuild(path: &Path, primary: SearchError) -> Result<(), SearchError> {
    match fs::remove_dir_all(path) {
        Ok(()) => Err(primary),
        Err(cleanup) if cleanup.kind() == std::io::ErrorKind::NotFound => Err(primary),
        Err(cleanup) => Err(SearchError::RebuildCleanup {
            primary: Box::new(primary),
            cleanup,
        }),
    }
}

fn replace_index(path: &Path, documents: &[DocumentInput]) -> Result<IndexManager, SearchError> {
    let candidate_path = unique_rebuild_path(path)?;
    let mut candidate = IndexManager::open(&candidate_path)?;
    let build_result = if documents.is_empty() {
        candidate.initialize_metadata()
    } else {
        candidate.upsert_batch(documents)
    };
    if let Err(primary) = build_result {
        candidate.close_writer();
        drop(candidate);
        return match fs::remove_dir_all(&candidate_path) {
            Ok(()) => Err(primary),
            Err(cleanup) => Err(SearchError::RebuildCleanup {
                primary: Box::new(primary),
                cleanup,
            }),
        };
    }
    candidate.close_writer();
    drop(candidate);
    swap_index_directory(&candidate_path, path)?;
    IndexManager::open(path)
}

fn unique_rebuild_path(path: &Path) -> Result<PathBuf, SearchError> {
    static NEXT_REBUILD: std::sync::atomic::AtomicU64 =
        std::sync::atomic::AtomicU64::new(0);
    let parent = path.parent().ok_or(SearchError::InvalidInput {
        field: "index path",
    })?;
    let name = path.file_name().ok_or(SearchError::InvalidInput {
        field: "index path",
    })?;
    for _ in 0..32 {
        let sequence = NEXT_REBUILD.fetch_add(1, Ordering::Relaxed);
        let mut candidate_name = name.to_os_string();
        candidate_name.push(format!(".rebuild-{}-{sequence}", std::process::id()));
        let candidate = parent.join(candidate_name);
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Err(SearchError::InvalidInput {
        field: "unique index rebuild directory",
    })
}

fn swap_index_directory(candidate: &Path, path: &Path) -> Result<(), SearchError> {
    let backup = backup_path(path)?;
    remove_directory_if_present(&backup)?;
    let had_old = match fs::symlink_metadata(path) {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.into()),
    };
    if had_old {
        ensure_real_directory(path)?;
        fs::rename(path, &backup)?;
        sync_parent(path)?;
    }
    if let Err(install) = fs::rename(candidate, path) {
        let restore = if had_old {
            fs::rename(&backup, path).err()
        } else {
            None
        };
        return Err(SearchError::DirectorySwap { install, restore });
    }
    sync_parent(path)?;
    remove_directory_if_present(&backup)?;
    sync_parent(path)?;
    Ok(())
}

fn recover_backup(path: &Path) -> Result<(), SearchError> {
    let backup = backup_path(path)?;
    let path_exists = fs::symlink_metadata(path).is_ok();
    let backup_exists = fs::symlink_metadata(&backup).is_ok();
    if !backup_exists {
        return Ok(());
    }
    ensure_real_directory(&backup)?;
    if path_exists {
        remove_directory_if_present(&backup)?;
    } else {
        fs::rename(&backup, path)?;
    }
    sync_parent(path)
}

fn ensure_search_directory(path: &Path) -> Result<(), SearchError> {
    match fs::symlink_metadata(path) {
        Ok(_) => return ensure_real_directory(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::create_dir(path)?;
    Ok(())
}

fn ensure_real_directory(path: &Path) -> Result<(), SearchError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(SearchError::InvalidInput {
            field: "search index directory",
        });
    }
    Ok(())
}

fn remove_directory_if_present(path: &Path) -> Result<(), SearchError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err(SearchError::InvalidInput {
                field: "search index backup directory",
            })
        }
        Ok(_) => fs::remove_dir_all(path).map_err(SearchError::from),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn backup_path(path: &Path) -> Result<PathBuf, SearchError> {
    let parent = path.parent().ok_or(SearchError::InvalidInput {
        field: "index path",
    })?;
    let name = path.file_name().ok_or(SearchError::InvalidInput {
        field: "index path",
    })?;
    Ok(parent.join(format!("{}.previous", name.to_string_lossy())))
}

fn sync_parent(path: &Path) -> Result<(), SearchError> {
    if let Some(parent) = path.parent() {
        fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{DirtyNoteSnapshot, Fuzziness, NoteIdentity, SearchMode};

    fn document(note_id: &str, revision: i64, content: &str) -> DocumentInput {
        let identity = NoteIdentity::new(
            note_id.into(),
            format!("{note_id}.md"),
            note_id.into(),
            vec![],
            revision,
            format!("blake3-v3:{revision}"),
        )
        .unwrap();
        DocumentInput::new(identity, content.into(), String::new()).unwrap()
    }

    fn options() -> SearchOptions {
        SearchOptions {
            mode: SearchMode::ExactPrefix,
            fuzziness: Fuzziness::Disabled,
            ..SearchOptions::default()
        }
    }

    #[test]
    fn rejected_search_query_does_not_mark_the_index_degraded() {
        let temp = tempfile::tempdir().unwrap();
        let service = SearchService::open(temp.path()).unwrap();
        let error = service
            .search("x".repeat(1025), options(), Vec::new())
            .unwrap_err();

        assert!(matches!(error, SearchError::QueryTooLong { .. }));
        assert_eq!(
            service.status(),
            SearchStatus {
                dirty: false,
                degraded: false,
            }
        );
        assert!(!service.needs_reconciliation());
    }

    #[test]
    fn request_validation_errors_preserve_status_and_storage_errors_degrade() {
        let state = SharedState {
            dirty: AtomicBool::new(false),
            degraded: AtomicBool::new(false),
            needs_reconciliation: AtomicBool::new(false),
        };
        let validation_errors = [
            SearchError::InvalidInput { field: "query" },
            SearchError::LimitOutOfRange {
                value: 101,
                maximum: 100,
            },
            SearchError::QueryTooLong {
                bytes: 1025,
                maximum: 1024,
            },
            SearchError::InvalidRange { start: 2, end: 1 },
            SearchError::DuplicateOverlayNote,
        ];

        for error in &validation_errors {
            mark_search_failure(&state, error);
        }
        assert_eq!(
            SearchStatus {
                dirty: state.dirty.load(Ordering::Acquire),
                degraded: state.degraded.load(Ordering::Acquire),
            },
            SearchStatus {
                dirty: false,
                degraded: false,
            }
        );
        assert!(!state.needs_reconciliation.load(Ordering::Acquire));

        mark_search_failure(&state, &SearchError::WorkerStopped);
        assert_eq!(
            SearchStatus {
                dirty: state.dirty.load(Ordering::Acquire),
                degraded: state.degraded.load(Ordering::Acquire),
            },
            SearchStatus {
                dirty: true,
                degraded: true,
            }
        );
        assert!(state.needs_reconciliation.load(Ordering::Acquire));
    }

    fn snapshot(identity: NoteIdentity, source: &str, local_revision: u64) -> DirtyNoteSnapshot {
        DirtyNoteSnapshot::new(
            identity.clone(),
            identity.revision(),
            identity.source_hash().to_owned(),
            local_revision,
            source.to_owned(),
            String::new(),
        )
        .unwrap()
    }

    #[test]
    fn change_queue_coalesces_by_revision_and_delete_wins_ties() {
        let mut latest = HashMap::new();
        let (mutations, replies) = coalesce_changes(
            vec![
                (IndexMutation::Upsert(document("a", 1, "old")), mpsc::sync_channel(1).0),
                (IndexMutation::Upsert(document("a", 2, "new")), mpsc::sync_channel(1).0),
                (
                    IndexMutation::Delete {
                        note_id: "a".into(),
                        revision: 2,
                    },
                    mpsc::sync_channel(1).0,
                ),
            ],
            &mut latest,
        );
        assert_eq!(mutations.len(), 1);
        assert!(matches!(mutations[0], IndexMutation::Delete { .. }));
        assert_eq!(replies.len(), 1);
        assert_eq!(latest.get("a"), Some(&(2, true)));
    }

    #[test]
    fn clean_restart_does_not_rebuild_matching_index() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("search");
        let service = SearchService::open(&path).unwrap();
        let identity = document("a", 1, "needle").identity().clone();
        service.rebuild(vec![document("a", 1, "needle")]).unwrap();
        drop(service);
        let reopened = SearchService::open(&path).unwrap();
        assert!(reopened.is_current(vec![identity]).unwrap());
        assert_eq!(reopened.status(), SearchStatus { dirty: false, degraded: false });
    }

    #[test]
    fn new_empty_index_persists_schema_and_analyzer_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("search");
        let service = SearchService::open(&path).unwrap();
        assert_eq!(service.status(), SearchStatus { dirty: false, degraded: false });
        drop(service);
        let index = IndexManager::open(&path).unwrap();
        assert!(index.metadata_initialized());
    }

    #[test]
    fn existing_index_without_version_metadata_requests_reconciliation() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("search");
        drop(IndexManager::open(&path).unwrap());
        let service = SearchService::open(&path).unwrap();
        assert!(service.needs_reconciliation());
        service.rebuild(Vec::new()).unwrap();
        assert_eq!(service.status(), SearchStatus { dirty: false, degraded: false });
    }

    #[test]
    fn accepted_write_is_visible_to_search() {
        let temp = tempfile::tempdir().unwrap();
        let service = SearchService::open(&temp.path().join("search")).unwrap();
        assert_eq!(service.upsert(document("a", 1, "accepted content")).unwrap(), UpdateOutcome::Applied);
        let result = service.search(
            "accepted".into(),
            options(),
            vec![document("a", 1, "accepted content").identity().clone()],
        );
        assert_eq!(result.unwrap().len(), 1);
    }

    #[test]
    fn recency_boost_reorders_equal_matches_at_query_time() {
        let temp = tempfile::tempdir().unwrap();
        let service = SearchService::open(&temp.path().join("search")).unwrap();
        let day_ms = 24 * 3_600_000;
        let now_ms = 365 * day_ms;
        let old = document("a", 1, "needle").identity().clone().with_updated_at_ms(now_ms - 200 * day_ms);
        let fresh = document("b", 1, "needle").identity().clone().with_updated_at_ms(now_ms);
        service.upsert(document("a", 1, "needle")).unwrap();
        service.upsert(document("b", 1, "needle")).unwrap();
        let order = |boost: f32| {
            let weights = crate::types::SearchWeights::new(10.0, 5.0, 2.0, 1.0, boost).unwrap();
            service
                .search(
                    "needle".into(),
                    options().with_weights(weights).with_now_ms(now_ms),
                    vec![old.clone(), fresh.clone()],
                )
                .unwrap()
                .into_iter()
                .map(|hit| hit.note_id)
                .collect::<Vec<_>>()
        };
        assert_eq!(order(0.0), ["a", "b"]);
        assert_eq!(order(5.0), ["b", "a"]);
    }

    #[test]
    fn current_identity_filter_suppresses_stale_index_hits() {
        let temp = tempfile::tempdir().unwrap();
        let service = SearchService::open(&temp.path().join("search")).unwrap();
        service.upsert(document("a", 1, "needle")).unwrap();
        let stale = document("a", 2, "new source").identity().clone();
        assert!(service.search("needle".into(), options(), vec![stale]).unwrap().is_empty());
    }

    #[test]
    fn overlay_suppresses_canonical_hits_without_changing_the_index() {
        let temp = tempfile::tempdir().unwrap();
        let service = SearchService::open(&temp.path().join("search")).unwrap();
        let canonical = document("a", 1, "canonical needle");
        service.upsert(canonical.clone()).unwrap();
        let dirty = snapshot(canonical.identity().clone(), "private draft", 3);
        let overlaid = service
            .search_with_overlay(
                "needle".into(),
                options(),
                vec![canonical.identity().clone()],
                &[dirty],
            )
            .unwrap();
        assert!(overlaid.hits.is_empty());
        let indexed = service
            .search(
                "needle".into(),
                options(),
                vec![canonical.identity().clone()],
            )
            .unwrap();
        assert_eq!(indexed.len(), 1);
    }

    #[test]
    fn rebuild_replaces_index_from_a_sibling_directory() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("search");
        let service = SearchService::open(&path).unwrap();
        service.upsert(document("old", 1, "old content")).unwrap();
        service.rebuild(vec![document("new", 1, "new content")]).unwrap();
        assert_eq!(service.search("old".into(), options(), vec![]).unwrap().len(), 0);
        let current = document("new", 1, "new content").identity().clone();
        assert_eq!(service.search("new".into(), options(), vec![current]).unwrap().len(), 1);
    }

    #[test]
    fn failed_rebuild_swap_removes_its_candidate_directory() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("search");
        let service = SearchService::open(&path).unwrap();
        service.upsert(document("old", 1, "old content")).unwrap();
        std::os::unix::fs::symlink(temp.path(), temp.path().join("search.previous")).unwrap();
        let error = service.rebuild(vec![document("new", 1, "new content")]);
        assert!(matches!(
            error,
            Err(SearchError::InvalidInput {
                field: "search index backup directory"
            })
        ));
        let candidates = fs::read_dir(temp.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("search.rebuild-")
            })
            .count();
        assert_eq!(candidates, 0);
    }

    #[test]
    fn symlinked_index_directory_is_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target");
        fs::create_dir(&target).unwrap();
        let link = temp.path().join("search");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(matches!(
            SearchService::open(&link),
            Err(SearchError::InvalidInput {
                field: "search index directory"
            })
        ));
    }
}
