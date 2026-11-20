use std::path::{Path, PathBuf};

use pulldown_cmark::{Event, Parser, Tag, TagEnd};
use tansu_search::{
    DirtyNoteSnapshot, DocumentInput, Fuzziness, NoteIdentity, OverlaySearchResult,
    SearchLimit, SearchMode, SearchOptions, SearchService, SearchWeights, MAX_INDEXED_NOTE_BYTES,
    MAX_REBUILD_NOTES, MAX_REBUILD_SOURCE_BYTES,
};

use crate::api_types::{NoteMeta, Settings};
use crate::catalog::now_ms;
use crate::history;
use crate::paths::visible_path;
use crate::tags::parse_markdown;
use crate::{Error, Result};

pub const DEFAULT_SEARCH_LIMIT: usize = 20;

pub(crate) fn dirty_note_snapshot(
    note_id: String,
    path: String,
    title: String,
    revision: i64,
    source_hash: String,
    local_revision: u64,
    source: String,
) -> std::result::Result<DirtyNoteSnapshot, tansu_search::SearchError> {
    let tags = parse_markdown(&path, &source).tags;
    let headings = extract_headings(&source);
    let identity = NoteIdentity::new(note_id, path, title, tags, revision, source_hash.clone())?;
    DirtyNoteSnapshot::new(identity, revision, source_hash, local_revision, source, headings)
}

fn search_weights(
    settings: &Settings,
) -> std::result::Result<SearchWeights, tansu_search::SearchError> {
    SearchWeights::new(
        settings.search_title_weight,
        settings.search_heading_weight,
        settings.search_tag_weight,
        settings.search_content_weight,
        settings.recency_boost,
    )
}

pub struct SearchIndex {
    state: SearchIndexState,
    path: PathBuf,
    /// Note ids the last rebuild left out of the index because their file
    /// exceeded `MAX_INDEXED_NOTE_BYTES`. They stay in the vault and open
    /// normally; search never returns them.
    skipped_oversize: Vec<String>,
}

enum SearchIndexState {
    Available {
        service: Box<SearchService>,
        needs_reconciliation: bool,
        degraded: bool,
    },
    Unavailable,
}

impl SearchIndex {
    pub fn open(state_root: &Path) -> Self {
        let path = state_root.join("search");
        let state = match SearchService::open(&path) {
            Ok(service) => {
                let status = service.status();
                SearchIndexState::Available {
                    service: Box::new(service),
                    needs_reconciliation: status.dirty,
                    degraded: status.degraded,
                }
            }
            Err(_) => SearchIndexState::Unavailable,
        };
        Self {
            state,
            path,
            skipped_oversize: Vec::new(),
        }
    }

    /// Ids of notes the last rebuild skipped as too large to index.
    pub fn skipped_oversize(&self) -> &[String] {
        &self.skipped_oversize
    }

    pub fn rebuild(&mut self, root: &Path, notes: &[NoteMeta]) -> Result<()> {
        let (notes, skipped) = split_oversize(root, notes)?;
        self.skipped_oversize = skipped;
        let notes = notes.as_slice();
        let identities = notes
            .iter()
            .map(note_identity)
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(search_error)?;
        if !self.needs_reconciliation()
            && self
                .call_service(|service| service.is_current(identities.clone()))
                .map_err(search_error)?
        {
            return Ok(());
        }
        let documents = match read_documents(root, notes, identities) {
            Ok(documents) => documents,
            Err(error) => {
                self.mark_needs_reconciliation(true);
                return Err(error);
            }
        };
        self.call_service(|service| service.rebuild(documents))
            .map_err(search_error)?;
        self.mark_rebuilt();
        Ok(())
    }

    pub fn try_index_note(&mut self, meta: NoteMeta, content: &str) -> Result<()> {
        if content.len() > MAX_INDEXED_NOTE_BYTES {
            if !self.skipped_oversize.contains(&meta.note_id) {
                self.skipped_oversize.push(meta.note_id);
            }
            return Ok(());
        }
        self.skipped_oversize.retain(|note_id| note_id != &meta.note_id);
        let identity = note_identity(&meta).map_err(search_error)?;
        let document = match DocumentInput::new(
            identity,
            to_lf(content),
            extract_headings(content),
        ) {
            Ok(document) => document,
            Err(error) => {
                self.mark_needs_reconciliation(true);
                return Err(search_error(error));
            }
        };
        self.call_service(|service| service.upsert(document))
            .map_err(search_error)?;
        Ok(())
    }

    pub fn try_remove_note(&mut self, note_id: &str, revision: i64) -> Result<()> {
        self.call_service(|service| service.remove(note_id.to_owned(), revision))
            .map_err(search_error)?;
        Ok(())
    }

