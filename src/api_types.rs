use serde::{Deserialize, Serialize};
use std::ops::RangeInclusive;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct NoteMeta {
    pub note_id: String,
    pub path: String,
    pub title: String,
    pub tags: Vec<String>,
    #[ts(type = "number")]
    pub seq: i64,
    pub content_hash: String,
    #[ts(type = "number")]
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RevisionMeta {
    #[ts(type = "number")]
    pub event_id: i64,
    pub note_id: String,
    #[ts(type = "number")]
    pub seq: i64,
    pub kind: NoteEventKind,
    pub source: NoteEventSource,
    pub content_hash: Option<String>,
    #[ts(type = "number")]
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum NoteEventKind {
    Baseline,
    Create,
    Import,
    Save,
    Rename,
    Delete,
    ExternalEdit,
    ExternalRename,
    ExternalDelete,
    ConflictRecovery,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum NoteEventSource {
    User,
    Import,
    External,
    Repair,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConflictDraftMeta {
    #[ts(type = "number")]
    pub draft_id: i64,
    pub note_id: String,
    #[ts(type = "number")]
    pub base_seq: i64,
    pub base_hash: String,
    pub content_hash: String,
    #[ts(type = "number")]
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct Settings {
    pub excluded_folders: Vec<String>,
    pub search_title_weight: f32,
    pub search_heading_weight: f32,
    pub search_tag_weight: f32,
    pub search_content_weight: f32,
    pub recency_boost: f32,
    #[ts(type = "number")]
    pub autosave_delay_ms: u64,
    #[ts(type = "number")]
    pub undo_stack_max: usize,
    pub image_webp_quality: f32,
}

pub const AUTOSAVE_DELAY_MS_RANGE: RangeInclusive<u64> = 150..=3_600_000;
pub const UNDO_STACK_MAX_RANGE: RangeInclusive<usize> = 20..=10_000;
pub const IMAGE_WEBP_QUALITY_RANGE: RangeInclusive<f32> = 0.1..=1.0;
pub const SEARCH_WEIGHT_RANGE: RangeInclusive<f32> = 0.0..=tansu_search::SearchWeights::MAX;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidSettings(String);

impl InvalidSettings {
    pub fn message(&self) -> &str {
        &self.0
    }

    pub fn into_message(self) -> String {
        self.0
    }
}

impl std::fmt::Display for InvalidSettings {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for InvalidSettings {}

#[derive(Debug, Clone)]
pub struct ValidatedSettings(Settings);

impl ValidatedSettings {
    pub fn as_settings(&self) -> &Settings {
        &self.0
    }

    pub fn into_settings(self) -> Settings {
        self.0
    }
}

impl TryFrom<Settings> for ValidatedSettings {
    type Error = InvalidSettings;

    fn try_from(settings: Settings) -> Result<Self, Self::Error> {
        for folder in &settings.excluded_folders {
            if folder.is_empty()
                || folder == "."
                || folder == ".."
                || folder.contains(['/', '\\', '\0'])
            {
                return Err(InvalidSettings(format!(
                    "excludedFolders entries must be single folder names, got {folder:?}"
                )));
            }
        }
        check_range(
            "autosaveDelayMs",
            settings.autosave_delay_ms,
            &AUTOSAVE_DELAY_MS_RANGE,
        )?;
        check_range("undoStackMax", settings.undo_stack_max, &UNDO_STACK_MAX_RANGE)?;
        check_range(
            "imageWebpQuality",
            settings.image_webp_quality,
            &IMAGE_WEBP_QUALITY_RANGE,
        )?;
        check_range("searchTitleWeight", settings.search_title_weight, &SEARCH_WEIGHT_RANGE)?;
        check_range(
            "searchHeadingWeight",
            settings.search_heading_weight,
            &SEARCH_WEIGHT_RANGE,
        )?;
        check_range("searchTagWeight", settings.search_tag_weight, &SEARCH_WEIGHT_RANGE)?;
        check_range(
            "searchContentWeight",
            settings.search_content_weight,
            &SEARCH_WEIGHT_RANGE,
        )?;
        check_range("recencyBoost", settings.recency_boost, &SEARCH_WEIGHT_RANGE)?;
        Ok(Self(settings))
    }
}

fn check_range<T>(field: &str, value: T, range: &RangeInclusive<T>) -> Result<(), InvalidSettings>
where
    T: PartialOrd + std::fmt::Display,
{
    if range.contains(&value) {
        Ok(())
    } else {
        Err(InvalidSettings(format!(
            "{field} must be a finite value between {} and {}, got {value}",
            range.start(),
            range.end()
        )))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppVaultSettings {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppAuthSettings {
    pub external_origin: String,
    pub rp_id: String,
    pub rp_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppSettings {
    pub vaults: Vec<AppVaultSettings>,
    pub auth: Option<AppAuthSettings>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct V2AppSettingsResponse {
    pub settings: Option<AppSettings>,
    pub restart_required: bool,
}

impl Default for Settings {
    fn default() -> Self {
        let weights = tansu_search::SearchWeights::default();
        Self {
            excluded_folders: Vec::new(),
            search_title_weight: weights.title(),
            search_heading_weight: weights.headings(),
            search_tag_weight: weights.tags(),
            search_content_weight: weights.content(),
            recency_boost: weights.recency_boost(),
            autosave_delay_ms: 900,
            undo_stack_max: 200,
            image_webp_quality: 0.85,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SearchStatus {
    pub dirty: bool,
    pub degraded: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct TextEdit {
    pub start: TextPosition,
    pub end: TextPosition,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct TextPosition {
    #[ts(type = "number")]
    pub line: usize,
    #[ts(type = "number")]
    pub character: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum ApiErrorKind {
    PathInvalid {
        reason: PathValidationReason,
    },
    PathCollision {
        path: String,
    },
    NoteNotFound {
        note_id: String,
    },
    UnresolvedNote {
        note_id: String,
        reason: UnresolvedReason,
    },
    BadRequest {
        message: String,
    },
    Internal {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum PathValidationReason {
    Empty,
    Absolute,
    Traversal,
    DotTansu,
    NotMarkdown,
    NestedVault,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum UnresolvedReason {
    CaseFoldCollision,
    InvalidUtf8,
    MissingSnapshot,
    CorruptSnapshot,
    FileCatalogMismatch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct V2VaultMeta {
    pub vault_id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct V2BootstrapResponse {
    #[ts(type = "number")]
    pub api_version: u32,
    pub server_instance_id: String,
    pub vaults: Vec<V2VaultMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct V2VaultBootstrapResponse {
    pub vault: V2VaultMeta,
    pub notes: Vec<V2NoteMeta>,
    pub settings: Settings,
    pub search_status: SearchStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct V2NoteMeta {
    pub note_id: String,
    pub path: String,
    pub title: String,
    pub tags: Vec<String>,
    #[ts(type = "number")]
    pub revision: i64,
    pub source_hash: String,
    pub disk_hash: String,
    #[ts(type = "number")]
    pub source_hash_format_version: u16,
    #[ts(type = "number")]
    pub disk_hash_format_version: u16,
    #[ts(type = "number")]
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct V2NoteDocument {
    pub meta: V2NoteMeta,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct V2LinkedNote {
    pub note_id: String,
    pub path: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct V2Backlink {
    pub note: V2LinkedNote,
    pub mentions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct V2NoteLinksResponse {
    pub backlinks: Vec<V2Backlink>,
    pub outgoing: Vec<V2LinkedNote>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct V2NotePreview {
    pub note_id: String,
    pub preview: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct V2NotePrecondition {
    #[ts(type = "number")]
    pub base_revision: i64,
    pub base_source_hash: String,
    pub base_disk_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct V2CreateNoteRequest {
    pub mutation_id: String,
    pub path: String,
    pub content: String,
    pub source_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct V2SaveNoteRequest {
    pub mutation_id: String,
    pub precondition: V2NotePrecondition,
    pub content: String,
    pub source_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct V2SaveNoteDeltaRequest {
    pub mutation_id: String,
    pub precondition: V2NotePrecondition,
    pub source_hash: String,
    pub edits: Vec<TextEdit>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct V2RenameNoteRequest {
    pub mutation_id: String,
    pub precondition: V2NotePrecondition,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct V2DeleteNoteRequest {
    pub mutation_id: String,
    pub precondition: V2NotePrecondition,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct V2RestoreRevisionRequest {
    pub mutation_id: String,
    pub precondition: V2NotePrecondition,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct V2RestoreConflictRequest {
    pub mutation_id: String,
    pub precondition: V2NotePrecondition,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct V2ConflictDraftMeta {
    #[ts(type = "number")]
    pub draft_id: i64,
    pub note_id: String,
    #[ts(type = "number")]
    pub base_revision: i64,
    pub base_source_hash: String,
    pub source_hash: String,
    #[ts(type = "number")]
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct V2ConflictDraftDocument {
    pub draft: V2ConflictDraftMeta,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct V2RevisionMeta {
    #[ts(type = "number")]
    pub revision: i64,
    pub note_id: String,
    pub kind: NoteEventKind,
    pub source: NoteEventSource,
    pub source_hash: Option<String>,
    #[ts(type = "number")]
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct V2RevisionDocument {
    pub revision: V2RevisionMeta,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct V2SettingsRequest {
    pub mutation_id: String,
    pub settings: Settings,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct V2SettingsResponse {
    pub mutation_id: String,
    pub settings: Settings,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct V2ImageUploadResponse {
    pub mutation_id: String,
    pub name: String,
    pub markdown: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum V2MutationOutcome {
    Accepted { result: Option<V2NoteMeta> },
    PendingMaterialization {
        operation_id: String,
    },
    Conflict {
        current: Box<V2NoteDocument>,
        draft: V2ConflictDraftMeta,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct V2MutationResponse {
    pub mutation_id: String,
    pub outcome: V2MutationOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum V2SearchMode {
    Default,
    TypoOnly,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum V2SearchOverlay {
    Saved {
        note_id: String,
        #[ts(type = "number")]
        base_revision: i64,
        base_source_hash: String,
        #[ts(type = "number")]
        local_revision: u64,
        title: String,
        path: String,
        content: String,
    },
    New {
        local_id: String,
        #[ts(type = "number")]
        local_revision: u64,
        title: String,
        path: String,
        content: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct V2SearchRequest {
    pub query: String,
    pub mode: V2SearchMode,
    pub limit: u16,
    pub overlays: Vec<V2SearchOverlay>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct V2ExcerptRange {
    #[ts(type = "number")]
    pub start_utf16: u32,
    #[ts(type = "number")]
    pub end_utf16: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct V2SourceRange {
    #[ts(type = "number")]
    pub start_utf16: u32,
    #[ts(type = "number")]
    pub end_utf16: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum V2SearchHitIdentity {
    Canonical {
        note_id: String,
        #[ts(type = "number")]
        revision: i64,
        source_hash: String,
    },
    SavedOverlay {
        note_id: String,
        #[ts(type = "number")]
        local_revision: u64,
        source_hash: String,
    },
    NewLocalDraft {
        local_id: String,
        #[ts(type = "number")]
        local_revision: u64,
        source_hash: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct V2SearchHit {
    pub identity: V2SearchHitIdentity,
    pub title: String,
    pub path: String,
    pub score: f32,
    pub excerpt: String,
    pub excerpt_ranges: Vec<V2ExcerptRange>,
    pub source_range: Option<V2SourceRange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum V2OverlayCoverage {
    Complete,
    Partial { skipped_note_count: u16 },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct V2SearchResponse {
    pub hits: Vec<V2SearchHit>,
    pub overlay_coverage: V2OverlayCoverage,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct V2QuickOpenRequest {
    pub query: String,
    pub pinned_note_ids: Vec<String>,
    pub recent_note_ids: Vec<String>,
    pub limit: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct V2QuickOpenHit {
    pub note_id: String,
    pub source_hash: String,
    pub title: String,
    pub path: String,
    pub score: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct V2QuickOpenResponse {
    pub hits: Vec<V2QuickOpenHit>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum V2ServerEventUpdate {
    Ready,
    VaultChanged { notes: Vec<V2NoteMeta> },
    NoteChanged { note: V2NoteMeta },
    NoteDeleted { note_id: String },
    SearchChanged { dirty: bool, degraded: bool },
    ResyncRequired,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct V2ServerEvent {
    #[ts(type = "number")]
    event_version: u64,
    resync_required: bool,
    update: V2ServerEventUpdate,
}

impl V2ServerEvent {
    pub fn new(event_version: u64, update: V2ServerEventUpdate) -> Self {
        let resync_required = matches!(update, V2ServerEventUpdate::ResyncRequired);
        Self {
            event_version,
            resync_required,
            update,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct V2ApiErrorResponse {
    pub error: V2ApiErrorKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(
    tag = "code",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum V2ApiErrorKind {
    ApiVersionUnsupported {
        requested_version: Option<u32>,
        supported_version: u32,
    },
    VaultNotFound {
        vault_id: String,
    },
    ServerInstanceMismatch {
        expected: String,
        received: String,
    },
    MutationIdReuse {
        mutation_id: String,
    },
    PathInvalid {
        reason: PathValidationReason,
    },
    PathCollision {
        path: String,
    },
    NoteNotFound {
        note_id: String,
    },
    RevisionNotFound {
        note_id: String,
        #[ts(type = "number")]
        revision: i64,
    },
    ConflictDraftNotFound {
        note_id: String,
        #[ts(type = "number")]
        draft_id: i64,
    },
    AssetNotFound {
        name: String,
    },
    SaveConflict {
        current: Box<V2NoteDocument>,
        draft: V2ConflictDraftMeta,
    },
    UnresolvedNote {
        note_id: String,
        reason: UnresolvedReason,
    },
    SourceHashMismatch {
        expected: String,
        received: String,
    },
    DiskHashMismatch {
        expected: String,
        received: String,
    },
    RequestTooLarge {
        limit_bytes: u32,
    },
    AuthRequired,
    Forbidden,
    CsrfRejected,
    OriginRejected,
    RateLimited {
        retry_after_ms: u32,
    },
    NotImplemented,
    BadRequest {
        message: String,
    },
    Internal {
        request_id: String,
    },
}

#[cfg(test)]
mod v2_tests {
    use super::{V2ApiErrorKind, V2ServerEvent, V2ServerEventUpdate};
    use serde_json::json;

    #[test]
    fn v2_error_uses_code_discriminator_and_camel_case_fields() {
        let error = V2ApiErrorKind::MutationIdReuse {
            mutation_id: "mutation-1".to_string(),
        };

        assert_eq!(
            serde_json::to_value(error).unwrap(),
            json!({"code": "mutation_id_reuse", "mutationId": "mutation-1"})
        );
    }

    #[test]
    fn resync_flag_tracks_the_event_update_variant() {
        let ordinary = V2ServerEvent::new(7, V2ServerEventUpdate::Ready);
        let resync = V2ServerEvent::new(8, V2ServerEventUpdate::ResyncRequired);

        assert_eq!(
            serde_json::to_value(ordinary).unwrap(),
            json!({
                "eventVersion": 7,
                "resyncRequired": false,
                "update": {"kind": "ready"}
            })
        );
        assert_eq!(
            serde_json::to_value(resync).unwrap(),
            json!({
                "eventVersion": 8,
                "resyncRequired": true,
                "update": {"kind": "resyncRequired"}
            })
        );
    }
}

#[cfg(test)]
mod settings_tests {
    use super::*;

    #[test]
    fn defaults_and_range_boundaries_are_valid() {
        assert!(ValidatedSettings::try_from(Settings::default()).is_ok());
        let low = Settings {
            autosave_delay_ms: *AUTOSAVE_DELAY_MS_RANGE.start(),
            undo_stack_max: *UNDO_STACK_MAX_RANGE.start(),
            image_webp_quality: *IMAGE_WEBP_QUALITY_RANGE.start(),
            search_title_weight: *SEARCH_WEIGHT_RANGE.start(),
            ..Settings::default()
        };
        assert!(ValidatedSettings::try_from(low).is_ok());
        let high = Settings {
            autosave_delay_ms: *AUTOSAVE_DELAY_MS_RANGE.end(),
            undo_stack_max: *UNDO_STACK_MAX_RANGE.end(),
            image_webp_quality: *IMAGE_WEBP_QUALITY_RANGE.end(),
            recency_boost: *SEARCH_WEIGHT_RANGE.end(),
            ..Settings::default()
        };
        assert!(ValidatedSettings::try_from(high).is_ok());
    }

    #[test]
    fn serialized_representation_is_unchanged() {
        let value = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(value["autosaveDelayMs"], 900);
        assert_eq!(value["undoStackMax"], 200);
        assert_eq!(value["excludedFolders"], serde_json::json!([]));
        assert!(value["imageWebpQuality"].is_number());
    }

    #[test]
    fn rejection_names_the_offending_field() {
        let error = ValidatedSettings::try_from(Settings {
            search_tag_weight: f32::NAN,
            ..Settings::default()
        })
        .unwrap_err();
        assert!(error.message().contains("searchTagWeight"), "{error}");
    }
}
