use crate::api_types::{
    ApiErrorKind, ApiErrorResponse, CreateNoteRequest, RenameNoteRequest, SaveNoteDeltaRequest,
    SaveNoteRequest, SessionState, Settings,
};
use crate::app::App;
use crate::http::{HttpRequest, HttpResponse};
use crate::search::DEFAULT_SEARCH_LIMIT;
use crate::{Error, Result};

pub const API_VERSION: u32 = 1;

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
    for pair in query.split('&') {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        if name == key {
            return percent_decode(value).map(Some);
        }
    }
    Ok(None)
}

fn parse_i64(value: &str) -> Result<i64> {
    value
        .parse()
        .map_err(|_| Error::BadRequest(format!("invalid numeric id {value}")))
}

fn percent_decode(value: &str) -> Result<String> {
    let mut out = String::new();
    let mut chars = value.as_bytes().iter().copied();
    while let Some(byte) = chars.next() {
        if byte == b'%' {
            let hi = chars.next();
            let lo = chars.next();
            if let (Some(hi), Some(lo)) = (hi, lo)
                && let Ok(hex) = std::str::from_utf8(&[hi, lo])
                && let Ok(decoded) = u8::from_str_radix(hex, 16)
            {
                out.push(decoded as char);
                continue;
            }
            return Err(Error::BadRequest("invalid percent encoding".to_string()));
        }
        out.push(if byte == b'+' { ' ' } else { byte as char });
    }
    Ok(out)
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
