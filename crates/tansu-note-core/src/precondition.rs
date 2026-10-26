use tansu_api_types::V2NotePrecondition;

#[derive(Debug, Clone, Copy)]
pub struct RecordedNote<'a> {
    pub revision: i64,
    pub source_hash: &'a str,
    pub disk_hash: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreconditionMismatch {
    SourceHash { expected: String, received: String },
    DiskHash { expected: String, received: String },
    Revision,
}

impl RecordedNote<'_> {
    pub fn check(&self, precondition: &V2NotePrecondition) -> Result<(), PreconditionMismatch> {
        if self.source_hash != precondition.base_source_hash {
            return Err(PreconditionMismatch::SourceHash {
                expected: self.source_hash.to_string(),
                received: precondition.base_source_hash.clone(),
            });
        }
        if self.disk_hash != precondition.base_disk_hash {
            return Err(PreconditionMismatch::DiskHash {
                expected: self.disk_hash.to_string(),
                received: precondition.base_disk_hash.clone(),
            });
        }
        if self.revision != precondition.base_revision {
            return Err(PreconditionMismatch::Revision);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn precondition_reports_the_first_stale_value_in_source_disk_revision_order() {
        let recorded = RecordedNote { revision: 3, source_hash: "source", disk_hash: "disk" };
        let valid = V2NotePrecondition {
            base_revision: 3,
            base_source_hash: "source".to_string(),
            base_disk_hash: "disk".to_string(),
        };
        assert_eq!(recorded.check(&valid), Ok(()));

        let stale_source = V2NotePrecondition { base_source_hash: "old".to_string(), ..valid.clone() };
        assert_eq!(
            recorded.check(&stale_source),
            Err(PreconditionMismatch::SourceHash {
                expected: "source".to_string(),
                received: "old".to_string(),
            })
        );
        let stale_disk = V2NotePrecondition { base_disk_hash: "old".to_string(), ..valid.clone() };
        assert_eq!(
            recorded.check(&stale_disk),
            Err(PreconditionMismatch::DiskHash {
                expected: "disk".to_string(),
                received: "old".to_string(),
            })
        );
        let stale_revision = V2NotePrecondition { base_revision: 4, ..valid.clone() };
        assert_eq!(recorded.check(&stale_revision), Err(PreconditionMismatch::Revision));
        let everything_stale = V2NotePrecondition {
            base_revision: 4,
            base_source_hash: "old".to_string(),
            base_disk_hash: "old".to_string(),
        };
        assert!(matches!(
            recorded.check(&everything_stale),
            Err(PreconditionMismatch::SourceHash { .. })
        ));
    }
}
