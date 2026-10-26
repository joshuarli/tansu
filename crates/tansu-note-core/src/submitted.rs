use tansu_api_types::TextEdit;

use crate::edit::{TextEditError, apply_text_edits};
use crate::hash::{normalize_lf, source_hash};

const MUTATION_ID_MAX_BYTES: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MutationIdError;

impl std::fmt::Display for MutationIdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "mutationId must contain 1 to {MUTATION_ID_MAX_BYTES} bytes")
    }
}

impl std::error::Error for MutationIdError {}

pub fn validate_mutation_id(mutation_id: &str) -> Result<(), MutationIdError> {
    if mutation_id.is_empty() || mutation_id.len() > MUTATION_ID_MAX_BYTES {
        return Err(MutationIdError);
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubmittedSourceError {
    NotLf,
    HashMismatch { expected: String, received: String },
    Edit(TextEditError),
}

impl std::fmt::Display for SubmittedSourceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotLf => f.write_str("editor source must use LF line endings"),
            Self::HashMismatch { .. } => f.write_str("source hash does not match content"),
            Self::Edit(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for SubmittedSourceError {}

impl From<TextEditError> for SubmittedSourceError {
    fn from(error: TextEditError) -> Self {
        Self::Edit(error)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubmittedSource {
    content: String,
    source_hash: String,
}

impl SubmittedSource {
    pub fn from_editor(content: &str, claimed_hash: &str) -> Result<Self, SubmittedSourceError> {
        if content.contains('\r') {
            return Err(SubmittedSourceError::NotLf);
        }
        Self::verified(content.to_string(), claimed_hash)
    }

    pub fn from_delta(
        base: &str,
        edits: &[TextEdit],
        claimed_hash: &str,
    ) -> Result<Self, SubmittedSourceError> {
        Self::verified(apply_text_edits(base, edits)?, claimed_hash)
    }

    pub fn from_stored(content: &str) -> Self {
        let content = normalize_lf(content);
        let source_hash = source_hash(&content);
        Self { content, source_hash }
    }

    pub fn content(&self) -> &str {
        &self.content
    }

    pub fn source_hash(&self) -> &str {
        &self.source_hash
    }

    fn verified(content: String, claimed_hash: &str) -> Result<Self, SubmittedSourceError> {
        let source_hash = source_hash(&content);
        if source_hash != claimed_hash {
            return Err(SubmittedSourceError::HashMismatch {
                expected: source_hash,
                received: claimed_hash.to_string(),
            });
        }
        Ok(Self { content, source_hash })
    }
}

#[cfg(test)]
mod tests {
    use tansu_api_types::TextPosition;

    use super::*;

    #[test]
    fn mutation_ids_hold_one_to_128_bytes() {
        assert!(validate_mutation_id("x").is_ok());
        assert!(validate_mutation_id(&"x".repeat(128)).is_ok());
        assert!(validate_mutation_id("").is_err());
        assert!(validate_mutation_id(&"x".repeat(129)).is_err());
    }

    #[test]
    fn editor_source_must_be_lf_and_match_its_claimed_hash() {
        let hash = source_hash("# Note\n");
        let accepted = SubmittedSource::from_editor("# Note\n", &hash).unwrap();
        assert_eq!(accepted.content(), "# Note\n");
        assert_eq!(accepted.source_hash(), hash);

        assert_eq!(
            SubmittedSource::from_editor("# Note\r\n", &source_hash("# Note\r\n")),
            Err(SubmittedSourceError::NotLf)
        );
        assert_eq!(
            SubmittedSource::from_editor("# Note\n", "blake3-v3:other"),
            Err(SubmittedSourceError::HashMismatch {
                expected: hash,
                received: "blake3-v3:other".to_string(),
            })
        );
    }

    #[test]
    fn delta_source_applies_edits_before_checking_the_hash() {
        let edit = TextEdit {
            start: TextPosition { line: 0, character: 2 },
            end: TextPosition { line: 0, character: 6 },
            text: "Title".to_string(),
        };
        let accepted =
            SubmittedSource::from_delta("# Note\n", std::slice::from_ref(&edit), &source_hash("# Title\n")).unwrap();
        assert_eq!(accepted.content(), "# Title\n");

        assert!(matches!(
            SubmittedSource::from_delta("# Note\n", std::slice::from_ref(&edit), &source_hash("# Note\n")),
            Err(SubmittedSourceError::HashMismatch { .. })
        ));
        let outside = TextEdit {
            start: TextPosition { line: 4, character: 0 },
            end: TextPosition { line: 4, character: 0 },
            text: String::new(),
        };
        assert_eq!(
            SubmittedSource::from_delta("# Note\n", &[outside], &source_hash("# Note\n")),
            Err(SubmittedSourceError::Edit(TextEditError::PositionOutsideDocument))
        );
    }

    #[test]
    fn stored_source_is_canonical_lf() {
        let stored = SubmittedSource::from_stored("a\r\nb\r");
        assert_eq!(stored.content(), "a\nb\n");
        assert_eq!(stored.source_hash(), source_hash("a\nb\n"));
    }
}
