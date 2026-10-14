use std::collections::HashMap;
use std::path::Path;

use pulldown_cmark::{Event, Parser, Tag, TagEnd};
use tansu_search::{
    DirtyNoteSnapshot, DocumentInput, Fuzziness, NoteIdentity, OverlaySearchResult,
    QuickOpenResponse, SearchLimit, SearchMode, SearchOptions, SearchResult, SearchService, MAX_REBUILD_NOTES,
    MAX_REBUILD_SOURCE_BYTES,
};

use crate::api_types::{NoteMeta, SearchFieldScores, SearchHit, Settings};
use crate::history;
use crate::paths::visible_path;
use crate::{Error, Result};

pub const DEFAULT_SEARCH_LIMIT: usize = 20;

pub struct SearchIndex {
    service: SearchService,
    revisions: HashMap<String, i64>,
    pub dirty: bool,
    pub degraded: bool,
}

impl SearchIndex {
    pub fn open(state_root: &Path) -> Result<Self> {
        let service = SearchService::open(&state_root.join("search"))
            .map_err(|error| Error::Internal(error.to_string()))?;
        let status = service.status();
        Ok(Self {
            service,
            revisions: HashMap::new(),
            dirty: status.dirty,
            degraded: status.degraded,
        })
    }

    pub fn rebuild(&mut self, root: &Path, notes: &[NoteMeta]) -> Result<()> {
        let identities = notes
            .iter()
            .map(note_identity)
            .collect::<Result<Vec<_>>>()?;
        if !self.service.needs_reconciliation()
            && self
                .service
                .is_current(identities.clone())
                .map_err(search_error)?
        {
            self.revisions = notes
                .iter()
                .map(|note| (note.note_id.clone(), note.seq))
                .collect();
            self.refresh_status();
            return Ok(());
        }
        let documents = read_documents(root, notes, identities)?;
        self.service.rebuild(documents).map_err(search_error)?;
        self.revisions = notes
            .iter()
            .map(|note| (note.note_id.clone(), note.seq))
            .collect();
        self.refresh_status();
        Ok(())
    }

    pub fn index_note(&mut self, meta: NoteMeta, content: &str) {
        if self.try_index_note(meta, content).is_err() {
            self.dirty = true;
            self.degraded = true;
        }
    }

    pub fn try_index_note(&mut self, meta: NoteMeta, content: &str) -> Result<()> {
        let identity = note_identity(&meta)?;
        let document = DocumentInput::new(
            identity,
            to_lf(content),
            extract_headings(content),
        )
        .map_err(search_error)?;
        self.service.upsert(document).map_err(search_error)?;
        self.revisions.insert(meta.note_id, meta.seq);
        self.refresh_status();
        Ok(())
    }

    pub fn remove_note(&mut self, note_id: &str) {
        let Some(revision) = self
            .revisions
            .get(note_id)
            .copied()
            .and_then(|revision| revision.checked_add(1))
        else {
            self.dirty = true;
            self.degraded = true;
            return;
        };
        if self.try_remove_note(note_id, revision).is_err() {
            self.dirty = true;
            self.degraded = true;
        }
    }

    pub fn try_remove_note(&mut self, note_id: &str, revision: i64) -> Result<()> {
        self.service
            .remove(note_id.to_owned(), revision)
            .map_err(search_error)?;
        self.revisions.insert(note_id.to_owned(), revision);
        self.refresh_status();
        Ok(())
    }

    pub fn search(
        &self,
        query: &str,
        _settings: &Settings,
        current: &[NoteMeta],
        limit: usize,
    ) -> Vec<SearchHit> {
        self.try_search(query, current, limit).unwrap_or_default()
    }

    pub fn try_search(
        &self,
        query: &str,
        current: &[NoteMeta],
        limit: usize,
    ) -> Result<Vec<SearchHit>> {
        let options = SearchOptions::new(
            SearchMode::ExactPrefix,
            Fuzziness::OneEdit,
            SearchLimit::try_from(limit).map_err(search_error)?,
        )
        .map_err(search_error)?;
        let identities = current
            .iter()
            .map(note_identity)
            .collect::<Result<Vec<_>>>()?;
        let results = self
            .service
            .search(query.to_owned(), options, identities)
            .map_err(search_error)?;
        let metadata = current
            .iter()
            .map(|note| (note.note_id.as_str(), note))
            .collect::<HashMap<_, _>>();
        results
            .into_iter()
            .filter_map(|result| {
                metadata
                    .get(result.note_id.as_str())
                    .map(|note| result_to_hit(result, (*note).clone()))
            })
            .collect::<Result<Vec<_>>>()
    }

