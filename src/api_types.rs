use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct NoteResponse {
    pub content: String,
    pub mtime: u64,
    pub tags: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct SaveResult {
    pub mtime: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub conflict: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub content: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct FieldScores {
    pub title: f32,
    pub headings: f32,
    pub tags: f32,
    pub content: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct SearchHit {
    pub path: String,
    pub title: String,
    pub tags: Vec<String>,
    pub excerpt: String,
    pub score: f32,
    pub field_scores: FieldScores,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct NoteEntry {
    pub path: String,
    pub title: String,
    pub tags: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct TagListResponse {
    pub tags: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct FileSearchResult {
    pub path: String,
    pub title: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct RecentFileEntry {
    pub path: String,
    pub title: String,
    pub mtime: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct PinnedFileEntry {
    pub path: String,
    pub title: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct RenameResponse {
    pub updated: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct FilenameResponse {
    pub filename: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct ContentResponse {
    pub content: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct OkResponse {
    pub ok: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct PutNoteRequest {
    pub content: String,
    #[serde(default)]
    pub expected_mtime: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct CreateNoteRequest {
    #[serde(default)]
    pub content: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct RenameRequest {
    pub old_path: String,
    pub new_path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct PinRequest {
    pub path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct SessionState {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tabs: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub active: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub closed: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cursors: Option<std::collections::HashMap<String, usize>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct AppStatus {
    pub locked: bool,
    pub encrypted: bool,
    pub needs_setup: bool,
    pub prf_credential_ids: Vec<String>,
    pub prf_credential_names: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct VaultEntry {
    pub index: usize,
    pub name: String,
    pub active: bool,
    pub encrypted: bool,
    pub locked: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct UnlockRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub recovery_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub prf_key: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct PrfRegisterRequest {
    pub credential_id: String,
    pub prf_key: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct PrfRemoveRequest {
    pub credential_id: String,
}
