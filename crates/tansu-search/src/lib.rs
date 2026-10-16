mod error;
mod index;
mod overlay;
mod quick_open;
mod schema;
mod search;
mod service;
mod tokenizer;
mod types;

pub use error::SearchError;
pub use overlay::{MAX_OVERLAY_BYTES, MAX_OVERLAY_NOTES};
pub use service::{MAX_REBUILD_NOTES, MAX_REBUILD_SOURCE_BYTES, SearchService};
pub use types::{
    DirtyNoteSnapshot, DocumentInput, ExcerptRange, Fuzziness, MatchInfo,
    NoteIdentity, NoteRange, OverlaySearchResult, QuickOpenField, QuickOpenHit,
    QuickOpenPriority, QuickOpenRange, QuickOpenResponse, SearchLimit, SearchMode,
    SearchOptions, SearchResult, SearchStatus, SearchWeights, UpdateOutcome,
};