    pub fn try_search_with_overlay(
        &mut self,
        query: &str,
        current: &[NoteMeta],
        limit: usize,
        mode: SearchMode,
        snapshots: &[DirtyNoteSnapshot],
        settings: &Settings,
    ) -> std::result::Result<OverlaySearchResult, tansu_search::SearchError> {
        let options = SearchOptions::new(
            mode,
            Fuzziness::OneEdit,
            SearchLimit::try_from(limit)?,
        )?
        .with_weights(search_weights(settings)?)
        .with_now_ms(now_ms());
        let identities = current
            .iter()
            .map(note_identity)
            .collect::<std::result::Result<Vec<_>, _>>()?;
        self.call_service(|service| {
            service.search_with_overlay(query.to_owned(), options, identities, snapshots)
        })
    }

    pub fn search_status(&self) -> tansu_search::SearchStatus {
        match &self.state {
            SearchIndexState::Unavailable => tansu_search::SearchStatus {
                dirty: true,
                degraded: true,
            },
            SearchIndexState::Available {
                service,
                needs_reconciliation,
                degraded,
            } => {
                let status = service.status();
                tansu_search::SearchStatus {
                    dirty: status.dirty || *needs_reconciliation,
                    degraded: status.degraded || *degraded,
                }
            }
        }
    }

    pub fn needs_reconciliation(&self) -> bool {
        match &self.state {
            SearchIndexState::Unavailable => true,
            SearchIndexState::Available {
                service,
                needs_reconciliation,
                ..
            } => *needs_reconciliation || service.needs_reconciliation(),
        }
    }

    pub fn mark_needs_reconciliation(&mut self, degraded: bool) {
        if let SearchIndexState::Available {
            needs_reconciliation,
            degraded: state_degraded,
            ..
        } = &mut self.state
        {
            *needs_reconciliation = true;
            *state_degraded |= degraded;
        }
    }

    fn mark_rebuilt(&mut self) {
        if let SearchIndexState::Available {
            needs_reconciliation,
            degraded,
            ..
        } = &mut self.state
        {
            *needs_reconciliation = false;
            *degraded = false;
        }
    }

    fn call_service<T>(
        &mut self,
        operation: impl FnOnce(
            &mut SearchService,
        ) -> std::result::Result<T, tansu_search::SearchError>,
    ) -> std::result::Result<T, tansu_search::SearchError> {
        let result = {
            let service = self.ensure_service()?;
            operation(service)
        };
        match result {
            Ok(value) => Ok(value),
            Err(error) => {
                if !matches!(
                    error,
                    tansu_search::SearchError::InvalidInput { .. }
                        | tansu_search::SearchError::LimitOutOfRange { .. }
                        | tansu_search::SearchError::QueryTooLong { .. }
                        | tansu_search::SearchError::InvalidRange { .. }
                        | tansu_search::SearchError::DuplicateOverlayNote
                ) {
                    self.mark_needs_reconciliation(true);
                }
                Err(error)
            }
        }
    }

    fn ensure_service(
        &mut self,
    ) -> std::result::Result<&mut SearchService, tansu_search::SearchError> {
        if matches!(self.state, SearchIndexState::Unavailable) {
            match SearchService::open(&self.path) {
                Ok(service) => {
                    self.state = SearchIndexState::Available {
                        service: Box::new(service),
                        needs_reconciliation: true,
                        degraded: false,
                    };
                }
                Err(error) => return Err(error),
            }
        }
        match &mut self.state {
            SearchIndexState::Available { service, .. } => Ok(service),
            SearchIndexState::Unavailable => unreachable!(),
        }
    }
}

fn note_identity(
    note: &NoteMeta,
) -> std::result::Result<NoteIdentity, tansu_search::SearchError> {
    NoteIdentity::new(
        note.note_id.clone(),
        note.path.clone(),
        note.title.clone(),
        note.tags.clone(),
        note.seq,
        note.content_hash.clone(),
    )
    .map(|identity| identity.with_updated_at_ms(note.updated_at_ms))
}

/// Separates notes whose file is over `MAX_INDEXED_NOTE_BYTES` so one oversize
/// note cannot push the whole rebuild past its bounds. Returns the notes to
/// index and the ids skipped.
fn split_oversize(root: &Path, notes: &[NoteMeta]) -> Result<(Vec<NoteMeta>, Vec<String>)> {
    let mut indexable = Vec::with_capacity(notes.len());
    let mut skipped = Vec::new();
    for note in notes {
        let bytes = std::fs::metadata(visible_path(root, &note.path))?.len();
        if bytes > MAX_INDEXED_NOTE_BYTES as u64 {
            skipped.push(note.note_id.clone());
        } else {
            indexable.push(note.clone());
        }
    }
    Ok((indexable, skipped))
}

