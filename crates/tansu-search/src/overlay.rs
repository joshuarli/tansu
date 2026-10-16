use std::collections::HashSet;

use crate::error::SearchError;
use crate::index::IndexManager;
use crate::search::execute;
use crate::types::{
    DirtyNoteSnapshot, DocumentInput, OverlaySearchResult, SearchOptions,
};

pub const MAX_OVERLAY_NOTES: usize = 20;
pub const MAX_OVERLAY_BYTES: usize = 2 * 1024 * 1024;

pub(crate) fn search(
    query: &str,
    options: SearchOptions,
    snapshots: &[DirtyNoteSnapshot],
) -> Result<OverlaySearchOutput, SearchError> {
    let mut seen = HashSet::new();
    let mut included = Vec::new();
    let mut bytes = 0usize;
    for snapshot in snapshots.iter().take(MAX_OVERLAY_NOTES) {
        if !seen.insert(snapshot.identity().note_id()) {
            return Err(SearchError::DuplicateOverlayNote);
        }
        let input_bytes = snapshot.source().len();
        if bytes.saturating_add(input_bytes) > MAX_OVERLAY_BYTES {
            break;
        }
        bytes += input_bytes;
        included.push(snapshot);
    }
    let skipped_notes = snapshots.len().saturating_sub(included.len());
    if included.is_empty() {
        return Ok(OverlaySearchOutput {
            result: OverlaySearchResult {
                hits: Vec::new(),
                skipped_notes,
            },
            covered_note_ids: HashSet::new(),
        });
    }
    let mut index = IndexManager::new_in_memory()?;
    let documents = included
        .iter()
        .map(|snapshot| {
            DocumentInput::new(
                snapshot.identity().clone(),
                snapshot.source().to_owned(),
                snapshot.headings().to_owned(),
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    index.upsert_batch(&documents)?;
    let mut hits = execute(&index, query, options)?;
    crate::search::rank_hits(&mut hits, |_| options.now_ms, &options);
    for hit in &mut hits {
        if let Some(snapshot) = included
            .iter()
            .find(|snapshot| snapshot.identity().note_id() == hit.note_id)
        {
            hit.local_revision = Some(snapshot.local_revision());
        }
    }
    Ok(OverlaySearchOutput {
        result: OverlaySearchResult {
            hits,
            skipped_notes,
        },
        covered_note_ids: included
            .iter()
            .map(|snapshot| snapshot.identity().note_id().to_owned())
            .collect(),
    })
}

pub(crate) struct OverlaySearchOutput {
    pub result: OverlaySearchResult,
    pub covered_note_ids: HashSet<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Fuzziness, NoteIdentity, SearchLimit, SearchMode};

    fn snapshot(note_id: &str, source: &str, local_revision: u64) -> DirtyNoteSnapshot {
        let identity = NoteIdentity::new(
            note_id.into(),
            format!("{note_id}.md"),
            note_id.into(),
            vec![],
            4,
            "sha256-v2:base".into(),
        )
        .unwrap();
        DirtyNoteSnapshot::new(
            identity,
            4,
            "sha256-v2:base".into(),
            local_revision,
            source.into(),
            String::new(),
        )
        .unwrap()
    }

    fn options() -> SearchOptions {
        SearchOptions {
            mode: SearchMode::ExactPrefix,
            fuzziness: Fuzziness::Disabled,
            limit: SearchLimit::try_from(20).unwrap(),
            ..SearchOptions::default()
        }
    }

    #[test]
    fn overlay_matches_local_source_and_returns_revision_without_indexing() {
        let snapshots = [snapshot("draft", "local-only phrase", 7)];
        let result = search("local-only", options(), &snapshots).unwrap();
        assert_eq!(result.result.hits.len(), 1);
        assert_eq!(result.result.hits[0].note_id, "draft");
        assert_eq!(result.result.hits[0].local_revision, Some(7));
        assert_eq!(result.result.hits[0].source_hash, "sha256-v2:base");
    }

    #[test]
    fn overlay_uses_ordered_note_and_byte_bounds() {
        let large = "x".repeat(MAX_OVERLAY_BYTES + 1);
        let snapshots = [
            snapshot("first", "first phrase", 1),
            snapshot("too-large", &large, 2),
            snapshot("after", "after phrase", 3),
        ];
        let result = search("phrase", options(), &snapshots).unwrap();
        assert_eq!(result.result.hits.len(), 1);
        assert_eq!(result.result.hits[0].note_id, "first");
        assert_eq!(result.result.skipped_notes, 2);
    }

    #[test]
    fn overlay_rejects_duplicate_note_ids() {
        let snapshots = [snapshot("same", "one", 1), snapshot("same", "two", 2)];
        assert!(matches!(
            search("one", options(), &snapshots),
            Err(SearchError::DuplicateOverlayNote)
        ));
    }
}
