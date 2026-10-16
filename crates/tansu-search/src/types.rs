
use crate::error::SearchError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteIdentity {
    note_id: String,
    path: String,
    title: String,
    tags: Vec<String>,
    revision: i64,
    source_hash: String,
    updated_at_ms: i64,
}

impl NoteIdentity {
    pub fn new(
        note_id: String,
        path: String,
        title: String,
        tags: Vec<String>,
        revision: i64,
        source_hash: String,
    ) -> Result<Self, SearchError> {
        if note_id.is_empty() {
            return Err(SearchError::InvalidInput { field: "noteId" });
        }
        if path.is_empty() {
            return Err(SearchError::InvalidInput { field: "path" });
        }
        if revision < 0 {
            return Err(SearchError::InvalidInput { field: "revision" });
        }
        if source_hash.is_empty() {
            return Err(SearchError::InvalidInput { field: "sourceHash" });
        }
        Ok(Self {
            note_id,
            path,
            title,
            tags,
            revision,
            source_hash,
            updated_at_ms: 0,
        })
    }

    pub fn with_updated_at_ms(mut self, updated_at_ms: i64) -> Self {
        self.updated_at_ms = updated_at_ms;
        self
    }

    pub fn updated_at_ms(&self) -> i64 {
        self.updated_at_ms
    }

    pub(crate) fn same_indexed_state(&self, other: &Self) -> bool {
        self.note_id == other.note_id
            && self.path == other.path
            && self.title == other.title
            && self.tags == other.tags
            && self.revision == other.revision
            && self.source_hash == other.source_hash
    }

    pub fn note_id(&self) -> &str {
        &self.note_id
    }

