#[cfg(not(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(
        target_os = "linux",
        target_env = "musl",
        any(target_arch = "x86_64", target_arch = "aarch64")
    )
)))]
compile_error!(
    "tansu2 supports only aarch64-apple-darwin, x86_64-unknown-linux-musl, and aarch64-unknown-linux-musl"
);

pub mod api;
pub mod api_types;
pub mod auth;
pub mod app;
pub mod catalog;
mod cancellation;
pub use cancellation::CancellationToken;
pub mod config;
pub mod history;
pub mod http;
pub mod embedded_assets;
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
    Toml(toml::de::Error),
    NotFound(String),
    Internal(String),
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
            Self::Io(error) => write!(f, "{error}"),
            Self::Json(error) => write!(f, "{error}"),
            Self::Sql(error) => write!(f, "{error}"),
            Self::Toml(error) => write!(f, "{error}"),
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

impl From<toml::de::Error> for Error {
    fn from(value: toml::de::Error) -> Self {
        Self::Toml(value)
    }
}
