use crate::api_types::{
    V2ApiErrorKind, V2ApiErrorResponse,
    V2CreateNoteRequest, V2DeleteNoteRequest, V2RenameNoteRequest, V2RestoreConflictRequest,
    V2RestoreRevisionRequest, V2SaveNoteDeltaRequest, V2SaveNoteRequest, V2SearchRequest,
    V2QuickOpenRequest, V2SettingsRequest,
};
use crate::app::App;
use crate::http::{HttpRequest, HttpResponse};
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
    let vault = app.vault_by_id(&vault_id)
        .map_err(|error| map_v2_vault_lookup_error(error, &vault_id))?;
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

fn map_v2_vault_lookup_error(error: Error, vault_id: &str) -> V2VaultError {
    match error {
        Error::NotFound(_) => V2VaultError::Api(V2ApiErrorKind::VaultNotFound {
            vault_id: vault_id.to_string(),
        }),
        error => V2VaultError::Internal(error),
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
    use crate::config::{Config, VaultConfig};
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn query_params_decode_plus_and_reject_bad_hex() {
        assert_eq!(
            query_param("/api/v2/vaults/vault-1/assets?name=alpha+beta%2Fgamma", "name").unwrap(),
            Some("alpha beta/gamma".to_string())
        );
        assert!(
            query_param("/api/v2/vaults/vault-1/assets?name=%zz", "name")
                .unwrap_err()
                .to_string()
                .contains("invalid percent encoding")
        );
        assert_eq!(query_param("/api/v2/vaults/vault-1/assets?name=alpha", "missing").unwrap(), None);
    }

    #[test]
    fn vault_lookup_only_maps_not_found_to_vault_not_found() {
        assert!(matches!(
            map_v2_vault_lookup_error(Error::NotFound("lookup".to_string()), "vault-1"),
            V2VaultError::Api(V2ApiErrorKind::VaultNotFound { vault_id }) if vault_id == "vault-1"
        ));
        assert!(matches!(
            map_v2_vault_lookup_error(Error::Internal("database unavailable".to_string()), "vault-1"),
            V2VaultError::Internal(Error::Internal(message)) if message == "database unavailable"
        ));
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

        let vault = app.vault_by_id(&vault_id).unwrap();
        let note_id = vault.v2_notes().unwrap()[0].note_id.clone();
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
    fn v2_error_responses_keep_status_and_request_context() {
        let cases = [
            (V2ApiErrorKind::AssetNotFound { name: "x.webp".to_string() }, 404),
            (V2ApiErrorKind::BadRequest { message: "bad input".to_string() }, 400),
            (V2ApiErrorKind::MutationIdReuse { mutation_id: "m1".to_string() }, 409),
            (V2ApiErrorKind::RequestTooLarge { limit_bytes: 16 }, 413),
            (V2ApiErrorKind::AuthRequired, 401),
            (V2ApiErrorKind::Forbidden, 403),
            (V2ApiErrorKind::RateLimited { retry_after_ms: 10 }, 429),
            (V2ApiErrorKind::NotImplemented, 501),
            (V2ApiErrorKind::Internal { request_id: "request-1".to_string() }, 500),
        ];

        for (error, status) in cases {
            assert_eq!(v2_api_error_response(error, "fallback").status(), status);
        }

        assert_eq!(
            v2_vault_error_response(
                V2VaultError::Internal(Error::BadRequest("invalid state".to_string())),
                "request-2",
            )
            .status(),
            400
        );
        let internal = v2_vault_error_response(
            V2VaultError::Internal(Error::Internal("private detail".to_string())),
            "request-3",
        );
        assert_eq!(internal.status(), 500);
        assert!(String::from_utf8_lossy(internal.body()).contains("request-3"));
        assert!(!String::from_utf8_lossy(internal.body()).contains("private detail"));
    }

    #[test]
    fn v2_rejects_invalid_routes_bodies_and_image_headers() {
        let fixture = app_fixture(&[("One", &[])]);
        let app = fixture.app();
        let server_id = app.server_instance_id().to_string();
        let vault_id = app.v2_bootstrap().vaults[0].vault_id.clone();
        let vault_path = format!("/api/v2/vaults/{vault_id}");

        let no_server = validate_v2_server_instance(&app, &[]).unwrap_err();
        assert!(matches!(no_server, V2ApiErrorKind::ServerInstanceMismatch { received, .. } if received.is_empty()));
        let duplicate = validate_v2_server_instance(
            &app,
            &[
                ("X-Tansu-Server-Instance".to_string(), server_id.clone()),
                ("x-tansu-server-instance".to_string(), server_id.clone()),
            ],
        )
        .unwrap_err();
        assert!(matches!(duplicate, V2ApiErrorKind::ServerInstanceMismatch { received, .. } if received == "<multiple>"));
        let long_unicode = "三".repeat(100);
        let truncated = validate_v2_server_instance(
            &app,
            &[("X-Tansu-Server-Instance".to_string(), long_unicode)],
        )
        .unwrap_err();
        assert!(matches!(truncated, V2ApiErrorKind::ServerInstanceMismatch { received, .. } if received.len() == 255));

        for path in ["/api/v2/outside", &vault_path] {
            let response = handle_v2_api(
                &app,
                &v2_request("GET", path, Some(&server_id), &[], &[]),
                "request-route",
            );
            assert_eq!(response.status(), 501);
        }
        let invalid_segment = handle_v2_api(
            &app,
            &v2_request(
                "GET",
                &format!("{vault_path}/notes/%GG"),
                Some(&server_id),
                &[],
                &[],
            ),
            "request-segment",
        );
        assert_eq!(invalid_segment.status(), 400);
        let invalid_json = handle_v2_api(
            &app,
            &v2_request(
                "POST",
                &format!("{vault_path}/notes"),
                Some(&server_id),
                b"{",
                &[],
            ),
            "request-json",
        );
        assert_eq!(invalid_json.status(), 400);
        let invalid_revision = handle_v2_api(
            &app,
            &v2_request(
                "GET",
                &format!("{vault_path}/notes/missing/revisions/nope"),
                Some(&server_id),
                &[],
                &[],
            ),
            "request-revision",
        );
        assert_eq!(invalid_revision.status(), 400);
        let wrong_image_type = handle_v2_api(
            &app,
            &v2_request(
                "POST",
                &format!("{vault_path}/images"),
                Some(&server_id),
                b"webp",
                &[],
            ),
            "request-image-type",
        );
        assert_eq!(wrong_image_type.status(), 400);
        let missing_mutation_id = handle_v2_api(
            &app,
            &v2_request(
                "POST",
                &format!("{vault_path}/images"),
                Some(&server_id),
                b"webp",
                &[("Content-Type".to_string(), "image/webp".to_string())],
            ),
            "request-image-id",
        );
        assert_eq!(missing_mutation_id.status(), 400);
        let missing_asset_name = handle_v2_api(
            &app,
            &v2_request("GET", &format!("{vault_path}/assets"), Some(&server_id), &[], &[]),
            "request-asset-name",
        );
        assert_eq!(missing_asset_name.status(), 400);
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

    #[test]
    fn v2_read_routes_return_vault_note_revision_and_search_data() {
        use crate::api_types::{
            V2BootstrapResponse, V2NoteDocument, V2QuickOpenResponse, V2RevisionDocument,
            V2RevisionMeta, V2SearchResponse, V2VaultBootstrapResponse,
        };

        let fixture = app_fixture(&[("One", &[("one.md", "# One\n\nalpha\n")])]);
        let app = fixture.app();
        let server_id = app.server_instance_id().to_string();
        let vault_id = app.v2_bootstrap().vaults[0].vault_id.clone();
        let bootstrap: V2BootstrapResponse = serde_json::from_slice(
            handle_v2_api(&app, &v2_request("GET", "/api/v2/bootstrap", None, &[], &[]), "req")
                .body(),
        )
        .unwrap();
        assert_eq!(bootstrap.api_version, 2);
        assert_eq!(bootstrap.vaults[0].vault_id, vault_id);

        let vault_path = format!("/api/v2/vaults/{vault_id}");
        let vault: V2VaultBootstrapResponse = serde_json::from_slice(
            handle_v2_api(
                &app,
                &v2_request("GET", &format!("{vault_path}/bootstrap"), Some(&server_id), &[], &[]),
                "req",
            )
            .body(),
        )
        .unwrap();
        assert_eq!(vault.notes.len(), 1);
        let note_id = vault.notes[0].note_id.clone();

        let note: V2NoteDocument = serde_json::from_slice(
            handle_v2_api(
                &app,
                &v2_request("GET", &format!("{vault_path}/notes/{note_id}"), Some(&server_id), &[], &[]),
                "req",
            )
            .body(),
        )
        .unwrap();
        assert_eq!(note.content, "# One\n\nalpha\n");

        let revisions: Vec<V2RevisionMeta> = serde_json::from_slice(
            handle_v2_api(
                &app,
                &v2_request(
                    "GET",
                    &format!("{vault_path}/notes/{note_id}/revisions"),
                    Some(&server_id),
                    &[],
                    &[],
                ),
                "req",
            )
            .body(),
        )
        .unwrap();
        let revision: V2RevisionDocument = serde_json::from_slice(
            handle_v2_api(
                &app,
                &v2_request(
                    "GET",
                    &format!("{vault_path}/notes/{note_id}/revisions/{}", revisions[0].revision),
                    Some(&server_id),
                    &[],
                    &[],
                ),
                "req",
            )
            .body(),
        )
        .unwrap();
        assert_eq!(revision.content, note.content);

        let settings = handle_v2_api(
            &app,
            &v2_request("GET", &format!("{vault_path}/settings"), Some(&server_id), &[], &[]),
            "req",
        );
        assert_eq!(settings.status(), 200);
        let saved_settings = handle_v2_api(
            &app,
            &v2_request(
                "PUT",
                &format!("{vault_path}/settings"),
                Some(&server_id),
                &serde_json::json!({
                    "mutationId": "settings-route",
                    "settings": crate::api_types::Settings::default()
                })
                .to_string()
                .into_bytes(),
                &[],
            ),
            "req",
        );
        assert_eq!(saved_settings.status(), 200);
        let search: V2SearchResponse = serde_json::from_slice(
            handle_v2_api(
                &app,
                &v2_request(
                    "POST",
                    &format!("{vault_path}/search"),
                    Some(&server_id),
                    br#"{"query":"alpha","mode":"default","limit":10,"overlays":[]}"#,
                    &[],
                ),
                "req",
            )
            .body(),
        )
        .unwrap();
        assert_eq!(search.hits.len(), 1);

        let quick_open: V2QuickOpenResponse = serde_json::from_slice(
            handle_v2_api(
                &app,
                &v2_request(
                    "POST",
                    &format!("{vault_path}/quick-open"),
                    Some(&server_id),
                    &serde_json::json!({
                        "query": "",
                        "pinnedNoteIds": [note_id],
                        "recentNoteIds": [],
                        "limit": 10
                    })
                    .to_string()
                    .into_bytes(),
                    &[],
                ),
                "req",
            )
            .body(),
        )
        .unwrap();
        assert_eq!(quick_open.hits.len(), 1);
        assert_eq!(quick_open.hits[0].note_id, note_id);
    }

    #[test]
    fn v2_mutation_routes_save_restore_rename_and_delete_notes() {
        use crate::api_types::{
            V2ConflictDraftDocument, V2MutationOutcome, V2MutationResponse, V2NoteDocument,
            V2RevisionMeta,
        };

        let fixture = app_fixture(&[("One", &[("one.md", "# One\n\nalpha\n")])]);
        let app = fixture.app();
        let server_id = app.server_instance_id().to_string();
        let vault_id = app.v2_bootstrap().vaults[0].vault_id.clone();
        let vault_path = format!("/api/v2/vaults/{vault_id}");
        let vault = app.vault_by_id(&vault_id).unwrap();
        let note_id = vault.v2_notes().unwrap()[0].note_id.clone();
        let note_path = format!("{vault_path}/notes/{note_id}");
        let original = vault.v2_open_note(&note_id).unwrap();

        let saved_content = "# One\n\nchanged\n";
        let saved: V2MutationResponse = serde_json::from_slice(
            handle_v2_api(
                &app,
                &v2_request(
                    "PUT",
                    &note_path,
                    Some(&server_id),
                    &serde_json::json!({
                        "mutationId": "save-route",
                        "precondition": v2_precondition(&original.meta),
                        "content": saved_content,
                        "sourceHash": crate::history::source_hash(saved_content)
                    })
                    .to_string()
                    .into_bytes(),
                    &[],
                ),
                "req",
            )
            .body(),
        )
        .unwrap();
        let V2MutationOutcome::Accepted { result: Some(saved_meta) } = saved.outcome else {
            panic!("save route did not accept the current note revision");
        };

        let delta_content = "# One\n\ndelta\n";
        let delta: V2MutationResponse = serde_json::from_slice(
            handle_v2_api(
                &app,
                &v2_request(
                    "PATCH",
                    &note_path,
                    Some(&server_id),
                    &serde_json::json!({
                        "mutationId": "delta-route",
                        "precondition": v2_precondition(&saved_meta),
                        "sourceHash": crate::history::source_hash(delta_content),
                        "edits": [{
                            "start": {"line": 2, "character": 0},
                            "end": {"line": 2, "character": 7},
                            "text": "delta"
                        }]
                    })
                    .to_string()
                    .into_bytes(),
                    &[],
                ),
                "req",
            )
            .body(),
        )
        .unwrap();
        let V2MutationOutcome::Accepted { result: Some(_) } = delta.outcome else {
            panic!("delta route did not accept the valid edit");
        };

        let stale_content = "# One\n\nstale\n";
        let conflict: V2MutationResponse = serde_json::from_slice(
            handle_v2_api(
                &app,
                &v2_request(
                    "PUT",
                    &note_path,
                    Some(&server_id),
                    &serde_json::json!({
                        "mutationId": "conflict-route",
                        "precondition": v2_precondition(&original.meta),
                        "content": stale_content,
                        "sourceHash": crate::history::source_hash(stale_content)
                    })
                    .to_string()
                    .into_bytes(),
                    &[],
                ),
                "req",
            )
            .body(),
        )
        .unwrap();
        let V2MutationOutcome::Conflict { current, draft } = conflict.outcome else {
            panic!("stale save did not return a recoverable conflict");
        };
        let draft_document: V2ConflictDraftDocument = serde_json::from_slice(
            handle_v2_api(
                &app,
                &v2_request(
                    "GET",
                    &format!("{note_path}/conflicts/{}", draft.draft_id),
                    Some(&server_id),
                    &[],
                    &[],
                ),
                "req",
            )
            .body(),
        )
        .unwrap();
        assert_eq!(draft_document.content, stale_content);
        let conflict_restored: V2MutationResponse = serde_json::from_slice(
            handle_v2_api(
                &app,
                &v2_request(
                    "POST",
                    &format!("{note_path}/conflicts/{}/restore", draft.draft_id),
                    Some(&server_id),
                    &serde_json::json!({
                        "mutationId": "restore-conflict-route",
                        "precondition": v2_precondition(&current.meta)
                    })
                    .to_string()
                    .into_bytes(),
                    &[],
                ),
                "req",
            )
            .body(),
        )
        .unwrap();
        assert!(matches!(
            conflict_restored.outcome,
            V2MutationOutcome::Accepted { .. }
        ));

        let revisions: Vec<V2RevisionMeta> = serde_json::from_slice(
            handle_v2_api(
                &app,
                &v2_request(
                    "GET",
                    &format!("{vault_path}/notes/{note_id}/revisions"),
                    Some(&server_id),
                    &[],
                    &[],
                ),
                "req",
            )
            .body(),
        )
        .unwrap();
        let original_revision = revisions
            .iter()
            .find(|revision| revision.source_hash.as_deref() == Some(&original.meta.source_hash))
            .unwrap();
        let current_after_conflict: V2NoteDocument = serde_json::from_slice(
            handle_v2_api(
                &app,
                &v2_request("GET", &note_path, Some(&server_id), &[], &[]),
                "req",
            )
            .body(),
        )
        .unwrap();
        let restored: V2MutationResponse = serde_json::from_slice(
            handle_v2_api(
                &app,
                &v2_request(
                    "POST",
                    &format!("{vault_path}/notes/{note_id}/revisions/{}/restore", original_revision.revision),
                    Some(&server_id),
                    &serde_json::json!({
                        "mutationId": "restore-route",
                        "precondition": v2_precondition(&current_after_conflict.meta)
                    })
                    .to_string()
                    .into_bytes(),
                    &[],
                ),
                "req",
            )
            .body(),
        )
        .unwrap();
        assert!(matches!(restored.outcome, V2MutationOutcome::Accepted { .. }));

        let current: V2NoteDocument = serde_json::from_slice(
            handle_v2_api(
                &app,
                &v2_request("GET", &note_path, Some(&server_id), &[], &[]),
                "req",
            )
            .body(),
        )
        .unwrap();
        let renamed: V2MutationResponse = serde_json::from_slice(
            handle_v2_api(
                &app,
                &v2_request(
                    "POST",
                    &format!("{note_path}/rename"),
                    Some(&server_id),
                    &serde_json::json!({
                        "mutationId": "rename-route",
                        "precondition": v2_precondition(&current.meta),
                        "path": "nested/renamed.md"
                    })
                    .to_string()
                    .into_bytes(),
                    &[],
                ),
                "req",
            )
            .body(),
        )
        .unwrap();
        let V2MutationOutcome::Accepted { result: Some(renamed_meta) } = renamed.outcome else {
            panic!("rename route did not accept the valid path");
        };
        assert_eq!(renamed_meta.path, "nested/renamed.md");

        let deleted = handle_v2_api(
            &app,
            &v2_request(
                "DELETE",
                &note_path,
                Some(&server_id),
                &serde_json::json!({
                    "mutationId": "delete-route",
                    "precondition": v2_precondition(&renamed_meta)
                })
                .to_string()
                .into_bytes(),
                &[],
            ),
            "req",
        );
        assert_eq!(deleted.status(), 200);
        assert!(!vault.root().join("nested/renamed.md").exists());
    }

    fn v2_precondition(meta: &crate::api_types::V2NoteMeta) -> serde_json::Value {
        serde_json::json!({
            "baseRevision": meta.revision,
            "baseSourceHash": meta.source_hash,
            "baseDiskHash": meta.disk_hash
        })
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

}
