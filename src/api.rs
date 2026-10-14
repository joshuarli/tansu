use crate::api_types::{
    ApiErrorKind, ApiErrorResponse, CreateNoteRequest, RenameNoteRequest, SaveNoteDeltaRequest,
    SaveNoteRequest, SessionState, Settings, V2ApiErrorKind, V2ApiErrorResponse,
    V2CreateNoteRequest, V2DeleteNoteRequest, V2RenameNoteRequest, V2RestoreConflictRequest,
    V2RestoreRevisionRequest, V2SaveNoteDeltaRequest, V2SaveNoteRequest, V2SearchRequest,
    V2QuickOpenRequest, V2SettingsRequest,
};
use crate::app::App;
use crate::http::{HttpRequest, HttpResponse};
use crate::search::DEFAULT_SEARCH_LIMIT;
use crate::vault::V2VaultError;
use crate::{Error, Result};

pub const API_VERSION: u32 = 1;

pub fn handle_v2_api(app: &App, request: &HttpRequest, request_id: &str) -> HttpResponse {
    match dispatch_v2_api(app, request) {
        Ok(response) => response,
        Err(error) => v2_vault_error_response(error, request_id),
    }
}

pub(crate) fn v2_api_error_response(error: V2ApiErrorKind, request_id: &str) -> HttpResponse {
    let response = V2ApiErrorResponse { error };
    HttpResponse::json(v2_api_error_status(&response.error), &response)
        .unwrap_or_else(|_| HttpResponse::text(500, &format!("internal serialization error: {request_id}")))
}

fn v2_vault_error_response(error: V2VaultError, request_id: &str) -> HttpResponse {
    let error = match error {
        V2VaultError::Api(error) => error,
        V2VaultError::Internal(Error::BadRequest(message)) => V2ApiErrorKind::BadRequest { message },
        V2VaultError::Internal(_) => V2ApiErrorKind::Internal {
            request_id: request_id.to_string(),
        },
    };
    v2_api_error_response(error, request_id)
}

fn v2_api_error_status(error: &V2ApiErrorKind) -> u16 {
    match error {
        V2ApiErrorKind::VaultNotFound { .. }
        | V2ApiErrorKind::NoteNotFound { .. }
        | V2ApiErrorKind::RevisionNotFound { .. }
        | V2ApiErrorKind::ConflictDraftNotFound { .. }
        | V2ApiErrorKind::AssetNotFound { .. } => 404,
        V2ApiErrorKind::PathInvalid { .. }
        | V2ApiErrorKind::SourceHashMismatch { .. }
        | V2ApiErrorKind::BadRequest { .. } => 400,
        V2ApiErrorKind::ServerInstanceMismatch { .. }
        | V2ApiErrorKind::ApiVersionUnsupported { .. }
        | V2ApiErrorKind::MutationIdReuse { .. }
        | V2ApiErrorKind::PathCollision { .. }
        | V2ApiErrorKind::SaveConflict { .. }
        | V2ApiErrorKind::UnresolvedNote { .. }
        | V2ApiErrorKind::DiskHashMismatch { .. } => 409,
        V2ApiErrorKind::RequestTooLarge { .. } => 413,
        V2ApiErrorKind::AuthRequired => 401,
        V2ApiErrorKind::Forbidden
        | V2ApiErrorKind::CsrfRejected
        | V2ApiErrorKind::OriginRejected => 403,
        V2ApiErrorKind::RateLimited { .. } => 429,
        V2ApiErrorKind::NotImplemented => 501,
        V2ApiErrorKind::Internal { .. } => 500,
    }
}

pub(crate) fn validate_v2_server_instance(
    app: &App,
    headers: &[(String, String)],
) -> std::result::Result<(), V2ApiErrorKind> {
    let values = headers
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case("x-tansu-server-instance"))
        .map(|(_, value)| value.as_str())
        .collect::<Vec<_>>();
    let received = match values.as_slice() {
        [received] => *received,
        [] => "",
        _ => "<multiple>",
    };
    if received == app.server_instance_id() {
        return Ok(());
    }
    let mut received = received.to_string();
    if received.len() > 256 {
        let mut boundary = 256;
        while !received.is_char_boundary(boundary) {
            boundary -= 1;
        }
        received.truncate(boundary);
    }
    Err(V2ApiErrorKind::ServerInstanceMismatch {
        expected: app.server_instance_id().to_string(),
        received,
    })
}