    pub fn path(&self) -> &str {
        &self.path
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn tags(&self) -> &[String] {
        &self.tags
    }

    pub fn revision(&self) -> i64 {
        self.revision
    }

    pub fn source_hash(&self) -> &str {
        &self.source_hash
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentInput {
    identity: NoteIdentity,
    content: String,
    headings: String,
}

impl DocumentInput {
    pub fn new(
        identity: NoteIdentity,
        content: String,
        headings: String,
    ) -> Result<Self, SearchError> {
        if content.contains('\r') {
            return Err(SearchError::InvalidInput { field: "content" });
        }
        Ok(Self {
            identity,
            content,
            headings,
        })
    }

    pub fn identity(&self) -> &NoteIdentity {
        &self.identity
    }

    pub fn note_id(&self) -> &str {
        self.identity.note_id()
    }

    pub fn path(&self) -> &str {
        self.identity.path()
    }

    pub fn title(&self) -> &str {
        self.identity.title()
    }

    pub fn content(&self) -> &str {
        &self.content
    }

    pub fn headings(&self) -> &str {
        &self.headings
    }

    pub fn tags(&self) -> &[String] {
        self.identity.tags()
    }

    pub fn revision(&self) -> i64 {
        self.identity.revision()
    }

    pub fn source_hash(&self) -> &str {
        self.identity.source_hash()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchMode {
    ExactPrefix,
    TypoOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fuzziness {
    Disabled,
    OneEdit,
    TwoEdits,
}

impl Fuzziness {
    pub(crate) fn distance_for(self, term: &str) -> u8 {
        match (self, term.len()) {
            (Self::Disabled, _) | (_, 0..=3) => 0,
            (Self::OneEdit, 4..) | (Self::TwoEdits, 4..=5) => 1,
            (Self::TwoEdits, 6..) => 2,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct SearchLimit(u8);

impl SearchLimit {
    pub const MAX: usize = 100;
    pub const DEFAULT: Self = Self(20);

    pub fn get(self) -> usize {
        usize::from(self.0)
    }
}

impl TryFrom<usize> for SearchLimit {
    type Error = SearchError;

    fn try_from(value: usize) -> Result<Self, Self::Error> {
        if value > Self::MAX {
            return Err(SearchError::LimitOutOfRange {
                value,
                maximum: Self::MAX,
            });
        }
        Ok(Self(value as u8))
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SearchWeights {
    pub(crate) title: f32,
    pub(crate) headings: f32,
    pub(crate) tags: f32,
    pub(crate) content: f32,
    pub(crate) recency_boost: f32,
}

impl SearchWeights {
    pub const MAX: f32 = 1000.0;
    pub(crate) const PATH: f32 = 7.0;

    pub fn new(
        title: f32,
        headings: f32,
        tags: f32,
        content: f32,
        recency_boost: f32,
    ) -> Result<Self, SearchError> {
        for (field, value) in [
            ("titleWeight", title),
            ("headingWeight", headings),
            ("tagWeight", tags),
            ("contentWeight", content),
            ("recencyBoost", recency_boost),
        ] {
            if !(0.0..=Self::MAX).contains(&value) {
                return Err(SearchError::InvalidInput { field });
            }
        }
        Ok(Self {
            title,
            headings,
            tags,
            content,
            recency_boost,
        })
    }

    pub fn title(&self) -> f32 {
        self.title
    }

    pub fn headings(&self) -> f32 {
        self.headings
    }

    pub fn tags(&self) -> f32 {
        self.tags
    }

    pub fn content(&self) -> f32 {
        self.content
    }

    pub fn recency_boost(&self) -> f32 {
        self.recency_boost
    }
}

impl Default for SearchWeights {
    fn default() -> Self {
        Self {
            title: 10.0,
            headings: 5.0,
            tags: 2.0,
            content: 1.0,
            recency_boost: 0.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SearchOptions {
    pub(crate) mode: SearchMode,
    pub(crate) fuzziness: Fuzziness,
    pub(crate) limit: SearchLimit,
    pub(crate) weights: SearchWeights,
    pub(crate) now_ms: i64,
}

impl SearchOptions {
    pub fn new(
        mode: SearchMode,
        fuzziness: Fuzziness,
        limit: SearchLimit,
    ) -> Result<Self, SearchError> {
        if mode == SearchMode::TypoOnly && fuzziness == Fuzziness::Disabled {
            return Err(SearchError::InvalidInput { field: "fuzziness" });
        }
        Ok(Self {
            mode,
            fuzziness,
            limit,
            ..Self::default()
        })
    }

    pub fn with_weights(mut self, weights: SearchWeights) -> Self {
        self.weights = weights;
        self
    }

    pub fn with_now_ms(mut self, now_ms: i64) -> Self {
        self.now_ms = now_ms;
        self
    }
}

impl Default for SearchOptions {
    fn default() -> Self {
        Self {
            mode: SearchMode::ExactPrefix,
            fuzziness: Fuzziness::OneEdit,
            limit: SearchLimit::DEFAULT,
            weights: SearchWeights::default(),
            now_ms: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteRange {
    start: u32,
    end: u32,
}

impl NoteRange {
    pub fn new(start: u32, end: u32) -> Result<Self, SearchError> {
        if start > end {
            return Err(SearchError::InvalidRange { start, end });
        }
        Ok(Self { start, end })
    }

    pub fn start(&self) -> u32 {
        self.start
    }

    pub fn end(&self) -> u32 {
        self.end
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExcerptRange {
    start: u32,
    end: u32,
}

impl ExcerptRange {
    pub fn new(start: u32, end: u32) -> Result<Self, SearchError> {
        if start > end {
            return Err(SearchError::InvalidRange { start, end });
        }
        Ok(Self { start, end })
    }

    pub fn start(&self) -> u32 {
        self.start
    }

    pub fn end(&self) -> u32 {
        self.end
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatchInfo {
    pub match_text: String,
    pub range: NoteRange,
    pub fuzzy: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SearchResult {
    pub note_id: String,
    pub revision: i64,
    pub source_hash: String,
    pub title: String,
    pub path: String,
    pub score: f32,
    pub matched_terms: Vec<String>,
    pub excerpt: String,
    pub excerpt_ranges: Vec<ExcerptRange>,
    pub source_reveal_range: Option<NoteRange>,
    pub local_revision: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum QuickOpenPriority {
    Pinned,
    Recent,
    Exact,
    Prefix,
    Subsequence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuickOpenField {
    Title,
    Filename,
    Path,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuickOpenRange {
    field: QuickOpenField,
    start: u32,
    end: u32,
}

impl QuickOpenRange {
    pub(crate) fn new(field: QuickOpenField, start: u32, end: u32) -> Result<Self, SearchError> {
        if start > end {
            return Err(SearchError::InvalidRange { start, end });
        }
        Ok(Self { field, start, end })
    }

    pub fn field(&self) -> QuickOpenField {
        self.field
    }

    pub fn start(&self) -> u32 {
        self.start
    }

    pub fn end(&self) -> u32 {
        self.end
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuickOpenHit {
    pub identity: NoteIdentity,
    pub priority: QuickOpenPriority,
    pub score: u16,
    pub ranges: Vec<QuickOpenRange>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuickOpenResponse {
    pub hits: Vec<QuickOpenHit>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirtyNoteSnapshot {
    identity: NoteIdentity,
    base_revision: i64,
    base_source_hash: String,
    local_revision: u64,
    source: String,
    headings: String,
}

impl DirtyNoteSnapshot {
    pub fn new(
        identity: NoteIdentity,
        base_revision: i64,
        base_source_hash: String,
        local_revision: u64,
        source: String,
        headings: String,
    ) -> Result<Self, SearchError> {
        if identity.revision() != base_revision || identity.source_hash() != base_source_hash {
            return Err(SearchError::InvalidInput {
                field: "overlay base",
            });
        }
        if source.contains('\r') {
            return Err(SearchError::InvalidInput { field: "overlay source" });
        }
        Ok(Self {
            identity,
            base_revision,
            base_source_hash,
            local_revision,
            source,
            headings,
        })
    }

    pub fn identity(&self) -> &NoteIdentity {
        &self.identity
    }

    pub fn base_revision(&self) -> i64 {
        self.base_revision
    }

    pub fn base_source_hash(&self) -> &str {
        &self.base_source_hash
    }

    pub fn local_revision(&self) -> u64 {
        self.local_revision
    }

    pub fn source(&self) -> &str {
        &self.source
    }

    pub fn headings(&self) -> &str {
        &self.headings
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct OverlaySearchResult {
    pub hits: Vec<SearchResult>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateOutcome {
    Applied,
    Stale,
    Overflow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SearchStatus {
    pub dirty: bool,
    pub degraded: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limit_accepts_zero_and_maximum() {
        assert_eq!(SearchLimit::try_from(0).unwrap().get(), 0);
        assert_eq!(SearchLimit::try_from(100).unwrap().get(), 100);
    }

    #[test]
    fn limit_rejects_values_over_the_contract_maximum() {
        assert!(matches!(
            SearchLimit::try_from(101),
            Err(SearchError::LimitOutOfRange {
                value: 101,
                maximum: 100
            })
        ));
    }

    #[test]
    fn ranges_are_half_open_and_reject_reversed_offsets() {
        assert_eq!(NoteRange::new(2, 5).unwrap().start(), 2);
        assert_eq!(ExcerptRange::new(2, 5).unwrap().end(), 5);
        assert!(NoteRange::new(5, 2).is_err());
        assert!(ExcerptRange::new(5, 2).is_err());
    }

    #[test]
    fn fuzziness_skips_short_terms_and_bounds_edits() {
        assert_eq!(Fuzziness::TwoEdits.distance_for("cat"), 0);
        assert_eq!(Fuzziness::OneEdit.distance_for("tacos"), 1);
        assert_eq!(Fuzziness::TwoEdits.distance_for("tacos"), 1);
        assert_eq!(Fuzziness::TwoEdits.distance_for("tacoshop"), 2);
    }

    #[test]
    fn note_source_requires_lf_and_valid_identity() {
        let identity = NoteIdentity::new(
            "id".into(),
            "note.md".into(),
            "note".into(),
            vec![],
            1,
            "sha256-v2:abc".into()
        )
        .unwrap();
        assert!(DocumentInput::new(identity, "line\n".into(), String::new()).is_ok());
        let identity = NoteIdentity::new(
            "id".into(),
            "note.md".into(),
            "note".into(),
            vec![],
            1,
            "sha256-v2:abc".into(),
        )
        .unwrap();
        assert!(matches!(
            DocumentInput::new(identity, "line\r\n".into(), String::new()),
            Err(SearchError::InvalidInput { field: "content" })
        ));
    }

    #[test]
    fn typo_only_options_require_fuzziness() {
        assert!(matches!(
            SearchOptions::new(
                SearchMode::TypoOnly,
                Fuzziness::Disabled,
                SearchLimit::DEFAULT,
            ),
            Err(SearchError::InvalidInput { field: "fuzziness" })
        ));
    }
}