    pub fn try_search_with_overlay(
        &self,
        query: &str,
        current: &[NoteMeta],
        limit: usize,
        snapshots: &[DirtyNoteSnapshot],
    ) -> Result<OverlaySearchResult> {
        let options = SearchOptions::new(
            SearchMode::ExactPrefix,
            Fuzziness::OneEdit,
            SearchLimit::try_from(limit).map_err(search_error)?,
        )
        .map_err(search_error)?;
        let identities = current
            .iter()
            .map(note_identity)
            .collect::<Result<Vec<_>>>()?;
        self.service
            .search_with_overlay(query.to_owned(), options, identities, snapshots)
            .map_err(search_error)
    }

    pub fn quick_open(
        &self,
        query: &str,
        current: &[NoteMeta],
        pinned: &[String],
        recent: &[String],
        limit: usize,
    ) -> Result<QuickOpenResponse> {
        let limit = SearchLimit::try_from(limit).map_err(search_error)?;
        let identities = current
            .iter()
            .map(note_identity)
            .collect::<Result<Vec<_>>>()?;
        self.service
            .quick_open(query, &identities, pinned, recent, limit)
            .map_err(search_error)
    }

    pub fn search_status(&self) -> tansu_search::SearchStatus {
        self.service.status()
    }

    fn refresh_status(&mut self) {
        let status = self.service.status();
        self.dirty = status.dirty;
        self.degraded = status.degraded;
    }
}

fn note_identity(note: &NoteMeta) -> Result<NoteIdentity> {
    NoteIdentity::new(
        note.note_id.clone(),
        note.path.clone(),
        note.title.clone(),
        note.tags.clone(),
        note.seq,
        note.content_hash.clone(),
    )
    .map_err(search_error)
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

fn result_to_hit(result: SearchResult, note: NoteMeta) -> Result<SearchHit> {
    let field_scores = result.field_scores.as_ref();
    Ok(SearchHit {
        note,
        snippet: highlighted_excerpt(&result)?,
        score: result.score,
        field_scores: SearchFieldScores {
            title: field_scores.map_or(0.0, |scores| scores.title),
            headings: field_scores.map_or(0.0, |scores| scores.headings),
            tags: field_scores.map_or(0.0, |scores| scores.tags),
            content: field_scores.map_or(0.0, |scores| scores.content),
        },
    })
}

fn highlighted_excerpt(result: &SearchResult) -> Result<String> {
    let mut output = String::new();
    let mut cursor = 0usize;
    for range in &result.excerpt_ranges {
        let start = utf16_byte_offset(&result.excerpt, range.start())
            .ok_or_else(|| Error::Internal("search excerpt range is invalid".to_string()))?;
        let end = utf16_byte_offset(&result.excerpt, range.end())
            .ok_or_else(|| Error::Internal("search excerpt range is invalid".to_string()))?;
        if start < cursor || end > result.excerpt.len() {
            return Err(Error::Internal("search excerpt range is invalid".to_string()));
        }
        push_escaped(&mut output, &result.excerpt[cursor..start]);
        output.push_str("<mark>");
        push_escaped(&mut output, &result.excerpt[start..end]);
        output.push_str("</mark>");
        cursor = end;
    }
    push_escaped(&mut output, &result.excerpt[cursor..]);
    Ok(output)
}

fn utf16_byte_offset(text: &str, offset: u32) -> Option<usize> {
    let mut units = 0u32;
    for (byte, character) in text.char_indices() {
        if units == offset {
            return Some(byte);
        }
        units = units.checked_add(character.len_utf16() as u32)?;
        if units > offset {
            return None;
        }
    }
    (units == offset).then_some(text.len())
}

fn push_escaped(output: &mut String, value: &str) {
    for character in value.chars() {
        match character {
            '&' => output.push_str("&amp;"),
            '<' => output.push_str("&lt;"),
            '>' => output.push_str("&gt;"),
            '"' => output.push_str("&quot;"),
            '\'' => output.push_str("&#39;"),
            _ => output.push(character),
        }
    }
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
            content_hash: "sha256:fixture".to_owned(),
            updated_at_ms: 0,
        }
    }

    #[test]
    fn indexing_failure_keeps_the_accepted_note_and_marks_search_degraded() {
        let temp = tempfile::tempdir().unwrap();
        let state_root = temp.path().join("state");
        let mut search = SearchIndex::open(&state_root).unwrap();
        std::fs::rename(state_root.join("search"), state_root.join("saved-search"))
            .unwrap();
        std::fs::write(state_root.join("search"), "unavailable").unwrap();
        let accepted = NoteMeta {
            content_hash: "sha256:accepted".to_owned(),
            ..note_meta("accepted")
        };
        search.index_note(accepted.clone(), "accepted source");
        assert_eq!(accepted.content_hash, "sha256:accepted");
        assert!(search.dirty);
        assert!(search.degraded);
    }
}
