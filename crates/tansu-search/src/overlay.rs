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
    for snapshot in snapshots {
        if !seen.insert(snapshot.identity().note_id()) {
            return Err(SearchError::DuplicateOverlayNote);
        }
    }
    if snapshots.is_empty() {
        return Ok(OverlaySearchOutput {
            result: OverlaySearchResult { hits: Vec::new() },
            covered_note_ids: HashSet::new(),
        });
    }
    let mut index = IndexManager::new_in_memory()?;
    let documents = snapshots
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
        if let Some(snapshot) = snapshots
            .iter()
            .find(|snapshot| snapshot.identity().note_id() == hit.note_id)
        {
            hit.local_revision = Some(snapshot.local_revision());
        }
    }
    Ok(OverlaySearchOutput {
        result: OverlaySearchResult { hits },
        covered_note_ids: snapshots
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
            "blake3-v3:base".into(),
        )
        .unwrap();
        DirtyNoteSnapshot::new(
            identity,
            4,
            "blake3-v3:base".into(),
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
        assert_eq!(result.result.hits[0].source_hash, "blake3-v3:base");
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
