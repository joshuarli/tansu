use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::error::SearchError;
use crate::index::{IndexManager, IndexMutation};
use crate::overlay;
use crate::search;
use crate::types::{
    DirtyNoteSnapshot, DocumentInput, NoteIdentity, OverlaySearchResult, SearchOptions,
    SearchResult, SearchStatus, UpdateOutcome,
};

pub const MAX_REBUILD_NOTES: usize = 10_000;
pub const MAX_REBUILD_SOURCE_BYTES: usize = 128 * 1024 * 1024;

pub struct SearchService {
    index: IndexManager,
    path: PathBuf,
    latest: HashMap<String, (i64, bool)>,
    status: SearchStatus,
    needs_reconciliation: bool,
}

impl SearchService {
    pub fn open(path: &Path) -> Result<Self, SearchError> {
        let had_metadata = match fs::symlink_metadata(path.join("meta.json")) {
            Ok(_) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(error.into()),
        };
        ensure_search_directory(path)?;
        let (index, recovered) = match IndexManager::open(path) {
            Ok(index) if index.metadata_initialized() => (index, false),
            Ok(mut index) => {
                index.initialize_metadata()?;
                index.close_writer();
                (index, had_metadata)
            }
            Err(
                SearchError::SchemaMismatch
                | SearchError::CorruptIndex
                | SearchError::IndexOpen { .. },
            ) => (replace_index(path)?, true),
            Err(error) => return Err(error),
        };
        let latest = index
            .identities()?
            .into_iter()
            .map(|identity| (identity.note_id().to_owned(), (identity.revision(), false)))
            .collect();
        Ok(Self {
            index,
            path: path.to_path_buf(),
            latest,
            status: SearchStatus {
                dirty: recovered,
                degraded: recovered,
            },
            needs_reconciliation: recovered,
        })
    }

    pub fn status(&self) -> SearchStatus {
        self.status
    }

    pub fn needs_reconciliation(&self) -> bool {
        self.needs_reconciliation
    }

    pub fn upsert(&mut self, input: DocumentInput) -> Result<UpdateOutcome, SearchError> {
        self.change(IndexMutation::Upsert(input))
    }

    pub fn remove(&mut self, note_id: String, revision: i64) -> Result<UpdateOutcome, SearchError> {
        self.change(IndexMutation::Delete { note_id, revision })
    }

    fn change(&mut self, mutation: IndexMutation) -> Result<UpdateOutcome, SearchError> {
        self.status.dirty = true;
        let note_id = mutation.note_id().to_owned();
        let revision = mutation.revision();
        let is_delete = mutation.is_delete();
        let already_applied = self.latest.get(&note_id).is_some_and(|(current, deleted)| {
            *current > revision || (*current == revision && (!is_delete || *deleted))
        });
        if already_applied {
            if !self.needs_reconciliation {
                self.status.dirty = false;
            }
            return Ok(UpdateOutcome::Stale);
        }
        let result = self.index.apply_batch(std::slice::from_ref(&mutation));
        self.index.close_writer();
        match result {
            Ok(applied) => {
                if applied[0] {
                    self.latest.insert(note_id, (revision, is_delete));
                }
                if !self.needs_reconciliation {
                    self.status.dirty = false;
                }
                Ok(if applied[0] {
                    UpdateOutcome::Applied
                } else {
                    UpdateOutcome::Stale
                })
            }
            Err(error) => {
                self.status.dirty = true;
                self.status.degraded = true;
                self.needs_reconciliation = true;
                Err(error)
            }
        }
    }

    pub fn search(
        &mut self,
        query: String,
        options: SearchOptions,
        current: Vec<NoteIdentity>,
    ) -> Result<Vec<SearchResult>, SearchError> {
        let result = search::execute(&self.index, &query, options).map(|mut hits| {
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
                |hit| {
                    canonical
                        .get(hit.note_id.as_str())
                        .map_or(0, |identity| identity.updated_at_ms())
                },
                &options,
            );
            hits
        });
        if let Err(error) = &result {
            mark_search_failure(&mut self.status, &mut self.needs_reconciliation, error);
        }
        result
    }

    pub fn search_with_overlay(
        &mut self,
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
        self.index.is_current(&identities)
    }

    pub fn rebuild(&mut self, documents: Vec<DocumentInput>) -> Result<(), SearchError> {
        check_rebuild_bounds(&documents)?;
        self.status.dirty = true;
        match rebuild_index(&mut self.index, &self.path, &documents) {
            Ok(()) => {
                self.latest = documents
                    .iter()
                    .map(|document| {
                        (
                            document.note_id().to_owned(),
                            (document.revision(), false),
                        )
                    })
                    .collect();
                self.status.dirty = false;
                self.status.degraded = false;
                self.needs_reconciliation = false;
                Ok(())
            }
            Err(error) => {
                self.status.dirty = true;
                self.status.degraded = true;
                self.needs_reconciliation = true;
                Err(error)
            }
        }
    }
}