fn dispatch_v2_api(app: &App, request: &HttpRequest) -> std::result::Result<HttpResponse, V2VaultError> {
    let path = request.path.split_once('?').map_or(request.path.as_str(), |(path, _)| path);
    if path == "/api/v2/health" {
        return v2_json(200, &serde_json::json!({ "ok": true, "apiVersion": 2 }), "health");
    }
    if path == "/api/v2/bootstrap" {
        return v2_json(200, &app.v2_bootstrap(), "bootstrap");
    }
    validate_v2_server_instance(app, &request.headers).map_err(V2VaultError::Api)?;
    let rest = path.strip_prefix("/api/v2/vaults/").ok_or_else(|| {
        V2VaultError::Api(V2ApiErrorKind::NotImplemented)
    })?;
    let (vault_id, route) = rest.split_once('/').ok_or_else(|| {
        V2VaultError::Api(V2ApiErrorKind::NotImplemented)
    })?;
    let vault_id = decode_path_segment(vault_id).map_err(V2VaultError::Api)?;
    let vault = app.vault_by_id(&vault_id).map_err(|_| {
        V2VaultError::Api(V2ApiErrorKind::VaultNotFound { vault_id: vault_id.clone() })
    })?;
    let decoded_parts = route
        .split('/')
        .map(decode_path_segment)
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(V2VaultError::Api)?;
    let parts = decoded_parts.iter().map(String::as_str).collect::<Vec<_>>();
    let method = request.method.as_str();
    match (method, parts.as_slice()) {
        ("GET", ["bootstrap"]) => v2_json(200, &vault.v2_vault_bootstrap()?, "vault bootstrap"),
        ("GET", ["notes"]) => v2_json(200, &vault.v2_notes()?, "note list"),
        ("GET", ["notes", note_id]) => v2_json(200, &vault.v2_open_note(note_id)?, "note document"),
        ("POST", ["notes"]) => {
            let body = parse_v2_body::<V2CreateNoteRequest>(&request.body)?;
            v2_json(201, &vault.v2_create_note(body)?, "created note")
        }
        ("PUT", ["notes", note_id]) => {
            let body = parse_v2_body::<V2SaveNoteRequest>(&request.body)?;
            v2_json(200, &vault.v2_save_note(note_id, body)?, "saved note")
        }
        ("PATCH", ["notes", note_id]) => {
            let body = parse_v2_body::<V2SaveNoteDeltaRequest>(&request.body)?;
            v2_json(200, &vault.v2_save_note_delta(note_id, body)?, "saved note delta")
        }
        ("POST", ["notes", note_id, "rename"]) => {
            let body = parse_v2_body::<V2RenameNoteRequest>(&request.body)?;
            v2_json(200, &vault.v2_rename_note(note_id, body)?, "renamed note")
        }
        ("DELETE", ["notes", note_id]) => {
            let body = parse_v2_body::<V2DeleteNoteRequest>(&request.body)?;
            v2_json(200, &vault.v2_delete_note(note_id, body)?, "deleted note")
        }
        ("GET", ["notes", note_id, "revisions"]) => {
            v2_json(200, &vault.v2_list_revisions(note_id)?, "revision list")
        }
        ("GET", ["notes", note_id, "revisions", revision]) => {
            v2_json(200, &vault.v2_open_revision(note_id, parse_v2_id(revision)?)?, "revision")
        }
        ("POST", ["notes", note_id, "revisions", revision, "restore"]) => {
            let body = parse_v2_body::<V2RestoreRevisionRequest>(&request.body)?;
            v2_json(200, &vault.v2_restore_revision(note_id, parse_v2_id(revision)?, body)?, "restored revision")
        }
        ("GET", ["notes", note_id, "conflicts", draft_id]) => {
            v2_json(200, &vault.v2_open_conflict_draft(note_id, parse_v2_id(draft_id)?)?, "conflict draft")
        }
        ("POST", ["notes", note_id, "conflicts", draft_id, "restore"]) => {
            let body = parse_v2_body::<V2RestoreConflictRequest>(&request.body)?;
            v2_json(200, &vault.v2_restore_conflict(note_id, parse_v2_id(draft_id)?, body)?, "restored conflict")
        }
        ("GET", ["settings"]) => v2_json(200, &vault.v2_settings()?, "settings"),
        ("PUT", ["settings"]) => {
            let body = parse_v2_body::<V2SettingsRequest>(&request.body)?;
            v2_json(200, &vault.v2_save_settings(body)?, "saved settings")
        }
        ("POST", ["search"]) => {
            let body = parse_v2_body::<V2SearchRequest>(&request.body)?;
            v2_json(200, &vault.v2_search(body)?, "search results")
        }
        ("POST", ["quick-open"]) => {
            let body = parse_v2_body::<V2QuickOpenRequest>(&request.body)?;
            v2_json(200, &vault.v2_quick_open(body)?, "quick-open results")
        }
        ("POST", ["images"]) => {
            if request_header(request, "content-type")?.as_deref() != Some("image/webp") {
                return Err(V2VaultError::Api(V2ApiErrorKind::BadRequest {
                    message: "image upload requires Content-Type: image/webp".to_string(),
                }));
            }
            let mutation_id = request_header(request, "x-tansu-mutation-id")?.ok_or_else(|| {
                V2VaultError::Api(V2ApiErrorKind::BadRequest {
                    message: "missing X-Tansu-Mutation-Id".to_string(),
                })
            })?;
            v2_json(201, &vault.v2_upload_image(&mutation_id, &request.body)?, "uploaded image")
        }
        ("GET", ["assets"]) => {
            let name = query_param(&request.path, "name")?.ok_or_else(|| {
                V2VaultError::Api(V2ApiErrorKind::BadRequest {
                    message: "missing asset name".to_string(),
                })
            })?;
            Ok(HttpResponse::bytes(200, "image/webp", vault.v2_read_asset(&name)?))
        }
        _ => Err(V2VaultError::Api(V2ApiErrorKind::NotImplemented)),
    }
}

