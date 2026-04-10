use std::{
    collections::HashSet,
    env, fs,
    io::{self, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, mpsc},
    time::Instant,
};

use serde::{Deserialize, Serialize};

use tansu::crypto::{self, CryptoConfig, Vault};
use tansu::filenames::FileNameIndex;
use tansu::http::*;
use tansu::index::Index;
use tansu::revisions;
use tansu::settings::Settings;
use tansu::watcher::{self, WatchEvent};

#[cfg(feature = "embed")]
static EMBED_APP_JS: &[u8] = include_bytes!("../web/static/app.js");
#[cfg(feature = "embed")]
static EMBED_STYLE_CSS: &[u8] = include_bytes!("../web/static/style.css");
#[cfg(feature = "embed")]
static EMBED_INDEX_HTML: &[u8] = include_bytes!("../web/index.html");

const SESSION_TIMEOUT_SECS: u64 = 24 * 60 * 60; // 24 hours

#[derive(Serialize)]
struct NoteResponse<'a> {
    content: &'a str,
    mtime: u64,
}

#[derive(Serialize)]
struct MtimeResponse {
    mtime: u64,
}

#[derive(Serialize)]
struct ConflictResponse<'a> {
    conflict: bool,
    content: &'a str,
    mtime: u64,
}

#[derive(Serialize)]
struct SearchHit<'a> {
    path: &'a str,
    title: &'a str,
    excerpt: &'a str,
    score: f32,
    field_scores: FieldScoresJson,
}

#[derive(Serialize)]
struct FieldScoresJson {
    title: f32,
    headings: f32,
    tags: f32,
    content: f32,
}

#[derive(Serialize)]
struct NoteListEntry<'a> {
    path: &'a str,
    title: &'a str,
}

#[derive(Serialize)]
struct RenameResponse {
    updated: Vec<String>,
}

#[derive(Serialize)]
struct FilenameResponse<'a> {
    filename: &'a str,
}

#[derive(Serialize)]
struct ContentResponse<'a> {
    content: &'a str,
}

#[derive(Serialize)]
struct OkResponse {
    ok: bool,
}

#[derive(Deserialize)]
struct PutNoteRequest {
    content: String,
    #[serde(default)]
    expected_mtime: u64,
}

#[derive(Deserialize)]
struct CreateNoteRequest {
    #[serde(default)]
    content: String,
}

#[derive(Deserialize)]
struct RenameRequest {
    old_path: String,
    new_path: String,
}

#[derive(Deserialize)]
struct PinRequest {
    path: String,
}

struct SessionState {
    token: [u8; 32],
    last_activity: Instant,
}

struct Server {
    dir: PathBuf,
    quiet: bool,
    index: Index,
    file_index: FileNameIndex,
    settings: Settings,
    watch_rx: mpsc::Receiver<WatchEvent>,
    self_writes: Arc<Mutex<HashSet<PathBuf>>>,
    sse_client: Arc<Mutex<Option<TcpStream>>>,
    /// None = plaintext mode or locked. Check `encrypted` to distinguish.
    vault: Option<Vault>,
    session: Option<SessionState>,
    /// True if crypto.json exists (encrypted mode). False = plaintext, no auth needed.
    encrypted: bool,
    crypto_config: Option<CryptoConfig>,
}

impl Server {
    fn is_locked(&self) -> bool {
        self.encrypted && self.vault.is_none()
    }

