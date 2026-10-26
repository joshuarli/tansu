use tansu_api_types::UnresolvedReason;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NoteState {
    Live,
    Unresolved(UnresolvedReason),
    Tombstoned,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NoteUnavailable {
    NotFound,
    Unresolved(UnresolvedReason),
}

impl NoteState {
    pub fn is_live(&self) -> bool {
        matches!(self, Self::Live)
    }

    pub fn require_live(&self) -> Result<(), NoteUnavailable> {
        match self {
            Self::Live => Ok(()),
            Self::Unresolved(reason) => Err(NoteUnavailable::Unresolved(reason.clone())),
            Self::Tombstoned => Err(NoteUnavailable::NotFound),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_live_notes_accept_mutations() {
        assert_eq!(NoteState::Live.require_live(), Ok(()));
        assert_eq!(NoteState::Tombstoned.require_live(), Err(NoteUnavailable::NotFound));
        assert_eq!(
            NoteState::Unresolved(UnresolvedReason::InvalidUtf8).require_live(),
            Err(NoteUnavailable::Unresolved(UnresolvedReason::InvalidUtf8))
        );
    }
}
