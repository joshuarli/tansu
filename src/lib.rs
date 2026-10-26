#[cfg(not(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(
        target_os = "linux",
        target_env = "musl",
        any(target_arch = "x86_64", target_arch = "aarch64")
    )
)))]
compile_error!(
    "tansu supports only aarch64-apple-darwin, x86_64-unknown-linux-musl, and aarch64-unknown-linux-musl"
);

pub mod api;
pub use tansu_api_types as api_types;
pub mod auth;
pub mod app;
pub mod catalog;
mod cancellation;
pub use cancellation::CancellationToken;
pub mod config;
#[cfg(test)]
mod failure_point;
pub mod history;
pub mod http;
pub mod embedded_assets;
pub mod links;
pub mod logging;
pub mod paths;
pub mod reconcile;
pub mod search;
pub mod tags;
pub mod vault;

use crate::api_types::ApiErrorKind;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug)]
pub enum Error {
    Api(Box<ApiErrorKind>),
    BadRequest(String),
    Io(std::io::Error),
    Json(serde_json::Error),
    Sql(rusqlite::Error),
    NotFound(String),
    Internal(String),
    VaultAlreadyOwned { root: std::path::PathBuf },
}

impl Error {
    pub fn api(error: ApiErrorKind) -> Self {
        Self::Api(Box::new(error))
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Api(error) => write!(f, "{error:?}"),
            Self::BadRequest(message) | Self::NotFound(message) | Self::Internal(message) => {
                f.write_str(message)
            }
            Self::VaultAlreadyOwned { root } => write!(
                f,
                "vault root {} is already owned by another Tansu server",
                root.display()
            ),
            Self::Io(error) => write!(f, "{error}"),
            Self::Json(error) => write!(f, "{error}"),
            Self::Sql(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for Error {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

impl From<rusqlite::Error> for Error {
    fn from(value: rusqlite::Error) -> Self {
        Self::Sql(value)
    }
}

impl From<tansu_note_core::InvalidUtf8> for Error {
    fn from(value: tansu_note_core::InvalidUtf8) -> Self {
        Self::BadRequest(value.to_string())
    }
}

impl From<tansu_note_core::SourceNotLf> for Error {
    fn from(value: tansu_note_core::SourceNotLf) -> Self {
        Self::BadRequest(value.to_string())
    }
}

impl From<notify::Error> for Error {
    fn from(value: notify::Error) -> Self {
        Self::Internal(value.to_string())
    }
}

impl From<tantivy::TantivyError> for Error {
    fn from(value: tantivy::TantivyError) -> Self {
        Self::Internal(value.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_preserve_display_and_dependency_context() {
        let json_error = serde_json::from_str::<serde_json::Value>("{").unwrap_err();
        let errors = [
            Error::api(ApiErrorKind::PathCollision { path: "A.md".to_string() }),
            Error::BadRequest("bad request".to_string()),
            Error::Io(std::io::Error::other("filesystem")),
            Error::Json(json_error),
            Error::Sql(rusqlite::Error::InvalidQuery),
            Error::NotFound("missing".to_string()),
            Error::Internal("internal".to_string()),
            notify::Error::generic("watcher").into(),
            tantivy::TantivyError::InvalidArgument("query".to_string()).into(),
        ];

        let messages = errors.into_iter().map(|error| error.to_string()).collect::<Vec<_>>();
        assert!(messages[0].contains("PathCollision"));
        assert_eq!(messages[1], "bad request");
        assert!(messages[2].contains("filesystem"));
        assert!(!messages[3].is_empty());
        assert!(!messages[4].is_empty());
        assert!(!messages[5].is_empty());
        assert_eq!(messages[5], "missing");
        assert_eq!(messages[6], "internal");
        assert!(messages[7].contains("watcher"));
        assert!(messages[8].contains("query"));
    }
}