fn v2_json<T: serde::Serialize>(status: u16, value: &T, operation: &str) -> std::result::Result<HttpResponse, V2VaultError> {
    HttpResponse::json(status, value).map_err(|error| {
        V2VaultError::Internal(Error::Internal(format!("could not serialize {operation}: {error}")))
    })
}

fn parse_v2_body<T: serde::de::DeserializeOwned>(body: &[u8]) -> std::result::Result<T, V2VaultError> {
    serde_json::from_slice(body).map_err(|error| {
        V2VaultError::Api(V2ApiErrorKind::BadRequest { message: error.to_string() })
    })
}

fn parse_v2_id(value: &str) -> std::result::Result<i64, V2VaultError> {
    value.parse().map_err(|_| {
        V2VaultError::Api(V2ApiErrorKind::BadRequest {
            message: "resource id must be a signed integer".to_string(),
        })
    })
}

pub(crate) fn decode_path_segment(value: &str) -> std::result::Result<String, V2ApiErrorKind> {
    let decoded = percent_decode_bytes(value, false)?;
    if decoded.contains('/') || decoded.contains('\\') || decoded.is_empty() {
        return Err(V2ApiErrorKind::BadRequest {
            message: "invalid path segment".to_string(),
        });
    }
    Ok(decoded)
}

fn request_header(request: &HttpRequest, name: &str) -> std::result::Result<Option<String>, V2VaultError> {
    let mut values = request.headers.iter().filter(|(header, _)| header.eq_ignore_ascii_case(name));
    let value = values.next().map(|(_, value)| value.clone());
    if values.next().is_some() {
        return Err(V2VaultError::Api(V2ApiErrorKind::BadRequest {
            message: format!("duplicate {name} header"),
        }));
    }
    Ok(value)
}

pub fn handle_api(app: &App, request: &HttpRequest) -> Result<HttpResponse> {
    let vault_index = query_param(&request.path, "vault")?
        .and_then(|value| value.parse::<usize>().ok())
        .or_else(|| {
            request
                .headers
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case("x-tansu-vault"))
                .and_then(|(_, value)| value.parse::<usize>().ok())
        })
        .unwrap_or(0);
    let vault = app.vault(vault_index)?;
    let path = request.path.as_str();
    match (request.method.as_str(), path) {
        ("GET", "/api/health") => json(
            200,
            &serde_json::json!({ "ok": true, "apiVersion": API_VERSION }),
        ),
        ("GET", _) if path.starts_with("/api/assets") => {
            let name = query_param(path, "name")?
                .ok_or_else(|| Error::BadRequest("missing asset name".to_string()))?;
            Ok(HttpResponse::bytes(
                200,
                "image/webp",
                vault.read_asset(&name)?,
            ))
        }
        ("GET", "/api/bootstrap") => json(200, &vault.bootstrap(app.vault_entries(), vault_index)?),
        ("PUT", "/api/session") => {
            let body: SessionState = serde_json::from_slice(&request.body)?;
            vault.save_session(body)?;
            json(200, &serde_json::json!({ "ok": true }))
        }
        ("GET", "/api/settings") => json(200, &vault.settings()?),
        ("PUT", "/api/settings") => {
            let body: Settings = serde_json::from_slice(&request.body)?;
            json(200, &vault.save_settings(body)?)
        }
        ("GET", _) if path.starts_with("/api/search") => {
            let query = query_param(path, "q")?.unwrap_or_default();
            let limit = query_param(path, "limit")?
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(DEFAULT_SEARCH_LIMIT);
            json(200, &vault.search(&query, limit)?)
        }
        ("POST", "/api/notes") => {
            let body: CreateNoteRequest = serde_json::from_slice(&request.body)?;
            json(201, &vault.create_note(body)?)
        }
        ("POST", "/api/images") => json(201, &vault.upload_image(&request.body)?),
        _ => handle_note_route(&vault, request),
    }
}

