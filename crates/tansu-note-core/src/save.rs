use tansu_api_types::V2NotePrecondition;

use crate::document::{SourceDocument, SourceNotLf};
use crate::hash::disk_hash;
use crate::precondition::RecordedNote;
use crate::submitted::SubmittedSource;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SaveVerdict {
    Conflict,
    Unchanged,
    Write,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavePlan {
    pub verdict: SaveVerdict,
    pub candidate_disk_bytes: Vec<u8>,
    pub candidate_disk_hash: String,
}

pub fn plan_save(
    recorded: RecordedNote<'_>,
    on_disk: &SourceDocument,
    precondition: &V2NotePrecondition,
    submitted: &SubmittedSource,
) -> Result<SavePlan, SourceNotLf> {
    let candidate_disk_bytes = on_disk.disk_bytes_for_source(submitted.content())?;
    let candidate_disk_hash = disk_hash(&candidate_disk_bytes);
    let current = recorded.check(precondition).is_ok() && on_disk.disk_hash() == recorded.disk_hash;
    let verdict = if !current {
        SaveVerdict::Conflict
    } else if on_disk.source == submitted.content() {
        SaveVerdict::Unchanged
    } else {
        SaveVerdict::Write
    };
    Ok(SavePlan {
        verdict,
        candidate_disk_bytes,
        candidate_disk_hash,
    })
}

#[cfg(test)]
mod tests {
    use crate::hash::source_hash;

    use super::*;

    struct Fixture {
        on_disk: SourceDocument,
        source_hash: String,
        disk_hash: String,
    }

    impl Fixture {
        fn new(bytes: &[u8]) -> Self {
            let on_disk = SourceDocument::from_disk(bytes).unwrap();
            Self {
                source_hash: source_hash(&on_disk.source),
                disk_hash: disk_hash(bytes),
                on_disk,
            }
        }

        fn recorded(&self, revision: i64) -> RecordedNote<'_> {
            RecordedNote {
                revision,
                source_hash: &self.source_hash,
                disk_hash: &self.disk_hash,
            }
        }

        fn precondition(&self, revision: i64) -> V2NotePrecondition {
            V2NotePrecondition {
                base_revision: revision,
                base_source_hash: self.source_hash.clone(),
                base_disk_hash: self.disk_hash.clone(),
            }
        }
    }

    fn submitted(content: &str) -> SubmittedSource {
        SubmittedSource::from_stored(content)
    }

    #[test]
    fn matching_precondition_with_new_content_writes_bytes_that_keep_line_endings() {
        let fixture = Fixture::new(b"a\r\nb\r\n");
        let plan = plan_save(
            fixture.recorded(2),
            &fixture.on_disk,
            &fixture.precondition(2),
            &submitted("a\nb\nc\n"),
        )
        .unwrap();
        assert_eq!(plan.verdict, SaveVerdict::Write);
        assert_eq!(plan.candidate_disk_bytes, b"a\r\nb\r\nc\r\n");
        assert_eq!(plan.candidate_disk_hash, disk_hash(b"a\r\nb\r\nc\r\n"));
    }

    #[test]
    fn matching_precondition_with_identical_content_is_unchanged_and_keeps_original_bytes() {
        let fixture = Fixture::new(b"a\r\nb");
        let plan = plan_save(
            fixture.recorded(1),
            &fixture.on_disk,
            &fixture.precondition(1),
            &submitted("a\nb"),
        )
        .unwrap();
        assert_eq!(plan.verdict, SaveVerdict::Unchanged);
        assert_eq!(plan.candidate_disk_bytes, b"a\r\nb");
    }

    #[test]
    fn any_stale_precondition_value_conflicts_and_still_reports_the_candidate() {
        let fixture = Fixture::new(b"a\n");
        let stale = [
            V2NotePrecondition { base_revision: 1, ..fixture.precondition(2) },
            V2NotePrecondition { base_source_hash: "old".to_string(), ..fixture.precondition(2) },
            V2NotePrecondition { base_disk_hash: "old".to_string(), ..fixture.precondition(2) },
        ];
        for precondition in stale {
            let plan = plan_save(fixture.recorded(2), &fixture.on_disk, &precondition, &submitted("b\n")).unwrap();
            assert_eq!(plan.verdict, SaveVerdict::Conflict);
            assert_eq!(plan.candidate_disk_hash, disk_hash(b"b\n"));
        }
    }

    #[test]
    fn conflict_wins_over_unchanged_when_the_stale_content_equals_the_current_content() {
        let fixture = Fixture::new(b"a\n");
        let precondition = V2NotePrecondition { base_revision: 1, ..fixture.precondition(2) };
        let plan = plan_save(fixture.recorded(2), &fixture.on_disk, &precondition, &submitted("a\n")).unwrap();
        assert_eq!(plan.verdict, SaveVerdict::Conflict);
    }

    #[test]
    fn bytes_that_drifted_from_the_recorded_disk_hash_conflict_even_with_a_matching_precondition() {
        let fixture = Fixture::new(b"a\n");
        let drifted = SourceDocument::from_disk(b"a\nexternal\n").unwrap();
        let plan = plan_save(fixture.recorded(2), &drifted, &fixture.precondition(2), &submitted("b\n")).unwrap();
        assert_eq!(plan.verdict, SaveVerdict::Conflict);
    }
}