fn mark_search_failure(
    status: &mut SearchStatus,
    needs_reconciliation: &mut bool,
    error: &SearchError,
) {
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
    status.dirty = true;
    status.degraded = true;
    *needs_reconciliation = true;
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
    current.close_writer();
    let placeholder = IndexManager::new_in_memory()?;
    let previous = std::mem::replace(current, placeholder);
    drop(previous);
    reset_search_directory(path)?;
    let mut rebuilt = IndexManager::open(path)?;
    if documents.is_empty() {
        rebuilt.initialize_metadata()?;
    } else {
        rebuilt.upsert_batch(documents)?;
    }
    rebuilt.close_writer();
    *current = rebuilt;
    Ok(())
}

fn replace_index(path: &Path) -> Result<IndexManager, SearchError> {
    reset_search_directory(path)?;
    let mut index = IndexManager::open(path)?;
    index.initialize_metadata()?;
    index.close_writer();
    Ok(index)
}

fn reset_search_directory(path: &Path) -> Result<(), SearchError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(SearchError::InvalidInput {
                field: "search index directory",
            });
        }
        Ok(_) => fs::remove_dir_all(path)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    fs::create_dir(path)?;
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{DirtyNoteSnapshot, Fuzziness, NoteIdentity, SearchMode};
    use std::sync::mpsc;
    use std::time::Duration;

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
        let mut service = SearchService::open(temp.path()).unwrap();
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
        let mut status = SearchStatus {
            dirty: false,
            degraded: false,
        };
        let mut needs_reconciliation = false;
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
            mark_search_failure(&mut status, &mut needs_reconciliation, error);
        }
        assert_eq!(
            status,
            SearchStatus { dirty: false, degraded: false }
        );
        assert!(!needs_reconciliation);

        mark_search_failure(
            &mut status,
            &mut needs_reconciliation,
            &SearchError::Io(std::io::Error::other("index")),
        );
        assert_eq!(
            status,
            SearchStatus { dirty: true, degraded: true }
        );
        assert!(needs_reconciliation);
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
    fn stale_updates_are_ignored_and_delete_wins_revision_ties() {
        let temp = tempfile::tempdir().unwrap();
        let mut service = SearchService::open(&temp.path().join("search")).unwrap();

        assert_eq!(
            service.upsert(document("a", 2, "new")).unwrap(),
            UpdateOutcome::Applied
        );
        assert_eq!(
            service.upsert(document("a", 1, "old")).unwrap(),
            UpdateOutcome::Stale
        );
        assert_eq!(
            service.remove("a".into(), 2).unwrap(),
            UpdateOutcome::Applied
        );
        assert_eq!(
            service.upsert(document("a", 2, "resurrected")).unwrap(),
            UpdateOutcome::Stale
        );
        assert_eq!(
            service.remove("a".into(), 2).unwrap(),
            UpdateOutcome::Stale
        );
        assert_eq!(
            service.upsert(document("a", 3, "later")).unwrap(),
            UpdateOutcome::Applied
        );
        assert_eq!(
            service.remove("missing".into(), 5).unwrap(),
            UpdateOutcome::Applied
        );
        assert_eq!(
            service.upsert(document("missing", 4, "older")).unwrap(),
            UpdateOutcome::Stale
        );
        assert_eq!(
            service.upsert(document("missing", 5, "same revision")).unwrap(),
            UpdateOutcome::Stale
        );

        assert!(service
            .search("resurrected".into(), options(), vec![])
            .unwrap()
            .is_empty());
        assert!(service
            .search("older".into(), options(), vec![])
            .unwrap()
            .is_empty());
        assert_eq!(
            service
                .search(
                    "later".into(),
                    options(),
                    vec![document("a", 3, "later").identity().clone()]
                )
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn a_fifth_live_service_can_write_without_waiting_for_idle_services_to_drop() {
        let temp = tempfile::tempdir().unwrap();
        let mut services = (0..4)
            .map(|index| SearchService::open(&temp.path().join(index.to_string())).unwrap())
            .collect::<Vec<_>>();
        for (index, service) in services.iter_mut().enumerate() {
            service
                .upsert(document(&format!("note-{index}"), 1, "first writer"))
                .unwrap();
        }
        let mut fifth = SearchService::open(&temp.path().join("fifth")).unwrap();
        let (finished, result) = mpsc::channel();
        let writer = std::thread::spawn(move || {
            let result = fifth.upsert(document("fifth", 1, "fifth writer"));
            finished.send(result).unwrap();
        });

        let first_result = result.recv_timeout(Duration::from_secs(2));
        let progressed_with_owners_alive = first_result.is_ok();
        let write_result = match first_result {
            Ok(result) => result,
            Err(_) => {
                drop(services);
                result
                    .recv_timeout(Duration::from_secs(2))
                    .expect("the fifth writer should proceed after earlier services drop")
            }
        };
        assert_eq!(write_result.unwrap(), UpdateOutcome::Applied);
        writer.join().unwrap();
        assert!(
            progressed_with_owners_alive,
            "the fifth writer waited for idle service owners"
        );
    }

    #[test]
    fn clean_restart_does_not_rebuild_matching_index() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("search");
        let mut service = SearchService::open(&path).unwrap();
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
        let mut service = SearchService::open(&path).unwrap();
        assert!(service.needs_reconciliation());
        service.rebuild(Vec::new()).unwrap();
        assert_eq!(service.status(), SearchStatus { dirty: false, degraded: false });
    }

    #[test]
    fn accepted_write_is_visible_to_search() {
        let temp = tempfile::tempdir().unwrap();
        let mut service = SearchService::open(&temp.path().join("search")).unwrap();
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
        let mut service = SearchService::open(&temp.path().join("search")).unwrap();
        let day_ms = 24 * 3_600_000;
        let now_ms = 365 * day_ms;
        let old = document("a", 1, "needle").identity().clone().with_updated_at_ms(now_ms - 200 * day_ms);
        let fresh = document("b", 1, "needle").identity().clone().with_updated_at_ms(now_ms);
        service.upsert(document("a", 1, "needle")).unwrap();
        service.upsert(document("b", 1, "needle")).unwrap();
        let mut order = |boost: f32| {
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
        let mut service = SearchService::open(&temp.path().join("search")).unwrap();
        service.upsert(document("a", 1, "needle")).unwrap();
        let stale = document("a", 2, "new source").identity().clone();
        assert!(service.search("needle".into(), options(), vec![stale]).unwrap().is_empty());
    }

    #[test]
    fn overlay_suppresses_canonical_hits_without_changing_the_index() {
        let temp = tempfile::tempdir().unwrap();
        let mut service = SearchService::open(&temp.path().join("search")).unwrap();
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
    fn rebuild_replaces_the_derived_index_from_canonical_documents() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("search");
        let mut service = SearchService::open(&path).unwrap();
        service.upsert(document("old", 1, "old content")).unwrap();
        service.rebuild(vec![document("new", 1, "new content")]).unwrap();
        assert_eq!(service.search("old".into(), options(), vec![]).unwrap().len(), 0);
        let current = document("new", 1, "new content").identity().clone();
        assert_eq!(service.search("new".into(), options(), vec![current]).unwrap().len(), 1);
    }

    #[test]
    fn corrupt_index_is_discarded_before_canonical_rebuild() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("search");
        fs::create_dir(&path).unwrap();
        fs::write(path.join("meta.json"), "damaged metadata").unwrap();

        let mut service = SearchService::open(&path).unwrap();
        assert!(service.needs_reconciliation());
        assert_eq!(service.status(), SearchStatus { dirty: true, degraded: true });
        service.rebuild(vec![document("canonical", 1, "canonical source")]).unwrap();
        assert_eq!(service.status(), SearchStatus { dirty: false, degraded: false });
        assert!(!service.needs_reconciliation());
        let current = document("canonical", 1, "canonical source").identity().clone();
        assert_eq!(
            service
                .search("canonical".into(), options(), vec![current])
                .unwrap()
                .len(),
            1
        );
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