fn handle_note_route(
    vault: &crate::vault::VaultRuntime,
    request: &HttpRequest,
) -> Result<HttpResponse> {
    let Some(rest) = request.path.strip_prefix("/api/notes/") else {
        return Err(Error::NotFound(request.path.clone()));
    };
    let parts = rest.split('/').collect::<Vec<_>>();
    match (request.method.as_str(), parts.as_slice()) {
        ("GET", [note_id]) => json(200, &vault.open_note(note_id)?),
        ("GET", [note_id, "revisions"]) => json(200, &vault.revisions(note_id)?),
        ("GET", [note_id, "revisions", event_id]) => json(
            200,
            &vault.revision_document(note_id, parse_i64(event_id)?)?,
        ),
        ("POST", [note_id, "revisions", event_id, "restore"]) => {
            json(200, &vault.restore_revision(note_id, parse_i64(event_id)?)?)
        }
        ("GET", [note_id, "conflicts", draft_id]) => {
            json(200, &vault.conflict_draft(note_id, parse_i64(draft_id)?)?)
        }
        ("POST", [note_id, "conflicts", draft_id, "restore"]) => json(
            200,
            &vault.restore_conflict_draft(note_id, parse_i64(draft_id)?)?,
        ),
        ("PUT", [note_id]) => {
            let body: SaveNoteRequest = serde_json::from_slice(&request.body)?;
            json(200, &vault.save_note(note_id, body)?)
        }
        ("PATCH", [note_id]) => {
            let body: SaveNoteDeltaRequest = serde_json::from_slice(&request.body)?;
            json(200, &vault.save_note_delta(note_id, body)?)
        }
        ("POST", [note_id, "rename"]) => {
            let body: RenameNoteRequest = serde_json::from_slice(&request.body)?;
            json(200, &vault.rename_note(note_id, body)?)
        }
        ("DELETE", [note_id]) => json(200, &vault.delete_note(note_id)?),
        ("POST", [note_id, "pin"]) => {
            vault.set_pin(note_id, true)?;
            json(200, &serde_json::json!({ "ok": true }))
        }
        ("DELETE", [note_id, "pin"]) => {
            vault.set_pin(note_id, false)?;
            json(200, &serde_json::json!({ "ok": true }))
        }
        _ => Err(Error::NotFound(request.path.clone())),
    }
}

pub fn api_error_response(error: Error) -> HttpResponse {
    match error {
        Error::Api(error) => HttpResponse::json(
            api_error_status(&error),
            &ApiErrorResponse { error: *error },
        )
        .unwrap_or_else(internal_error),
        Error::NotFound(note_id) => HttpResponse::json(
            404,
            &ApiErrorResponse {
                error: ApiErrorKind::NoteNotFound { note_id },
            },
        )
        .unwrap_or_else(internal_error),
        Error::BadRequest(message) => HttpResponse::json(
            400,
            &ApiErrorResponse {
                error: ApiErrorKind::BadRequest { message },
            },
        )
        .unwrap_or_else(internal_error),
        Error::Json(error) => HttpResponse::json(
            400,
            &ApiErrorResponse {
                error: ApiErrorKind::BadRequest {
                    message: error.to_string(),
                },
            },
        )
        .unwrap_or_else(internal_error),
        other => HttpResponse::json(
            500,
            &ApiErrorResponse {
                error: ApiErrorKind::Internal {
                    message: other.to_string(),
                },
            },
        )
        .unwrap_or_else(internal_error),
    }
}

fn api_error_status(error: &ApiErrorKind) -> u16 {
    match error {
        ApiErrorKind::PathInvalid { .. } | ApiErrorKind::BadRequest { .. } => 400,
        ApiErrorKind::NoteNotFound { .. } => 404,
        ApiErrorKind::PathCollision { .. }
        | ApiErrorKind::SaveConflict { .. }
        | ApiErrorKind::UnresolvedNote { .. } => 409,
        ApiErrorKind::Internal { .. } => 500,
    }
}

fn internal_error(error: serde_json::Error) -> HttpResponse {
    HttpResponse::text(500, &format!("internal serialization error: {error}"))
}

fn json<T: serde::Serialize>(status: u16, value: &T) -> Result<HttpResponse> {
    Ok(HttpResponse::json(status, value)?)
}

fn query_param(path: &str, key: &str) -> Result<Option<String>> {
    let Some(query) = path.split_once('?').map(|(_, query)| query) else {
        return Ok(None);
    };
    let mut found = None;
    for pair in query.split('&') {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        if name == key {
            if found.is_some() {
                return Err(Error::BadRequest(format!("duplicate query parameter {key}")));
            }
            found = Some(percent_decode(value)?);
        }
    }
    Ok(found)
}

fn parse_i64(value: &str) -> Result<i64> {
    value
        .parse()
        .map_err(|_| Error::BadRequest(format!("invalid numeric id {value}")))
}

fn percent_decode(value: &str) -> Result<String> {
    percent_decode_bytes(value, true).map_err(|error| match error {
        V2ApiErrorKind::BadRequest { message } => Error::BadRequest(message),
        _ => unreachable!(),
    })
}