    fn check_session(&mut self, headers: &[httparse::Header<'_>]) -> bool {
        if !self.encrypted {
            return true; // plaintext mode, no auth needed
        }
        let session = match &mut self.session {
            Some(s) => s,
            None => return false,
        };
        // Check idle timeout
        if session.last_activity.elapsed().as_secs() > SESSION_TIMEOUT_SECS {
            self.lock_server();
            return false;
        }
        // Validate cookie with constant-time comparison
        let cookie = find_header(headers, "cookie").unwrap_or("");
        let token_hex = hex_encode(&session.token);
        let expected = format!("tansu_session={token_hex}");
        let valid = cookie.split(';').any(|part| {
            let part = part.trim();
            if part.len() != expected.len() {
                return false;
            }
            use subtle::ConstantTimeEq;
            part.as_bytes().ct_eq(expected.as_bytes()).into()
        });
        if valid {
            self.session.as_mut().unwrap().last_activity = Instant::now();
        }
        valid
    }

    fn create_session(&mut self) -> String {
        let mut token = [0u8; 32];
        use rand::RngCore;
        rand::rngs::OsRng.fill_bytes(&mut token);
        let hex = hex_encode(&token);
        self.session = Some(SessionState {
            token,
            last_activity: Instant::now(),
        });
        hex
    }

    fn lock_server(&mut self) {
        self.vault = None;
        self.session = None;
        // Send locked event to SSE client
        self.broadcast_sse("locked", "");
        // Close SSE connection
        let mut guard = self.sse_client.lock().unwrap();
        *guard = None;
    }

    fn drain_watch_events(&mut self) {
        let mut had_events = false;
        while let Ok(event) = self.watch_rx.try_recv() {
            had_events = true;
            match event {
                WatchEvent::Modified(path) | WatchEvent::Created(path) => {
                    if let Ok(content) = self.read_content(&path) {
                        let rel = path.strip_prefix(&self.dir).unwrap_or(&path);
                        let rel_str = rel.to_string_lossy();
                        self.index.index_note(&rel_str, &content, &path);
                        self.file_index.index_file(&rel_str, mtime_secs(&path));
                        self.broadcast_sse("changed", &rel_str);
                    }
                }
                WatchEvent::Removed(path) => {
                    let rel = path.strip_prefix(&self.dir).unwrap_or(&path);
                    let rel_str = rel.to_string_lossy();
                    self.index.remove_note(&rel_str);
                    self.file_index.remove_file(&rel_str);
                    self.broadcast_sse("deleted", &rel_str);
                }
            }
        }
        if had_events {
            self.index.commit();
        }
    }

    fn broadcast_sse(&self, event_type: &str, path: &str) {
        let mut guard = self.sse_client.lock().unwrap();
        if let Some(ref mut stream) = *guard {
            let msg = format!("event: {event_type}\ndata: {path}\n\n");
            if stream.write_all(msg.as_bytes()).is_err() {
                *guard = None;
            }
        }
    }

    fn mark_self_write(&self, path: &Path) {
        self.self_writes.lock().unwrap().insert(path.to_path_buf());
    }

    /// Read a user-content file as String (decrypts if vault is active).
    fn read_content(&self, path: &Path) -> io::Result<String> {
        if let Some(ref vault) = self.vault {
            vault.read_to_string(path)
        } else {
            fs::read_to_string(path)
        }
    }

    /// Read a user-content file as raw bytes (decrypts if vault is active).
    fn read_content_bytes(&self, path: &Path) -> io::Result<Vec<u8>> {
        if let Some(ref vault) = self.vault {
            vault.read(path)
        } else {
            fs::read(path)
        }
    }

    /// Atomic write of user content (encrypts if vault is active).
    fn write_content(&self, path: &Path, content: &[u8]) -> io::Result<()> {
        self.mark_self_write(path);
        if let Some(ref vault) = self.vault {
            vault.write(path, content)
        } else {
            crypto::atomic_write(path, content)
        }
    }

    /// Plain write for non-content files (images upload, etc.)
    fn write_content_raw(&self, path: &Path, content: &[u8]) -> io::Result<()> {
        if let Some(ref vault) = self.vault {
            let encrypted = vault.encrypt(content);
            fs::write(path, encrypted)
        } else {
            fs::write(path, content)
        }
    }

    /// Reindex all markdown files using the vault for decryption.
    fn reindex_with_vault(&self) {
        let vault = match &self.vault {
            Some(v) => v,
            None => return,
        };
        let files = crypto::collect_content_files(&self.dir);
        for path in &files {
            if path.extension().is_some_and(|e| e == "md") {
                if let Ok(content) = vault.read_to_string(path) {
                    let rel = path.strip_prefix(&self.dir).unwrap_or(path);
                    self.index
                        .index_note(&rel.to_string_lossy(), &content, path);
                }
            }
        }
        self.index.commit();
        self.file_index
            .full_reindex(&self.dir, &self.settings.excluded_folders);
    }

    fn handle(&mut self, mut stream: TcpStream) -> io::Result<()> {
        let mut buf = [0u8; 8192];
        let mut pos = 0usize;

        loop {
            self.drain_watch_events();

            // Read until we have complete headers
            loop {
                if pos == buf.len() {
                    return write_error(&stream, 431, "Request Header Fields Too Large");
                }
                let n = match stream.read(&mut buf[pos..]) {
                    Ok(0) => return Ok(()),
                    Ok(n) => n,
                    Err(e)
                        if e.kind() == io::ErrorKind::WouldBlock
                            || e.kind() == io::ErrorKind::TimedOut =>
                    {
                        return Ok(());
                    }
                    Err(e) => return Err(e),
                };
                pos += n;

                let mut hdrs = [httparse::EMPTY_HEADER; 32];
                let mut req = httparse::Request::new(&mut hdrs);
                match req.parse(&buf[..pos]) {
                    Ok(httparse::Status::Complete(header_len)) => {
                        let method = req.method.unwrap_or("").to_string();
                        let path_raw = req.path.unwrap_or("/").to_string();

                        let start = Instant::now();
                        let result = self.dispatch(
                            &mut stream,
                            &method,
                            &path_raw,
                            &req.headers,
                            &buf[..pos],
                            header_len,
                        );
                        if !self.quiet {
                            let elapsed = start.elapsed();
                            eprintln!(
                                "\t{method} {path_raw} ({:.1}ms)",
                                elapsed.as_secs_f64() * 1000.0
                            );
                        }
                        result?;

                        // SSE is a long-lived connection — don't loop
                        let route = path_raw.split('?').next().unwrap_or("/");
                        if route == "/events" {
                            return Ok(());
                        }

                        // Carry over any pipelined bytes past this request
                        let body_len = content_length(&req.headers);
                        let consumed = header_len + body_len;
                        if consumed < pos {
                            buf.copy_within(consumed..pos, 0);
                            pos -= consumed;
                        } else {
                            // No pipelined data — return to accept loop so other
                            // connections aren't starved (single-threaded server)
                            return Ok(());
                        }
                        break; // handle the pipelined request
                    }
                    Ok(httparse::Status::Partial) => continue,
                    Err(_) => return write_error(&stream, 400, "Bad Request"),
                }
            }
        }
    }

    fn dispatch(
        &mut self,
        stream: &mut TcpStream,
        method: &str,
        path_raw: &str,
        headers: &[httparse::Header<'_>],
        raw_buf: &[u8],
        header_len: usize,
    ) -> io::Result<()> {
        let path = path_raw.split('?').next().unwrap_or("/");
        let mut fp = PathBuf::new();

        // Always allow: status, unlock, static assets, index page
        match path {
            "/api/status" => return self.api_status(stream),
            "/api/unlock" if method == "POST" => {
                return self.api_unlock(stream, headers, raw_buf, header_len);
            }
            _ => {}
        }

        // Static assets are always served (needed for unlock page)
        if path.starts_with("/static/") && method == "GET" {
            let decoded = percent_decode(path);
            #[cfg(feature = "embed")]
            return match decoded.strip_prefix("/static/").unwrap_or("") {
                "app.js" => write_body_cached(stream, "application/javascript", EMBED_APP_JS),
                "style.css" => write_body_cached(stream, "text/css", EMBED_STYLE_CSS),
                _ => write_error(stream, 404, "Not Found"),
            };
            #[cfg(not(feature = "embed"))]
            {
                let static_dir = self.static_dir();
                if !normalize_into(&static_dir, &decoded.replacen("/static/", "/", 1), &mut fp) {
                    return write_error(stream, 403, "Forbidden");
                }
                return match fs::metadata(&fp) {
                    Ok(m) if m.is_file() => serve_file_cached(stream, &fp, m.len(), mime(&fp)),
                    _ => write_error(stream, 404, "Not Found"),
                };
            }
        }

        // Index page always served (it handles locked state client-side)
        if path == "/" && method == "GET" {
            return self.serve_index(stream);
        }

        // If locked, reject everything else
        if self.is_locked() {
            if path.starts_with("/api/") {
                return write_error(stream, 403, "Locked");
            }
            return write_redirect(stream, "/");
        }

        // If encrypted, check session
        if self.encrypted && !self.check_session(headers) {
            if path.starts_with("/api/") {
                return write_error(stream, 403, "Unauthorized");
            }
            return write_redirect(stream, "/");
        }

        if path.starts_with("/api/") {
            return self.dispatch_api(stream, method, path, path_raw, headers, raw_buf, header_len);
        }

        if path == "/events" {
            return self.handle_sse(stream);
        }

        if method != "GET" {
            return write_error(stream, 405, "Method Not Allowed");
        }

        if path.starts_with("/z-images/") {
            let decoded = percent_decode(path);
            if !normalize_into(&self.dir, &decoded, &mut fp) {
                return write_error(stream, 403, "Forbidden");
            }
            if !fp.is_file() {
                return write_error(stream, 404, "Not Found");
            }
            if self.vault.is_some() {
                // Encrypted mode: decrypt and serve bytes
                let data = self.read_content_bytes(&fp)?;
                return write_body_cached(stream, mime(&fp), &data);
            } else {
                let meta = fs::metadata(&fp)?;
                return serve_file_cached(stream, &fp, meta.len(), mime(&fp));
            }
        }

        self.serve_index(stream)
    }

    fn dispatch_api(
        &mut self,
        stream: &mut TcpStream,
        method: &str,
        path: &str,
        path_raw: &str,
        headers: &[httparse::Header<'_>],
        raw_buf: &[u8],
        header_len: usize,
    ) -> io::Result<()> {
        match (method, path) {
            ("GET", "/api/search") => self.api_search(stream, path_raw),
            ("GET", "/api/note") => self.api_get_note(stream, path_raw),
            ("PUT", "/api/note") => {
                self.api_put_note(stream, path_raw, headers, raw_buf, header_len)
            }
            ("POST", "/api/note") => {
                self.api_create_note(stream, path_raw, headers, raw_buf, header_len)
            }
            ("DELETE", "/api/note") => self.api_delete_note(stream, path_raw),
            ("POST", "/api/rename") => self.api_rename(stream, headers, raw_buf, header_len),
            ("GET", "/api/notes") => self.api_list_notes(stream),
            ("GET", "/api/backlinks") => self.api_backlinks(stream, path_raw),
            ("POST", "/api/image") => self.api_upload_image(stream, headers, raw_buf, header_len),
            ("GET", "/api/revisions") => self.api_list_revisions(stream, path_raw),
            ("GET", "/api/revision") => self.api_get_revision(stream, path_raw),
            ("POST", "/api/restore") => self.api_restore_revision(stream, path_raw),
            ("GET", "/api/state") => self.api_get_state(stream),
            ("PUT", "/api/state") => self.api_put_state(stream, headers, raw_buf, header_len),
            ("GET", "/api/settings") => self.api_get_settings(stream),
            ("PUT", "/api/settings") => self.api_put_settings(stream, headers, raw_buf, header_len),
            ("GET", "/api/filesearch") => self.api_filesearch(stream, path_raw),
            ("GET", "/api/recentfiles") => self.api_recent_files(stream),
            ("GET", "/api/pinned") => self.api_get_pinned(stream),
            ("POST", "/api/pin") => self.api_pin(stream, headers, raw_buf, header_len),
            ("DELETE", "/api/pin") => self.api_unpin(stream, headers, raw_buf, header_len),
            ("GET", "/api/lock") => self.api_lock(stream),
            ("POST", "/api/prf/register") => {
                self.api_prf_register(stream, headers, raw_buf, header_len)
            }
            ("POST", "/api/prf/remove") => {
                self.api_prf_remove(stream, headers, raw_buf, header_len)
            }
            _ => write_error(stream, 404, "Not Found"),
        }
    }

    fn static_dir(&self) -> PathBuf {
        let exe = env::current_exe().unwrap_or_default();
        let exe_dir = exe.parent().unwrap_or(Path::new("."));
        for candidate in [exe_dir.join("web/static"), PathBuf::from("web/static")] {
            if candidate.is_dir() {
                return candidate;
            }
        }
        PathBuf::from("web/static")
    }

    fn serve_index(&mut self, sock: &TcpStream) -> io::Result<()> {
        #[cfg(feature = "embed")]
        return write_body(sock, "text/html; charset=utf-8", EMBED_INDEX_HTML);
        #[cfg(not(feature = "embed"))]
        {
            let exe = env::current_exe().unwrap_or_default();
            let exe_dir = exe.parent().unwrap_or(Path::new("."));
            for candidate in [
                exe_dir.join("web/index.html"),
                PathBuf::from("web/index.html"),
            ] {
                if candidate.is_file() {
                    let meta = fs::metadata(&candidate)?;
                    return serve_file(sock, &candidate, meta.len(), "text/html; charset=utf-8");
                }
            }
            write_error(sock, 404, "index.html not found")
        }
    }

    fn handle_sse(&self, stream: &mut TcpStream) -> io::Result<()> {
        let mut guard = self.sse_client.lock().unwrap();
        // If an existing client is held, probe it with a comment line.
        // If the write fails, the old connection is dead — replace it.
        if let Some(ref mut old) = *guard {
            if old.write_all(b": ping\n\n").is_ok() {
                drop(guard);
                return write_error(stream, 409, "Conflict: another client is connected");
            }
        }
        let header = "HTTP/1.1 200 OK\r\n\
                      Content-Type: text/event-stream\r\n\
                      Cache-Control: no-store\r\n\
                      Connection: keep-alive\r\n\
                      \r\n";
        stream.write_all(header.as_bytes())?;
        stream.write_all(b"event: connected\ndata: ok\n\n")?;
        *guard = Some(stream.try_clone()?);
        Ok(())
    }

    fn api_status(&self, sock: &TcpStream) -> io::Result<()> {
        let locked = self.is_locked();
        let needs_setup = self.encrypted && self.crypto_config.is_none();
        // Credential IDs are needed for WebAuthn allowCredentials (must be public)
        let prf_ids: Vec<&str> = self
            .crypto_config
            .as_ref()
            .map(|c| c.prf_credentials.iter().map(|p| p.id.as_str()).collect())
            .unwrap_or_default();
        // Credential names leak device info — only send when unlocked
        let prf_names: Vec<&str> = if !locked {
            self.crypto_config
                .as_ref()
                .map(|c| c.prf_credentials.iter().map(|p| p.name.as_str()).collect())
                .unwrap_or_default()
        } else {
            vec![]
        };
        let json = serde_json::json!({
            "locked": locked,
            "needs_setup": needs_setup,
            "encrypted": self.encrypted,
            "prf_credential_ids": prf_ids,
            "prf_credential_names": prf_names,
        });
        write_json(sock, &json.to_string())
    }

    fn api_unlock(
        &mut self,
        sock: &mut TcpStream,
        headers: &[httparse::Header<'_>],
        raw_buf: &[u8],
        header_len: usize,
    ) -> io::Result<()> {
        if !self.is_locked() {
            return write_error(sock, 400, "Not locked");
        }
        let config = match &self.crypto_config {
            Some(c) => c,
            None => return write_error(sock, 500, "No crypto config"),
        };

        let body = read_body(sock, headers, raw_buf, header_len)?;
        let req: serde_json::Value = serde_json::from_slice(&body)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

        let master = if let Some(rk_str) = req.get("recovery_key").and_then(|v| v.as_str()) {
            let recovery = match crypto::parse_recovery_key(rk_str) {
                Ok(r) => r,
                Err(_) => return write_error(sock, 403, "Unlock failed"),
            };
            match config.unlock_with_recovery_key(&recovery) {
                Ok(k) => k,
                Err(_) => return write_error(sock, 403, "Unlock failed"),
            }
        } else if let Some(prf_b64) = req.get("prf_key").and_then(|v| v.as_str()) {
            let prf_bytes =
                base64::Engine::decode(&base64::engine::general_purpose::STANDARD, prf_b64)
                    .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            match config.unlock_with_prf(&prf_bytes) {
                Ok(k) => k,
                Err(_) => return write_error(sock, 403, "Unlock failed"),
            }
        } else {
            return write_error(sock, 400, "Provide recovery_key or prf_key");
        };

        self.vault = Some(Vault::new(master));
        let token_hex = self.create_session();
        let cookie = format!("tansu_session={token_hex}; HttpOnly; SameSite=Strict; Path=/");

        self.reindex_with_vault();

        write_json_with_cookie(sock, r#"{"ok":true}"#, &cookie)
    }

    fn api_lock(&mut self, sock: &TcpStream) -> io::Result<()> {
        if self.encrypted {
            self.lock_server();
        }
        write_json(sock, r#"{"ok":true}"#)
    }

    fn api_prf_register(
        &mut self,
        sock: &mut TcpStream,
        headers: &[httparse::Header<'_>],
        raw_buf: &[u8],
        header_len: usize,
    ) -> io::Result<()> {
        let vault = match &self.vault {
            Some(v) => v,
            None => return write_error(sock, 403, "Locked"),
        };

        let body = read_body(sock, headers, raw_buf, header_len)?;

        #[derive(Deserialize)]
        struct PrfRegReq {
            credential_id: String,
            prf_key: String,
            name: String,
        }
        let req: PrfRegReq = serde_json::from_slice(&body)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

        let prf_bytes =
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &req.prf_key)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

        let kek = crypto::kek_from_prf(&prf_bytes);
        let wrapped = vault.wrap_master_key(&kek);

        let config = match &mut self.crypto_config {
            Some(c) => c,
            None => return write_error(sock, 500, "No crypto config"),
        };

        config.prf_credentials.push(crypto::PrfCredential {
            id: req.credential_id,
            name: req.name,
            created: timestamp_now(),
            wrapped_key: (&wrapped).into(),
        });
        config.save(&self.dir)?;

        write_json(sock, r#"{"ok":true}"#)
    }

    fn api_prf_remove(
        &mut self,
        sock: &mut TcpStream,
        headers: &[httparse::Header<'_>],
        raw_buf: &[u8],
        header_len: usize,
    ) -> io::Result<()> {
        if self.vault.is_none() {
            return write_error(sock, 403, "Locked");
        }

        let body = read_body(sock, headers, raw_buf, header_len)?;

        #[derive(Deserialize)]
        struct PrfRemoveReq {
            credential_id: String,
        }
        let req: PrfRemoveReq = serde_json::from_slice(&body)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

        let config = match &mut self.crypto_config {
            Some(c) => c,
            None => return write_error(sock, 500, "No crypto config"),
        };

        config.prf_credentials.retain(|c| c.id != req.credential_id);
        config.save(&self.dir)?;

        write_json(sock, r#"{"ok":true}"#)
    }

    fn api_search(&self, sock: &TcpStream, path_raw: &str) -> io::Result<()> {
        let q = query_param(path_raw, "q").unwrap_or_default();
        if q.is_empty() {
            return write_json(sock, "[]");
        }
        let filter_path = query_param(path_raw, "path");
        let s = &self.settings;
        let results = self.index.search(
            &q,
            s.result_limit,
            filter_path.as_deref(),
            s.fuzzy_distance,
            s.weights(),
            s.show_score_breakdown,
        );
        let hits: Vec<SearchHit> = results
            .iter()
            .map(|r| SearchHit {
                path: &r.path,
                title: &r.title,
                excerpt: &r.excerpt,
                score: r.score,
                field_scores: FieldScoresJson {
                    title: r.field_scores.title,
                    headings: r.field_scores.headings,
                    tags: r.field_scores.tags,
                    content: r.field_scores.content,
                },
            })
            .collect();
        respond_json(sock, &hits)
    }

    fn api_get_note(&self, sock: &TcpStream, path_raw: &str) -> io::Result<()> {
        let Some(rel) = query_param(path_raw, "path") else {
            return write_error(sock, 400, "missing path param");
        };
        let full = self.dir.join(&rel);
        if !full.starts_with(&self.dir) {
            return write_error(sock, 403, "Forbidden");
        }
        if !full.is_file() {
            return write_error(sock, 404, "Not Found");
        }
        let content = self.read_content(&full)?;
        let mtime = mtime_secs(&full);
        respond_json(
            sock,
            &NoteResponse {
                content: &content,
                mtime,
            },
        )
    }

    fn api_put_note(
        &mut self,
        stream: &mut TcpStream,
        path_raw: &str,
        headers: &[httparse::Header<'_>],
        raw_buf: &[u8],
        header_len: usize,
    ) -> io::Result<()> {
        let Some(rel) = query_param(path_raw, "path") else {
            return write_error(stream, 400, "missing path param");
        };
        let full = self.dir.join(&rel);
        if !full.starts_with(&self.dir) {
            return write_error(stream, 403, "Forbidden");
        }

        let req: PutNoteRequest = parse_body(stream, headers, raw_buf, header_len)?;
        let current_mtime = mtime_secs(&full);

        if req.expected_mtime != 0 && current_mtime != req.expected_mtime {
            let current_content = self.read_content(&full).unwrap_or_default();
            return respond_json_status(
                stream,
                409,
                "Conflict",
                &ConflictResponse {
                    conflict: true,
                    content: &current_content,
                    mtime: current_mtime,
                },
            );
        }

        // Skip revision + write if content hasn't changed
        let current_content = self.read_content(&full).unwrap_or_default();
        if current_content == req.content {
            return respond_json(
                stream,
                &MtimeResponse {
                    mtime: current_mtime,
                },
            );
        }

        revisions::save_revision(&self.dir, &rel, &full);
        self.write_content(&full, req.content.as_bytes())?;
        self.index.index_note(&rel, &req.content, &full);
        self.file_index.index_file(&rel, mtime_secs(&full));

        respond_json(
            stream,
            &MtimeResponse {
                mtime: mtime_secs(&full),
            },
        )
    }

    fn api_create_note(
        &mut self,
        stream: &mut TcpStream,
        path_raw: &str,
        headers: &[httparse::Header<'_>],
        raw_buf: &[u8],
        header_len: usize,
    ) -> io::Result<()> {
        let Some(rel) = query_param(path_raw, "path") else {
            return write_error(stream, 400, "missing path param");
        };
        let full = self.dir.join(&rel);
        if !full.starts_with(&self.dir) {
            return write_error(stream, 403, "Forbidden");
        }
        if full.exists() {
            return write_error(stream, 409, "file already exists");
        }

        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent)?;
        }

        let body = read_body(stream, headers, raw_buf, header_len)?;
        let content = if body.is_empty() {
            String::new()
        } else {
            let req: CreateNoteRequest =
                serde_json::from_slice(&body).map_err(|e| io::Error::other(e.to_string()))?;
            req.content
        };

        self.write_content(&full, content.as_bytes())?;
        self.index.index_note(&rel, &content, &full);
        self.file_index.index_file(&rel, mtime_secs(&full));

        respond_json_status(
            stream,
            201,
            "Created",
            &MtimeResponse {
                mtime: mtime_secs(&full),
            },
        )
    }

    fn api_delete_note(&mut self, sock: &TcpStream, path_raw: &str) -> io::Result<()> {
        let Some(rel) = query_param(path_raw, "path") else {
            return write_error(sock, 400, "missing path param");
        };
        let full = self.dir.join(&rel);
        if !full.starts_with(&self.dir) {
            return write_error(sock, 403, "Forbidden");
        }

        revisions::save_revision(&self.dir, &rel, &full);
        self.mark_self_write(&full);
        fs::remove_file(&full)?;
        self.index.remove_note(&rel);
        self.file_index.remove_file(&rel);

        // Remove from pinned list if present
        let mut pinned = self.load_pinned();
        let before = pinned.len();
        pinned.retain(|p| p != &rel);
        if pinned.len() != before {
            let _ = self.save_pinned(&pinned);
        }

        respond_json(sock, &OkResponse { ok: true })
    }

    fn api_rename(
        &mut self,
        stream: &mut TcpStream,
        headers: &[httparse::Header<'_>],
        raw_buf: &[u8],
        header_len: usize,
    ) -> io::Result<()> {
        let req: RenameRequest = parse_body(stream, headers, raw_buf, header_len)?;

        let old_full = self.dir.join(&req.old_path);
        let new_full = self.dir.join(&req.new_path);
        if !old_full.starts_with(&self.dir) || !new_full.starts_with(&self.dir) {
            return write_error(stream, 403, "Forbidden");
        }
        if !old_full.exists() {
            return write_error(stream, 404, "source not found");
        }
        if new_full.exists() {
            return write_error(stream, 409, "target already exists");
        }

        revisions::save_revision(&self.dir, &req.old_path, &old_full);

        if let Some(parent) = new_full.parent() {
            fs::create_dir_all(parent)?;
        }

        self.mark_self_write(&old_full);
        self.mark_self_write(&new_full);
        fs::rename(&old_full, &new_full)?;

        self.index.remove_note(&req.old_path);
        self.file_index.remove_file(&req.old_path);
        if let Ok(content) = self.read_content(&new_full) {
            self.index.index_note(&req.new_path, &content, &new_full);
            self.file_index.index_file(&req.new_path, mtime_secs(&new_full));
        }

        let old_stem = Path::new(&req.old_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&req.old_path);
        let new_stem = Path::new(&req.new_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&req.new_path);

        // Commit now so get_backlinks sees the updated index
        self.index.commit();

        let mut updated = Vec::new();
        let referencing = self.index.get_backlinks(old_stem);
        for note_path in &referencing {
            let note_full = self.dir.join(note_path);
            if let Ok(content) = self.read_content(&note_full) {
                let new_content =
                    content.replace(&format!("[[{old_stem}]]"), &format!("[[{new_stem}]]"));
                if new_content != content {
                    revisions::save_revision(&self.dir, note_path, &note_full);
                    if let Err(e) = self.write_content(&note_full, new_content.as_bytes()) {
                        eprintln!("rename: failed to update {}: {e}", note_full.display());
                        continue;
                    }
                    self.index.index_note(note_path, &new_content, &note_full);
                    updated.push(note_path.clone());
                }
            }
        }
        // Single commit for all backlink updates
        if !updated.is_empty() {
            self.index.commit();
        }

        // Update pinned paths if the renamed file was pinned
        let mut pinned = self.load_pinned();
        if let Some(slot) = pinned.iter_mut().find(|p| *p == &req.old_path) {
            *slot = req.new_path.clone();
            let _ = self.save_pinned(&pinned);
        }

        respond_json(stream, &RenameResponse { updated })
    }

    fn api_list_notes(&self, sock: &TcpStream) -> io::Result<()> {
        let notes = self.index.get_all_notes();
        let entries: Vec<NoteListEntry> = notes
            .iter()
            .map(|n| NoteListEntry {
                path: &n.path,
                title: &n.title,
            })
            .collect();
        respond_json(sock, &entries)
    }

    fn api_backlinks(&self, sock: &TcpStream, path_raw: &str) -> io::Result<()> {
        let Some(rel) = query_param(path_raw, "path") else {
            return write_error(sock, 400, "missing path param");
        };
        let stem = Path::new(&rel)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&rel);
        let links = self.index.get_backlinks(stem);
        respond_json(sock, &links)
    }

    fn api_upload_image(
        &mut self,
        stream: &mut TcpStream,
        headers: &[httparse::Header<'_>],
        raw_buf: &[u8],
        header_len: usize,
    ) -> io::Result<()> {
        let body = read_body(stream, headers, raw_buf, header_len)?;
        if body.is_empty() {
            return write_error(stream, 400, "empty body");
        }

        let suggested = headers
            .iter()
            .find(|h| h.name.eq_ignore_ascii_case("X-Filename"))
            .and_then(|h| std::str::from_utf8(h.value).ok())
            .unwrap_or("image.webp");

        let images_dir = self.dir.join("z-images");
        fs::create_dir_all(&images_dir)?;

        let mut filename = suggested.to_string();
        let mut dest = images_dir.join(&filename);
        let mut counter = 1u32;
        while dest.exists() {
            let stem = Path::new(suggested)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("image");
            let ext = Path::new(suggested)
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("webp");
            filename = format!("{stem}-{counter}.{ext}");
            dest = images_dir.join(&filename);
            counter += 1;
        }

        self.write_content_raw(&dest, &body)?;

        respond_json_status(
            stream,
            201,
            "Created",
            &FilenameResponse {
                filename: &filename,
            },
        )
    }

    fn api_list_revisions(&self, sock: &TcpStream, path_raw: &str) -> io::Result<()> {
        let Some(rel) = query_param(path_raw, "path") else {
            return write_error(sock, 400, "missing path param");
        };
        let revs = revisions::list_revisions(&self.dir, &rel);
        respond_json(sock, &revs)
    }

    fn api_get_revision(&self, sock: &TcpStream, path_raw: &str) -> io::Result<()> {
        let Some(rel) = query_param(path_raw, "path") else {
            return write_error(sock, 400, "missing path param");
        };
        let Some(ts_str) = query_param(path_raw, "ts") else {
            return write_error(sock, 400, "missing ts param");
        };
        let ts: u64 = ts_str.parse().map_err(|_| io::Error::other("bad ts"))?;

        match revisions::get_revision(&self.dir, &rel, ts, self.vault.as_ref()) {
            Some(content) => respond_json(sock, &ContentResponse { content: &content }),
            None => write_error(sock, 404, "revision not found"),
        }
    }

    fn api_get_state(&self, sock: &TcpStream) -> io::Result<()> {
        let path = self.dir.join(".tansu/state.json");
        match fs::read_to_string(&path) {
            Ok(json) => write_body(sock, "application/json", json.as_bytes()),
            Err(_) => write_json(sock, "{}"),
        }
    }

    fn api_put_state(
        &self,
        stream: &mut TcpStream,
        headers: &[httparse::Header<'_>],
        raw_buf: &[u8],
        header_len: usize,
    ) -> io::Result<()> {
        let body = read_body(stream, headers, raw_buf, header_len)?;
        // Validate it's valid JSON
        let _: serde_json::Value =
            serde_json::from_slice(&body).map_err(|e| io::Error::other(e.to_string()))?;
        let path = self.dir.join(".tansu/state.json");
        fs::write(&path, &body)?;
        respond_json(stream, &OkResponse { ok: true })
    }

    fn api_get_settings(&self, sock: &TcpStream) -> io::Result<()> {
        respond_json(sock, &self.settings)
    }

    fn api_put_settings(
        &mut self,
        stream: &mut TcpStream,
        headers: &[httparse::Header<'_>],
        raw_buf: &[u8],
        header_len: usize,
    ) -> io::Result<()> {
        let new_settings: Settings = parse_body(stream, headers, raw_buf, header_len)?;
        let needs_reindex = new_settings.excluded_folders != self.settings.excluded_folders;
        new_settings.save(&self.dir)?;
        self.settings = new_settings;
        if needs_reindex {
            if self.vault.is_some() {
                // Encrypted mode: reindex synchronously using vault
                self.reindex_with_vault();
            } else {
                let index = self.index.clone();
                let file_index = self.file_index.clone();
                let dir = self.dir.clone();
                let excluded = self.settings.excluded_folders.clone();
                std::thread::spawn(move || {
                    index.full_reindex(&dir, &excluded);
                    file_index.full_reindex(&dir, &excluded);
                });
            }
        }
        respond_json(stream, &OkResponse { ok: true })
    }

    fn api_restore_revision(&mut self, sock: &TcpStream, path_raw: &str) -> io::Result<()> {
        let Some(rel) = query_param(path_raw, "path") else {
            return write_error(sock, 400, "missing path param");
        };
        let Some(ts_str) = query_param(path_raw, "ts") else {
            return write_error(sock, 400, "missing ts param");
        };
        let ts: u64 = ts_str.parse().map_err(|_| io::Error::other("bad ts"))?;

        let full = self.dir.join(&rel);
        if !full.starts_with(&self.dir) {
            return write_error(sock, 403, "Forbidden");
        }

        let Some(rev_content) = revisions::get_revision(&self.dir, &rel, ts, self.vault.as_ref())
        else {
            return write_error(sock, 404, "revision not found");
        };

        revisions::save_revision(&self.dir, &rel, &full);
        self.write_content(&full, rev_content.as_bytes())?;
        self.index.index_note(&rel, &rev_content, &full);
        self.file_index.index_file(&rel, mtime_secs(&full));

        respond_json(
            sock,
            &MtimeResponse {
                mtime: mtime_secs(&full),
            },
        )
    }

    fn api_filesearch(&self, sock: &TcpStream, path_raw: &str) -> io::Result<()> {
        let q = query_param(path_raw, "q").unwrap_or_default();
        if q.is_empty() {
            return write_json(sock, "[]");
        }
        let results = self.file_index.search_names(&q, 30);
        let hits: Vec<serde_json::Value> = results
            .iter()
            .map(|r| {
                serde_json::json!({
                    "path": r.path,
                    "title": r.title,
                })
            })
            .collect();
        let json = serde_json::to_string(&hits)
            .unwrap_or_else(|_| "[]".to_string());
        write_json(sock, &json)
    }

    fn api_recent_files(&self, sock: &TcpStream) -> io::Result<()> {
        let results = self.file_index.recent(50);
        let entries: Vec<serde_json::Value> = results
            .iter()
            .map(|r| {
                serde_json::json!({
                    "path": r.path,
                    "title": r.title,
                    "mtime": r.mtime,
                })
            })
            .collect();
        let json = serde_json::to_string(&entries)
            .unwrap_or_else(|_| "[]".to_string());
        write_json(sock, &json)
    }

    fn pinned_path(&self) -> PathBuf {
        self.dir.join(".tansu/pinned.json")
    }

    fn load_pinned(&self) -> Vec<String> {
        match fs::read_to_string(self.pinned_path()) {
            Ok(json) => serde_json::from_str::<Vec<String>>(&json).unwrap_or_default(),
            Err(_) => Vec::new(),
        }
    }

    fn save_pinned(&self, paths: &[String]) -> io::Result<()> {
        let json = serde_json::to_string(paths)
            .map_err(|e| io::Error::other(e.to_string()))?;
        fs::write(self.pinned_path(), json)
    }

    fn api_get_pinned(&self, sock: &TcpStream) -> io::Result<()> {
        let paths = self.load_pinned();
        let entries: Vec<serde_json::Value> = paths
            .iter()
            .map(|p| {
                let title = self.file_index.lookup_path(p)
                    .unwrap_or_else(|| {
                        Path::new(p)
                            .file_stem()
                            .and_then(|s| s.to_str())
                            .unwrap_or(p)
                            .to_string()
                    });
                serde_json::json!({ "path": p, "title": title })
            })
            .collect();
        let json = serde_json::to_string(&entries)
            .unwrap_or_else(|_| "[]".to_string());
        write_json(sock, &json)
    }

    fn api_pin(
        &self,
        stream: &mut TcpStream,
        headers: &[httparse::Header<'_>],
        raw_buf: &[u8],
        header_len: usize,
    ) -> io::Result<()> {
        let req: PinRequest = parse_body(stream, headers, raw_buf, header_len)?;
        let mut paths = self.load_pinned();
        if !paths.contains(&req.path) {
            paths.push(req.path);
            self.save_pinned(&paths)?;
        }
        respond_json(stream, &OkResponse { ok: true })
    }

    fn api_unpin(
        &self,
        stream: &mut TcpStream,
        headers: &[httparse::Header<'_>],
        raw_buf: &[u8],
        header_len: usize,
    ) -> io::Result<()> {
        let req: PinRequest = parse_body(stream, headers, raw_buf, header_len)?;
        let mut paths = self.load_pinned();
        let before = paths.len();
        paths.retain(|p| p != &req.path);
        if paths.len() != before {
            self.save_pinned(&paths)?;
        }
        respond_json(stream, &OkResponse { ok: true })
    }
}

fn timestamp_now() -> String {
    use std::time::SystemTime;
    let secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Simple ISO-8601-ish format without chrono
    let s = secs % 60;
    let m = (secs / 60) % 60;
    let h = (secs / 3600) % 24;
    let days = secs / 86400;
    // Approximate date from days since epoch (good enough for a created timestamp)
    let (y, mo, d) = days_to_ymd(days);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

fn days_to_ymd(mut days: u64) -> (u64, u64, u64) {
    // Simplified Gregorian calendar calculation
    let mut y = 1970;
    loop {
        let dy = if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) {
            366
        } else {
            365
        };
        if days < dy {
            break;
        }
        days -= dy;
        y += 1;
    }
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let month_days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut mo = 0;
    for &md in &month_days {
        if days < md {
            break;
        }
        days -= md;
        mo += 1;
    }
    (y, mo + 1, days + 1)
}

fn die(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(1);
}

fn subcommand_dir(args: &[String]) -> PathBuf {
    let dir_str = args.first().map(|s| s.as_str()).unwrap_or(".");
    match fs::canonicalize(dir_str) {
        Ok(p) if p.is_dir() => p,
        Ok(_) => die("path is not a directory"),
        Err(e) => die(&format!("{dir_str}: {e}")),
    }
}

fn cmd_encrypt(dir: &Path) {
    use zeroize::Zeroize;
    let crypto_path = dir.join(".tansu/crypto.json");
    if crypto_path.exists() {
        die("already encrypted (crypto.json exists). Run 'tansu decrypt' first to re-encrypt.");
    }

    let mut master = crypto::generate_master_key();
    let mut recovery = crypto::generate_recovery_key();
    let kek = crypto::kek_from_recovery_key(&recovery);
    let wrapped = crypto::wrap_key(&master, &kek);

    eprintln!(
        "Generated recovery key (save this — it cannot be shown again):\n\n  {}\n",
        crypto::format_recovery_key(&recovery)
    );
    eprint!("Press Enter to continue after saving...");
    let _ = io::stderr().flush();
    let mut line = String::new();
    io::stdin().read_line(&mut line).unwrap();

    let config = CryptoConfig {
        version: 1,
        master_key_recovery: (&wrapped).into(),
        prf_credentials: vec![],
    };
    config
        .save(dir)
        .unwrap_or_else(|e| die(&format!("write crypto.json: {e}")));

    let vault = Vault::from_raw(master);
    master.zeroize();
    recovery.zeroize();

    let files = crypto::collect_content_files(dir);
    let total = files.len();
    let mut encrypted = 0;

    for path in &files {
        let data = match fs::read(path) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("  skip {}: {e}", path.display());
                continue;
            }
        };
        if crypto::is_encrypted(&data) {
            encrypted += 1;
            continue;
        }
        vault.write(path, &data).unwrap_or_else(|e| {
            die(&format!("encrypt {}: {e}", path.display()));
        });
        encrypted += 1;
        eprint!("\rEncrypting... {encrypted}/{total} files");
    }

    eprintln!("\rEncrypted {encrypted}/{total} files.         ");
    eprintln!("Done. Server will now require unlock on startup.");
}

fn cmd_decrypt(dir: &Path) {
    let config = CryptoConfig::load(dir).unwrap_or_else(|e| die(&format!("load crypto.json: {e}")));

    eprint!("Recovery key: ");
    let _ = io::stderr().flush();
    let mut input = String::new();
    io::stdin().read_line(&mut input).unwrap();
    let recovery = crypto::parse_recovery_key(input.trim())
        .unwrap_or_else(|e| die(&format!("invalid recovery key: {e}")));

    let master = config
        .unlock_with_recovery_key(&recovery)
        .unwrap_or_else(|_| die("wrong recovery key"));

    let vault = Vault::new(master);
    let files = crypto::collect_content_files(dir);
    let total = files.len();
    let mut decrypted = 0;

    for path in &files {
        let data = match fs::read(path) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("  skip {}: {e}", path.display());
                continue;
            }
        };
        if !crypto::is_encrypted(&data) {
            decrypted += 1;
            continue;
        }
        let plaintext = vault.decrypt(&data).unwrap_or_else(|e| {
            die(&format!("decrypt {}: {e}", path.display()));
        });
        crypto::atomic_write(path, &plaintext).unwrap_or_else(|e| {
            die(&format!("write {}: {e}", path.display()));
        });
        decrypted += 1;
        eprint!("\rDecrypting... {decrypted}/{total} files");
    }

    eprintln!("\rDecrypted {decrypted}/{total} files.         ");

    // Remove crypto.json
    let crypto_path = dir.join(".tansu/crypto.json");
    fs::remove_file(&crypto_path).unwrap_or_else(|e| {
        eprintln!("warning: could not remove crypto.json: {e}");
    });
    eprintln!("Removed crypto.json. Server will now start in plaintext mode.");
}

fn main() {
    // Check for subcommands before normal arg parsing
    let args: Vec<String> = env::args().collect();
    if args.len() >= 2 {
        match args[1].as_str() {
            "encrypt" => {
                let dir = subcommand_dir(&args[2..]);
                cmd_encrypt(&dir);
                return;
            }
            "decrypt" => {
                let dir = subcommand_dir(&args[2..]);
                cmd_decrypt(&dir);
                return;
            }
            _ => {}
        }
    }

    let mut quiet = false;
    let mut port = String::from("3000");
    let mut bind = String::from("127.0.0.1");
    let mut dir = String::new();

    let mut args_iter = env::args().skip(1);
    while let Some(arg) = args_iter.next() {
        match arg.as_str() {
            "-q" => quiet = true,
            "-p" | "--port" => {
                port = args_iter
                    .next()
                    .unwrap_or_else(|| die("-p requires a value"));
            }
            "-b" | "--bind" => {
                bind = args_iter
                    .next()
                    .unwrap_or_else(|| die("-b requires a value"));
            }
            "-h" | "--help" => {
                eprintln!(
                    "usage: tansu [options] <directory>\n\
                     \n\
                     commands:\n\
                     \x20 encrypt <dir>   encrypt all notes in directory\n\
                     \x20 decrypt <dir>   decrypt all notes in directory\n\
                     \n\
                     options:\n\
                     \x20 -q              quiet; disable request logging\n\
                     \x20 -p port         port to listen on (default: 3000)\n\
                     \x20 -b address      bind address (default: 127.0.0.1)"
                );
                std::process::exit(0);
            }
            "-V" | "--version" => {
                println!("tansu {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            _ => dir = arg,
        }
    }

    if dir.is_empty() {
        die("usage: tansu <directory>");
    }

    let dir = match fs::canonicalize(&dir) {
        Ok(p) if p.is_dir() => p,
        Ok(_) => die("path is not a directory"),
        Err(e) => die(&format!("{dir}: {e}")),
    };

    let settings = Settings::load(&dir);
    let crypto_config = CryptoConfig::load_if_exists(&dir)
        .unwrap_or_else(|e| die(&format!("load crypto.json: {e}")));
    let encrypted = crypto_config.is_some();

    let index_dir = dir.join(".tansu/index");
    fs::create_dir_all(&index_dir).unwrap_or_else(|e| die(&format!("create index dir: {e}")));
    let index =
        Index::open_or_create(&index_dir).unwrap_or_else(|e| die(&format!("open index: {e}")));

    let names_dir = dir.join(".tansu/names-index");
    fs::create_dir_all(&names_dir)
        .unwrap_or_else(|e| die(&format!("create names index dir: {e}")));
    let file_index = FileNameIndex::open_or_create(&names_dir)
        .unwrap_or_else(|e| die(&format!("open names index: {e}")));

    // Only reindex at startup in plaintext mode; encrypted mode rebuilds on unlock
    if !encrypted {
        let index_clone = index.clone();
        let file_index_clone = file_index.clone();
        let dir_clone = dir.clone();
        let excluded = settings.excluded_folders.clone();
        std::thread::spawn(move || {
            index_clone.full_reindex(&dir_clone, &excluded);
            file_index_clone.full_reindex(&dir_clone, &excluded);
        });
    }

    let self_writes = Arc::new(Mutex::new(HashSet::<PathBuf>::new()));
    let (watch_tx, watch_rx) = mpsc::channel();
    let _watcher = watcher::start_watcher(&dir, watch_tx, self_writes.clone())
        .unwrap_or_else(|e| die(&format!("start watcher: {e}")));

    let addr = format!("{bind}:{port}");
    let listener =
        TcpListener::bind(&addr).unwrap_or_else(|e| die(&format!("failed to bind {addr}: {e}")));

    if encrypted {
        eprintln!(
            "\ttansu serving {} on http://{addr} (locked)",
            dir.display()
        );
    } else {
        eprintln!("\ttansu serving {} on http://{addr}", dir.display());
    }

    let mut srv = Server {
        dir,
        quiet,
        index,
        file_index,
        settings,
        watch_rx,
        self_writes,
        sse_client: Arc::new(Mutex::new(None)),
        vault: None,
        session: None,
        encrypted,
        crypto_config,
    };

    for stream in listener.incoming() {
        match stream {
            Ok(s) => {
                if let Err(e) = srv.handle(s) {
                    if !quiet {
                        eprintln!("error: {e}");
                    }
                }
            }
            Err(e) => {
                if !quiet {
                    eprintln!("accept error: {e}");
                }
            }
        }
    }
}
