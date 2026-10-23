use std::io;

#[derive(Debug, thiserror::Error)]
pub enum SearchError {
    #[error("search index failed: {0}")]
    Tantivy(#[from] tantivy::TantivyError),
    #[error("search index could not be opened: {source}")]
    IndexOpen {
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },
    #[error("search index directory failed: {0}")]
    DirectoryOpen(#[from] tantivy::directory::error::OpenDirectoryError),
    #[error("search index read failed: {0}")]
    DirectoryRead(#[from] tantivy::directory::error::OpenReadError),
    #[error("search index I/O failed: {0}")]
    Io(#[from] io::Error),
    #[error("search input field is invalid: {field}")]
    InvalidInput { field: &'static str },
    #[error("search limit {value} exceeds {maximum}")]
    LimitOutOfRange { value: usize, maximum: usize },
    #[error("search query is {bytes} bytes; maximum is {maximum}")]
    QueryTooLong { bytes: usize, maximum: usize },
    #[error("search range start {start} exceeds end {end}")]
    InvalidRange { start: u32, end: u32 },
    #[error("search index schema does not match this version")]
    SchemaMismatch,
    #[error("search index metadata is corrupt")]
    CorruptIndex,
    #[error("overlay contains note identity more than once")]
    DuplicateOverlayNote,
}