fn percent_decode_bytes(value: &str, plus_as_space: bool) -> std::result::Result<String, V2ApiErrorKind> {
    let mut decoded = Vec::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'%' {
            if index + 2 >= bytes.len() {
                return Err(V2ApiErrorKind::BadRequest { message: "invalid percent encoding".to_string() });
            }
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok();
            let decoded_byte = hex.and_then(|hex| u8::from_str_radix(hex, 16).ok()).ok_or_else(|| {
                V2ApiErrorKind::BadRequest { message: "invalid percent encoding".to_string() }
            })?;
            decoded.push(decoded_byte);
            index += 3;
            continue;
        }
        decoded.push(if plus_as_space && byte == b'+' { b' ' } else { byte });
        index += 1;
    }
    String::from_utf8(decoded).map_err(|_| V2ApiErrorKind::BadRequest {
        message: "query parameter is not valid UTF-8".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_types::{BootstrapResponse, NoteMutationResponse, SearchHit};
    use crate::config::{Config, VaultConfig};
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn query_params_decode_plus_and_reject_bad_hex() {
        assert_eq!(
            query_param("/api/search?q=alpha+beta%2Fgamma", "q").unwrap(),
            Some("alpha beta/gamma".to_string())
        );
        assert!(
            query_param("/api/search?q=%zz", "q")
                .unwrap_err()
                .to_string()
                .contains("invalid percent encoding")
        );
        assert_eq!(query_param("/api/search?q=alpha", "missing").unwrap(), None);
    }

    #[test]
    fn maps_errors_to_stable_http_statuses() {
        let not_found = api_error_response(Error::NotFound("n1".to_string()));
        assert_eq!(not_found.status(), 404);
        assert!(String::from_utf8_lossy(not_found.body()).contains("note_not_found"));

        let conflict = api_error_response(Error::api(ApiErrorKind::PathCollision {
            path: "A.md".to_string(),
        }));
        assert_eq!(conflict.status(), 409);

        let bad = api_error_response(Error::BadRequest("bad".to_string()));
        assert_eq!(bad.status(), 400);
    }

    #[test]
    fn v2_routes_check_server_vault_note_and_revision_identities() {
        let fixture = app_fixture(&[("One", &[("one.md", "# One\n")])]);
        let app = fixture.app();
        let server_id = app.server_instance_id().to_string();
        let vault_id = app.v2_bootstrap().vaults[0].vault_id.clone();

        let bootstrap = handle_v2_api(&app, &v2_request("GET", "/api/v2/bootstrap", None, &[], &[]), "req-1");
        assert_eq!(bootstrap.status(), 200);
        let bootstrap_body: crate::api_types::V2BootstrapResponse = serde_json::from_slice(bootstrap.body()).unwrap();
        assert_eq!(bootstrap_body.server_instance_id, server_id);

        let mismatch = handle_v2_api(
            &app,
            &v2_request(
                "GET",
                "/api/v2/vaults/missing/bootstrap",
                Some("old-server"),
                &[],
                &[],
            ),
            "req-2",
        );
        assert_eq!(mismatch.status(), 409);
        assert!(String::from_utf8_lossy(mismatch.body()).contains("server_instance_mismatch"));

        let unknown_vault = handle_v2_api(
            &app,
            &v2_request("GET", "/api/v2/vaults/missing/bootstrap", Some(&server_id), &[], &[]),
            "req-3",
        );
        assert_eq!(unknown_vault.status(), 404);
        assert!(String::from_utf8_lossy(unknown_vault.body()).contains("vault_not_found"));

        let note_id = app.vault(0).unwrap().v2_notes().unwrap()[0].note_id.clone();
        let missing_note = handle_v2_api(
            &app,
            &v2_request(
                "GET",
                &format!("/api/v2/vaults/{vault_id}/notes/missing"),
                Some(&server_id),
                &[],
                &[],
            ),
            "req-4",
        );
        assert_eq!(missing_note.status(), 404);
        assert!(String::from_utf8_lossy(missing_note.body()).contains("note_not_found"));

        let missing_revision = handle_v2_api(
            &app,
            &v2_request(
                "GET",
                &format!("/api/v2/vaults/{vault_id}/notes/{note_id}/revisions/999999"),
                Some(&server_id),
                &[],
                &[],
            ),
            "req-5",
        );
        assert_eq!(missing_revision.status(), 404);
        assert!(String::from_utf8_lossy(missing_revision.body()).contains("revision_not_found"));

        let route_gap = handle_v2_api(
            &app,
            &v2_request(
                "GET",
                &format!("/api/v2/vaults/{vault_id}/unimplemented"),
                Some(&server_id),
                &[],
                &[],
            ),
            "req-6",
        );
        assert_eq!(route_gap.status(), 501);
        assert!(String::from_utf8_lossy(route_gap.body()).contains("not_implemented"));
    }

    #[test]
    fn v2_mutations_replay_and_asset_routes_use_typed_responses() {
        let fixture = app_fixture(&[("One", &[])]);
        let app = fixture.app();
        let server_id = app.server_instance_id().to_string();
        let vault_id = app.v2_bootstrap().vaults[0].vault_id.clone();
        let content = "# Created\n";
        let create = crate::api_types::V2CreateNoteRequest {
            mutation_id: "mutation-create".to_string(),
            path: "created.md".to_string(),
            content: content.to_string(),
            source_hash: crate::history::source_hash(content),
        };
        let body = serde_json::to_vec(&create).unwrap();
        let path = format!("/api/v2/vaults/{vault_id}/notes");
        let created = handle_v2_api(
            &app,
            &v2_request("POST", &path, Some(&server_id), &body, &[]),
            "req-create",
        );
        assert_eq!(created.status(), 201);
        let first_response = created.body().to_vec();
        let retry = handle_v2_api(
            &app,
            &v2_request("POST", &path, Some(&server_id), &body, &[]),
            "req-retry",
        );
        assert_eq!(retry.body(), first_response);

        let changed_content = "# Changed\n";
        let changed = crate::api_types::V2CreateNoteRequest {
            mutation_id: create.mutation_id.clone(),
            path: create.path.clone(),
            content: changed_content.to_string(),
            source_hash: crate::history::source_hash(changed_content),
        };
        let reuse = handle_v2_api(
            &app,
            &v2_request("POST", &path, Some(&server_id), &serde_json::to_vec(&changed).unwrap(), &[]),
            "req-reuse",
        );
        assert_eq!(reuse.status(), 409);
        assert!(String::from_utf8_lossy(reuse.body()).contains("mutation_id_reuse"));

        let settings_body = serde_json::to_vec(&crate::api_types::V2SettingsRequest {
            mutation_id: "mutation-settings".to_string(),
            settings: crate::api_types::Settings::default(),
        }).unwrap();
        let settings_path = format!("/api/v2/vaults/{vault_id}/settings");
        let settings = handle_v2_api(
            &app,
            &v2_request("PUT", &settings_path, Some(&server_id), &settings_body, &[]),
            "req-settings",
        );
        assert_eq!(settings.status(), 200);
        let settings_retry = handle_v2_api(
            &app,
            &v2_request("PUT", &settings_path, Some(&server_id), &settings_body, &[]),
            "req-settings-retry",
        );
        assert_eq!(settings_retry.body(), settings.body());

        let image_headers = [
            ("Content-Type".to_string(), "image/webp".to_string()),
            ("X-Tansu-Mutation-Id".to_string(), "mutation-image".to_string()),
        ];
        let image_path = format!("/api/v2/vaults/{vault_id}/images");
        let image_bytes = b"opaque webp bytes";
        let image = handle_v2_api(
            &app,
            &v2_request("POST", &image_path, Some(&server_id), image_bytes, &image_headers),
            "req-image",
        );
        assert_eq!(image.status(), 201);
        let image_retry = handle_v2_api(
            &app,
            &v2_request("POST", &image_path, Some(&server_id), image_bytes, &image_headers),
            "req-image-retry",
        );
        assert_eq!(image_retry.body(), image.body());
        let image_reuse = handle_v2_api(
            &app,
            &v2_request("POST", &image_path, Some(&server_id), b"different bytes", &image_headers),
            "req-image-reuse",
        );
        assert_eq!(image_reuse.status(), 409);
        assert!(String::from_utf8_lossy(image_reuse.body()).contains("mutation_id_reuse"));
        let uploaded: crate::api_types::V2ImageUploadResponse = serde_json::from_slice(image.body()).unwrap();
        let asset_path = format!("/api/v2/vaults/{vault_id}/assets?name={}", uploaded.name.replace('/', "%2F"));
        let asset = handle_v2_api(
            &app,
            &v2_request("GET", &asset_path, Some(&server_id), &[], &[]),
            "req-asset",
        );
        assert_eq!(asset.body(), image_bytes);
        assert_eq!(asset.content_type(), "image/webp");
    }

    fn v2_request(
        method: &str,
        path: &str,
        server_instance_id: Option<&str>,
        body: &[u8],
        extra_headers: &[(String, String)],
    ) -> HttpRequest {
        let mut headers = extra_headers.to_vec();
        if let Some(server_instance_id) = server_instance_id {
            headers.push(("X-Tansu-Server-Instance".to_string(), server_instance_id.to_string()));
        }
        HttpRequest {
            method: method.to_string(),
            path: path.to_string(),
            headers,
            body: body.to_vec(),
        }
    }

    #[test]
    fn handles_bootstrap_create_open_search_and_session_routes() {
        let fixture = app_fixture(&[("One", &[("one.md", "# One\n\nalpha\n")])]);
        let app = fixture.app();

        let bootstrap = handle_api(&app, &request("GET", "/api/bootstrap", 0, "")).unwrap();
        assert_eq!(bootstrap.status(), 200);
        let body: BootstrapResponse = serde_json::from_slice(bootstrap.body()).unwrap();
        assert_eq!(body.vaults[0].name, "One");
        assert_eq!(body.notes[0].path, "one.md");

        let created = handle_api(
            &app,
            &request(
                "POST",
                "/api/notes",
                0,
                r##"{"path":"created.md","content":"# Created\n","source":null}"##,
            ),
        )
        .unwrap();
        assert_eq!(created.status(), 201);
        let created_body: NoteMutationResponse = serde_json::from_slice(created.body()).unwrap();
        assert_eq!(created_body.meta.path, "created.md");

        let note_path = format!("/api/notes/{}", created_body.meta.note_id);
        let opened = handle_api(&app, &request("GET", &note_path, 0, "")).unwrap();
        assert_eq!(opened.status(), 200);

        let search = handle_api(&app, &request("GET", "/api/search?q=alpha", 0, "")).unwrap();
        assert_eq!(search.status(), 200);

        let session = handle_api(
            &app,
            &request(
                "PUT",
                "/api/session",
                0,
                r#"{"openTabs":[],"activeNoteId":null,"closedTabs":[]}"#,
            ),
        )
        .unwrap();
        assert_eq!(session.status(), 200);
    }

    #[test]
    fn search_defaults_to_twenty_hits() {
        let notes = (0..25)
            .map(|index| (format!("note-{index}.md"), "# Alpha\n\nalpha\n".to_string()))
            .collect::<Vec<_>>();
        let refs = notes
            .iter()
            .map(|(path, content)| (path.as_str(), content.as_str()))
            .collect::<Vec<_>>();
        let fixture = app_fixture(&[("One", refs.as_slice())]);
        let app = fixture.app();

        let search = handle_api(&app, &request("GET", "/api/search?q=alpha", 0, "")).unwrap();
        let body: Vec<SearchHit> = serde_json::from_slice(search.body()).unwrap();
        assert_eq!(body.len(), 20);
    }

    #[test]
    fn isolates_vaults_and_reports_bad_requests() {
        let fixture = app_fixture(&[
            ("One", &[("one.md", "# One\n")]),
            ("Two", &[("two.md", "# Two\n")]),
        ]);
        let app = fixture.app();

        let one = bootstrap(&app, 0);
        let two = bootstrap(&app, 1);
        assert_eq!(one.notes[0].path, "one.md");
        assert_eq!(two.notes[0].path, "two.md");

        let unknown = handle_api(&app, &request("GET", "/api/bootstrap", 9, "")).unwrap_err();
        assert!(unknown.to_string().contains("unknown vault index"));

        let missing_asset = handle_api(&app, &request("GET", "/api/assets", 0, "")).unwrap_err();
        assert!(missing_asset.to_string().contains("missing asset name"));

        let bad_json = handle_api(&app, &request("POST", "/api/notes", 0, "{")).unwrap_err();
        assert!(matches!(bad_json, Error::Json(_)));
    }

    #[test]
    fn handles_settings_save_conflict_revision_asset_pin_rename_and_delete_routes() {
        let fixture = app_fixture(&[("One", &[("one.md", "# One\n\nalpha\n")])]);
        let app = fixture.app();
        let note = bootstrap(&app, 0).notes[0].clone();

        let settings = handle_api(&app, &request("GET", "/api/settings", 0, "")).unwrap();
        assert_eq!(settings.status(), 200);
        let saved_settings = handle_api(
            &app,
            &request(
                "PUT",
                "/api/settings",
                0,
                r#"{"excludedFolders":["tmp"],"searchTitleWeight":3,"searchHeadingWeight":2,"searchTagWeight":2,"searchContentWeight":1,"recencyBoost":0,"autosaveDelayMs":500,"undoStackMax":50,"imageWebpQuality":0.8}"#,
            ),
        )
        .unwrap();
        assert_eq!(saved_settings.status(), 200);

        let note_path = format!("/api/notes/{}", note.note_id);
        let saved = handle_api(
            &app,
            &request(
                "PUT",
                &note_path,
                0,
                &serde_json::json!({
                    "content": "# One\n\nchanged\n",
                    "baseSeq": note.seq,
                    "baseHash": note.content_hash,
                    "checkpoint": true
                })
                .to_string(),
            ),
        )
        .unwrap();
        let saved_body: NoteMutationResponse = serde_json::from_slice(saved.body()).unwrap();
        let saved_doc = saved_body.document.as_ref().unwrap();
        assert!(saved_doc.content.contains("changed"));

        let patched = handle_api(
            &app,
            &request(
                "PATCH",
                &note_path,
                0,
                &serde_json::json!({
                    "baseSeq": saved_body.meta.seq,
                    "baseHash": saved_body.meta.content_hash,
                    "contentHash": crate::history::content_hash("# One\n\npatched\n"),
                    "edits": [{
                        "start": { "line": 2, "character": 0 },
                        "end": { "line": 2, "character": 7 },
                        "text": "patched"
                    }],
                    "checkpoint": false
                })
                .to_string(),
            ),
        )
        .unwrap();
        let patched_body: NoteMutationResponse = serde_json::from_slice(patched.body()).unwrap();
        assert!(patched_body.document.is_none());
        assert_eq!(patched_body.meta.seq, saved_body.meta.seq + 1);

        let conflict = handle_api(
            &app,
            &request(
                "PUT",
                &note_path,
                0,
                &serde_json::json!({
                    "content": "# One\n\nstale\n",
                    "baseSeq": note.seq,
                    "baseHash": note.content_hash,
                    "checkpoint": false
                })
                .to_string(),
            ),
        )
        .unwrap_err();
        let conflict_response = api_error_response(conflict);
        assert_eq!(conflict_response.status(), 409);
        let conflict_body: ApiErrorResponse =
            serde_json::from_slice(conflict_response.body()).unwrap();
        let draft_id = match conflict_body.error {
            ApiErrorKind::SaveConflict { draft, .. } => draft.draft_id,
            other => panic!("unexpected error: {other:?}"),
        };

        let draft_path = format!("/api/notes/{}/conflicts/{draft_id}", note.note_id);
        let draft = handle_api(&app, &request("GET", &draft_path, 0, "")).unwrap();
        assert_eq!(draft.status(), 200);
        let restored_draft = handle_api(
            &app,
            &request("POST", &format!("{draft_path}/restore"), 0, ""),
        )
        .unwrap();
        assert_eq!(restored_draft.status(), 200);

        let revisions_path = format!("/api/notes/{}/revisions", note.note_id);
        let revisions = handle_api(&app, &request("GET", &revisions_path, 0, "")).unwrap();
        let revision_list: Vec<crate::api_types::RevisionMeta> =
            serde_json::from_slice(revisions.body()).unwrap();
        let event_id = revision_list[0].event_id;
        assert_eq!(
            handle_api(
                &app,
                &request(
                    "GET",
                    &format!("/api/notes/{}/revisions/{event_id}", note.note_id),
                    0,
                    "",
                ),
            )
            .unwrap()
            .status(),
            200
        );
        assert_eq!(
            handle_api(
                &app,
                &request(
                    "POST",
                    &format!("/api/notes/{}/revisions/{event_id}/restore", note.note_id),
                    0,
                    "",
                ),
            )
            .unwrap()
            .status(),
            200
        );

        let image = handle_api(
            &app,
            &HttpRequest {
                method: "POST".to_string(),
                path: "/api/images".to_string(),
                headers: vec![("X-Tansu-Vault".to_string(), "0".to_string())],
                body: b"webp bytes".to_vec(),
            },
        )
        .unwrap();
        let uploaded: crate::api_types::ImageUploadResponse =
            serde_json::from_slice(image.body()).unwrap();
        let asset = handle_api(
            &app,
            &request(
                "GET",
                &format!("/api/assets?name={}", uploaded.name.replace('/', "%2F")),
                0,
                "",
            ),
        )
        .unwrap();
        assert_eq!(asset.status(), 200);

        assert_eq!(
            handle_api(&app, &request("POST", &format!("{note_path}/pin"), 0, ""))
                .unwrap()
                .status(),
            200
        );
        assert_eq!(
            handle_api(&app, &request("DELETE", &format!("{note_path}/pin"), 0, ""))
                .unwrap()
                .status(),
            200
        );

        let renamed = handle_api(
            &app,
            &request(
                "POST",
                &format!("{note_path}/rename"),
                0,
                r#"{"path":"renamed.md"}"#,
            ),
        )
        .unwrap();
        assert_eq!(renamed.status(), 200);
        assert_eq!(
            handle_api(&app, &request("DELETE", &note_path, 0, ""))
                .unwrap()
                .status(),
            200
        );
    }

    struct AppFixture {
        _root: TempDir,
        config: Config,
    }

    impl AppFixture {
        fn app(&self) -> App {
            App::new(self.config.clone()).unwrap()
        }
    }

    fn app_fixture(vaults: &[(&str, &[(&str, &str)])]) -> AppFixture {
        let root = tempfile::tempdir().unwrap();
        let mut config_vaults = Vec::new();
        for (index, (name, notes)) in vaults.iter().enumerate() {
            let path = root.path().join(format!("vault-{index}"));
            fs::create_dir_all(&path).unwrap();
            for (note_path, content) in *notes {
                fs::write(path.join(note_path), content).unwrap();
            }
            config_vaults.push(VaultConfig {
                name: (*name).to_string(),
                state_path: root.path().join(format!("state-{index}")),
                path,
                excluded_folders: Vec::new(),
            });
        }
        AppFixture {
            _root: root,
            config: Config {
                vaults: config_vaults,
                auth: None,
            },
        }
    }

    fn bootstrap(app: &App, vault: usize) -> BootstrapResponse {
        let response = handle_api(app, &request("GET", "/api/bootstrap", vault, "")).unwrap();
        serde_json::from_slice(response.body()).unwrap()
    }

    fn request(method: &str, path: &str, vault: usize, body: &str) -> HttpRequest {
        HttpRequest {
            method: method.to_string(),
            path: path.to_string(),
            headers: vec![("X-Tansu-Vault".to_string(), vault.to_string())],
            body: body.as_bytes().to_vec(),
        }
    }
}