fn read_documents(
    root: &Path,
    notes: &[NoteMeta],
    identities: Vec<NoteIdentity>,
) -> Result<Vec<DocumentInput>> {
    if notes.len() > MAX_REBUILD_NOTES {
        return Err(Error::Internal("search rebuild note limit exceeded".to_string()));
    }
    let mut bytes_read = 0usize;
    let mut documents = Vec::with_capacity(notes.len());
    for (note, identity) in notes.iter().zip(identities) {
        let visible = visible_path(root, &note.path);
        let expected_bytes = usize::try_from(std::fs::metadata(&visible)?.len())
            .map_err(|_| Error::Internal("search rebuild file is too large".to_string()))?;
        bytes_read = bytes_read
            .checked_add(expected_bytes)
            .filter(|bytes| *bytes <= MAX_REBUILD_SOURCE_BYTES)
            .ok_or_else(|| Error::Internal("search rebuild source limit exceeded".to_string()))?;
        let bytes = std::fs::read(visible)?;
        let canonical = history::validate_and_canonicalize(&bytes)?;
        let source = to_lf(&canonical);
        DocumentInput::new(identity, source, extract_headings(&canonical))
            .map(|document| documents.push(document))
            .map_err(search_error)?;
    }
    Ok(documents)
}

fn extract_headings(markdown: &str) -> String {
    let mut headings = String::new();
    let mut in_heading = false;
    for event in Parser::new(markdown) {
        match event {
            Event::Start(Tag::Heading { .. }) => in_heading = true,
            Event::End(TagEnd::Heading(_)) => {
                in_heading = false;
                headings.push('\n');
            }
            Event::Text(text) | Event::Code(text) if in_heading => {
                headings.push_str(&text);
                headings.push(' ');
            }
            _ => {}
        }
    }
    headings
}

fn to_lf(source: &str) -> String {
    source.replace("\r\n", "\n").replace('\r', "\n")
}

fn search_error(error: tansu_search::SearchError) -> Error {
    Error::Internal(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note_meta(note_id: &str) -> NoteMeta {
        NoteMeta {
            note_id: note_id.to_owned(),
            path: format!("{note_id}.md"),
            title: note_id.to_owned(),
            tags: Vec::new(),
            seq: 1,
            content_hash: "blake3-v3:fixture".to_owned(),
            updated_at_ms: 0,
        }
    }

    #[test]
    fn unavailable_index_reports_degraded_after_index_failure() {
        let temp = tempfile::tempdir().unwrap();
        let state_root = temp.path().join("state");
        std::fs::create_dir_all(&state_root).unwrap();
        std::fs::write(state_root.join("search"), "unavailable").unwrap();
        let mut search = SearchIndex::open(&state_root);
        let accepted = NoteMeta {
            content_hash: "blake3-v3:accepted".to_owned(),
            ..note_meta("accepted")
        };
        assert!(search
            .try_index_note(accepted.clone(), "accepted source")
            .is_err());
        assert_eq!(accepted.content_hash, "blake3-v3:accepted");
        assert!(search.search_status().dirty);
        assert!(search.search_status().degraded);
    }

    fn write_repeated(path: &Path, byte: u8, len: usize) {
        use std::io::Write;
        let chunk = vec![byte; 1024 * 1024];
        let mut file = std::fs::File::create(path).unwrap();
        let mut remaining = len;
        while remaining > 0 {
            let n = remaining.min(chunk.len());
            file.write_all(&chunk[..n]).unwrap();
            remaining -= n;
        }
    }

    #[test]
    fn oversize_note_is_skipped_and_search_stays_healthy_for_the_rest() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let state_root = temp.path().join("state");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&state_root).unwrap();
        std::fs::write(root.join("small.md"), "# Small\n\nneedle in a small note\n").unwrap();
        // Over MAX_REBUILD_SOURCE_BYTES on its own: before the per-note limit
        // this failed the whole rebuild and left search degraded.
        write_repeated(
            &root.join("huge.md"),
            b'a',
            MAX_REBUILD_SOURCE_BYTES + 1024 * 1024,
        );
        let notes = vec![note_meta("small"), note_meta("huge")];
        let mut search = SearchIndex::open(&state_root);
        search.rebuild(&root, &notes).unwrap();
        assert_eq!(search.skipped_oversize(), ["huge".to_owned()]);
        let status = search.search_status();
        assert!(!status.dirty && !status.degraded);
        let settings = Settings::default();
        let hits = search
            .try_search_with_overlay("needle", &notes, 10, SearchMode::ExactPrefix, &[], &settings)
            .unwrap()
            .hits;
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].note_id, "small");
        // A second rebuild sees the index as current and does not reread huge.md.
        search.rebuild(&root, &notes).unwrap();
        assert!(!search.search_status().degraded);
    }

    #[test]
    fn oversize_edit_is_not_indexed_and_is_not_an_error() {
        let temp = tempfile::tempdir().unwrap();
        let state_root = temp.path().join("state");
        std::fs::create_dir_all(&state_root).unwrap();
        let mut search = SearchIndex::open(&state_root);
        let content = "a".repeat(MAX_INDEXED_NOTE_BYTES + 1);
        search.try_index_note(note_meta("big"), &content).unwrap();
        assert_eq!(search.skipped_oversize(), ["big".to_owned()]);
        search.try_index_note(note_meta("big"), "small again").unwrap();
        assert!(search.skipped_oversize().is_empty());
    }
}
