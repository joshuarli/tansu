use std::{
    collections::HashMap,
    env, fs,
    io::{self, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, mpsc},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use tansu::api_types::{
    AppStatus, ContentResponse, CreateNoteRequest, FieldScores, FileSearchResult, FilenameResponse,
    NoteEntry, NoteResponse, OkResponse, PinRequest, PinnedFileEntry, PrfRegisterRequest,
    PrfRemoveRequest, PutNoteRequest, RecentFileEntry, RenameRequest, RenameResponse, SaveResult,
    SearchHit, SessionState as SessionStateJson, TagListResponse, UnlockRequest, VaultEntry,
};
use tansu::crypto::{self, CryptoConfig, Vault};
use tansu::filenames::FileNameIndex;
use tansu::frontmatter;
use tansu::http::*;
use tansu::index::Index;
use tansu::revisions;
use tansu::scanner;
use tansu::settings::Settings;
use tansu::watcher::{self, WatchEvent};

#[cfg(feature = "embed")]
static EMBED_APP_JS: &[u8] = include_bytes!("../web/static/app.js");
#[cfg(feature = "embed")]
static EMBED_APP_CSS: &[u8] = include_bytes!("../web/static/app.css");
#[cfg(feature = "embed")]
static EMBED_INDEX_HTML: &[u8] = include_bytes!("../web/index.html");

const SESSION_TIMEOUT_SECS: u64 = 24 * 60 * 60; // 24 hours

struct SessionState {
    token: [u8; 32],
    last_activity: Instant,
}

struct SseClient {
    stream: TcpStream,
    vault_index: usize,
}

struct VaultState {
    name: String,
    dir: PathBuf,
    /// True if crypto.json exists (encrypted mode). False = plaintext, no auth needed.
    encrypted: bool,
    crypto_config: Option<CryptoConfig>,
    /// None = plaintext mode or locked. Check `encrypted` to distinguish.
    vault: Option<Vault>,
    sessions: Vec<SessionState>,
    index: Index,
    file_index: FileNameIndex,
    settings: Settings,
    _watcher: notify::RecommendedWatcher,
    watch_rx: mpsc::Receiver<WatchEvent>,
    self_writes: Arc<Mutex<HashMap<PathBuf, Instant>>>,
}

struct Server {
    quiet: bool,
    vaults: Vec<VaultState>,
    sse_clients: Arc<Mutex<Vec<SseClient>>>,
}

fn resolve_path_under_root(root: &Path, raw: &str) -> Option<(String, PathBuf)> {
    let mut full = PathBuf::new();
    if !normalize_into(root, raw, &mut full) {
        return None;
    }
    let rel = full.strip_prefix(root).ok()?.to_string_lossy().into_owned();
    if rel.is_empty() {
        return None;
    }
    Some((rel, full))
}

fn spawn_plaintext_reindex(
    name: String,
    dir: PathBuf,
    index: Index,
    file_index: FileNameIndex,
    excluded: Vec<String>,
) {
    std::thread::spawn(move || {
        let start = Instant::now();
        index.full_reindex(&dir, &excluded);
        file_index.full_reindex(&dir, &excluded);
        let elapsed = start.elapsed();
        eprintln!(
            "\tindexed {} in {:.1}ms",
            name,
            elapsed.as_secs_f64() * 1000.0
        );
    });
}

fn cookie_value<'a>(headers: &[httparse::Header<'a>], name: &str) -> Option<&'a str> {
    let cookie = find_header(headers, "cookie")?;
    for part in cookie.split(';') {
        let (key, value) = part.trim().split_once('=')?;
        if key == name {
            return Some(value);
        }
    }
    None
}

fn session_cookie_name(vault_index: usize) -> String {
    format!("tansu_session_{vault_index}")
}

fn requested_vault_index(
    headers: &[httparse::Header<'_>],
    path_raw: &str,
    vault_count: usize,
) -> usize {
    find_header(headers, "x-tansu-vault")
        .and_then(|value| value.parse::<usize>().ok())
        .or_else(|| query_param(path_raw, "vault").and_then(|value| value.parse::<usize>().ok()))
        .filter(|&index| index < vault_count)
        .unwrap_or(0)
}

impl Server {
    fn request_vault_index(&self, headers: &[httparse::Header<'_>], path_raw: &str) -> usize {
        requested_vault_index(headers, path_raw, self.vaults.len())
    }

    fn is_locked(&self, vault_index: usize) -> bool {
        self.vaults[vault_index].encrypted && self.vaults[vault_index].vault.is_none()
    }

    fn check_session(&mut self, vault_index: usize, headers: &[httparse::Header<'_>]) -> bool {
        if !self.vaults[vault_index].encrypted {
            return true; // plaintext mode, no auth needed
        }
        let cookie_name = session_cookie_name(vault_index);
        let Some(cookie_token) = cookie_value(headers, &cookie_name) else {
            return false;
        };

        let mut valid = false;
        {
            let sessions = &mut self.vaults[vault_index].sessions;
            sessions.retain(|session| {
                session.last_activity.elapsed().as_secs() <= SESSION_TIMEOUT_SECS
            });
            for session in sessions.iter_mut() {
                let token_hex = hex_encode(&session.token);
                if token_hex.len() != cookie_token.len() {
                    continue;
                }
                use subtle::ConstantTimeEq;
                if bool::from(token_hex.as_bytes().ct_eq(cookie_token.as_bytes())) {
                    session.last_activity = Instant::now();
                    valid = true;
                    break;
                }
            }
        }

        if valid {
            return true;
        }
        if self.vaults[vault_index].sessions.is_empty() {
            self.lock_vault(vault_index);
        }
        false
    }

    fn create_session(&mut self, vault_index: usize) -> String {
        let mut token = [0u8; 32];
        use rand::RngCore;
        rand::rngs::OsRng.fill_bytes(&mut token);
        let hex = hex_encode(&token);
        self.vaults[vault_index].sessions.push(SessionState {
            token,
            last_activity: Instant::now(),
        });
        hex
    }

    fn lock_vault(&mut self, vault_index: usize) {
        self.vaults[vault_index].vault = None;
        self.vaults[vault_index].sessions.clear();
        let msg = b"event: locked\ndata: \n\n";
        let mut guard = self.sse_clients.lock().unwrap();
        guard.retain_mut(|client| {
            if client.vault_index != vault_index {
                return true;
            }
            let _ = client.stream.write_all(msg);
            false
        });
    }

    fn drain_watch_events(&mut self) {
        for vault_index in 0..self.vaults.len() {
            let events: Vec<WatchEvent> = self.vaults[vault_index].watch_rx.try_iter().collect();
            if events.is_empty() {
                continue;
            }

            let can_index =
                !self.vaults[vault_index].encrypted || self.vaults[vault_index].vault.is_some();
            let mut had_index_updates = false;

            for event in events {
                match event {
                    WatchEvent::Modified(path) | WatchEvent::Created(path) => {
                        let rel = path
                            .strip_prefix(&self.vaults[vault_index].dir)
                            .unwrap_or(&path);
                        let rel_str = rel.to_string_lossy().into_owned();
                        if can_index && let Ok(content) = self.read_content(vault_index, &path) {
                            self.reindex_note_and_file_for(vault_index, &rel_str, &content, &path);
                            had_index_updates = true;
                        }
                        self.broadcast_sse(vault_index, "changed", &rel_str);
                    }
                    WatchEvent::Removed(path) => {
                        let rel = path
                            .strip_prefix(&self.vaults[vault_index].dir)
                            .unwrap_or(&path);
                        let rel_str = rel.to_string_lossy().into_owned();
                        if can_index {
                            self.vaults[vault_index].index.remove_note(&rel_str);
                            self.vaults[vault_index].file_index.remove_file(&rel_str);
                            had_index_updates = true;
                        }
                        self.broadcast_sse(vault_index, "deleted", &rel_str);
                    }
                }
            }

            if had_index_updates {
                self.vaults[vault_index].index.commit();
                self.vaults[vault_index].file_index.commit();
            }
        }
    }

    fn broadcast_sse(&self, vault_index: usize, event_type: &str, path: &str) {
        let msg = format!("event: {event_type}\ndata: {path}\n\n");
        let mut guard = self.sse_clients.lock().unwrap();
        guard.retain_mut(|client| {
            client.vault_index != vault_index || client.stream.write_all(msg.as_bytes()).is_ok()
        });
    }

    fn mark_self_write(&self, vault_index: usize, path: &Path) {
        self.vaults[vault_index]
            .self_writes
            .lock()
            .unwrap()
            .insert(path.to_path_buf(), Instant::now());
    }

    /// Read a user-content file as String (decrypts if vault is active).
    fn read_content(&self, vault_index: usize, path: &Path) -> io::Result<String> {
        if let Some(ref vault) = self.vaults[vault_index].vault {
            vault.read_to_string(path)
        } else {
            fs::read_to_string(path)
        }
    }

    /// Read a user-content file as raw bytes (decrypts if vault is active).
    fn read_content_bytes(&self, vault_index: usize, path: &Path) -> io::Result<Vec<u8>> {
        if let Some(ref vault) = self.vaults[vault_index].vault {
            vault.read(path)
        } else {
            fs::read(path)
        }
    }

    /// Atomic write of user content (encrypts if vault is active).
    fn write_content(&self, vault_index: usize, path: &Path, content: &[u8]) -> io::Result<()> {
        self.mark_self_write(vault_index, path);
        if let Some(ref vault) = self.vaults[vault_index].vault {
            vault.write(path, content)
        } else {
            crypto::atomic_write(path, content)
        }
    }

    fn create_content_new(
        &self,
        vault_index: usize,
        path: &Path,
        content: &[u8],
    ) -> io::Result<()> {
        self.mark_self_write(vault_index, path);
        let data = if let Some(ref vault) = self.vaults[vault_index].vault {
            vault.encrypt(content)
        } else {
            content.to_vec()
        };
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;
        if let Err(err) = file.write_all(&data) {
            let _ = fs::remove_file(path);
            return Err(err);
        }
        Ok(())
    }

    fn remove_content_file(&self, vault_index: usize, path: &Path) -> io::Result<()> {
        self.mark_self_write(vault_index, path);
        fs::remove_file(path)
    }

    /// Plain write for non-content files (images upload, etc.)
    fn write_content_raw(&self, vault_index: usize, path: &Path, content: &[u8]) -> io::Result<()> {
        if let Some(ref vault) = self.vaults[vault_index].vault {
            let encrypted = vault.encrypt(content);
            fs::write(path, encrypted)
        } else {
            fs::write(path, content)
        }
    }

    fn reindex_note(&self, vault_index: usize, rel_path: &str, content: &str, full_path: &Path) {
        self.vaults[vault_index]
            .index
            .index_note(rel_path, content, full_path);
    }

    fn reindex_note_and_file(
        &self,
        vault_index: usize,
        rel_path: &str,
        content: &str,
        full_path: &Path,
    ) {
        self.reindex_note(vault_index, rel_path, content, full_path);
        let title = scanner::official_title(rel_path, content);
        self.vaults[vault_index]
            .file_index
            .index_file(rel_path, &title, mtime_secs(full_path));
    }

    fn reindex_note_and_file_for(
        &self,
        vault_index: usize,
        rel_path: &str,
        content: &str,
        full_path: &Path,
    ) {
        self.reindex_note_and_file(vault_index, rel_path, content, full_path);
    }

    fn resolve_vault_path(&self, vault_index: usize, raw: &str) -> Option<(String, PathBuf)> {
        resolve_path_under_root(&self.vaults[vault_index].dir, raw)
    }

    fn rel_for_title(base_rel: &str, title: &str) -> String {
        let dir = base_rel
            .rfind('/')
            .map(|idx| &base_rel[..=idx])
            .unwrap_or("");
        let stem = scanner::sanitize_filename_stem(title);
        format!("{dir}{stem}.md")
    }

    fn rel_with_suffix(base_rel: &str, title: &str, suffix: &str) -> String {
        let dir = base_rel
            .rfind('/')
            .map(|idx| &base_rel[..=idx])
            .unwrap_or("");
        let stem = scanner::sanitize_filename_stem(title);
        format!("{dir}{stem}-{suffix}.md")
    }

    fn suffix(attempt: u32) -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        let id = nanos ^ ((std::process::id() as u64) << 16) ^ attempt as u64;
        format!("{:06x}", id & 0x00ff_ffff)
    }

    fn create_at_available_path(
        &self,
        vault_index: usize,
        desired_rel: &str,
        title: &str,
        content: &str,
    ) -> io::Result<(String, PathBuf)> {
        for attempt in 0..100u32 {
            let rel = if attempt == 0 {
                desired_rel.to_string()
            } else {
                Self::rel_with_suffix(desired_rel, title, &Self::suffix(attempt))
            };
            let Some((rel, full)) = self.resolve_vault_path(vault_index, &rel) else {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "path escapes notes directory",
                ));
            };
            if let Some(parent) = full.parent() {
                fs::create_dir_all(parent)?;
            }
            match self.create_content_new(vault_index, &full, content.as_bytes()) {
                Ok(()) => return Ok((rel, full)),
                Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(err) => return Err(err),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "could not allocate a unique filename",
        ))
    }

    fn note_stem(rel_path: &str) -> String {
        Path::new(rel_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(rel_path)
            .to_string()
    }

    fn update_backlinks(
        &mut self,
        vault_index: usize,
        old_path: &str,
        new_path: &str,
    ) -> Vec<String> {
        let old_stem = Self::note_stem(old_path);
        let new_stem = Self::note_stem(new_path);
        if old_stem == new_stem {
            return Vec::new();
        }

        self.vaults[vault_index].index.commit();
        let mut updated = Vec::new();
        let referencing = self.vaults[vault_index].index.get_backlinks(&old_stem);
        for note_path in &referencing {
            let note_full = self.vaults[vault_index].dir.join(note_path);
            if let Ok(content) = self.read_content(vault_index, &note_full) {
                let new_content =
                    content.replace(&format!("[[{old_stem}]]"), &format!("[[{new_stem}]]"));
                if new_content != content {
                    revisions::save_revision(&self.vaults[vault_index].dir, note_path, &note_full);
                    if let Err(e) =
                        self.write_content(vault_index, &note_full, new_content.as_bytes())
                    {
                        eprintln!("rename: failed to update {}: {e}", note_full.display());
                        continue;
                    }
                    self.reindex_note_and_file(vault_index, note_path, &new_content, &note_full);
                    updated.push(note_path.clone());
                }
            }
        }
        if !updated.is_empty() {
            self.vaults[vault_index].index.commit();
            self.vaults[vault_index].file_index.commit();
        }
        updated
    }

    fn update_pinned_path(&self, vault_index: usize, old_path: &str, new_path: &str) {
        let mut pinned = self.load_pinned(vault_index);
        if let Some(slot) = pinned.iter_mut().find(|p| *p == old_path) {
            *slot = new_path.to_string();
            let _ = self.save_pinned(vault_index, &pinned);
        }
    }

    /// Reindex all markdown files using the vault for decryption.
    fn reindex_with_vault(&self, vault_index: usize) {
        let vault = match &self.vaults[vault_index].vault {
            Some(v) => v,
            None => return,
        };
        let start = Instant::now();
        let files = crypto::collect_content_files(&self.vaults[vault_index].dir);
        for path in &files {
            if path.extension().is_some_and(|e| e == "md")
                && let Ok(content) = vault.read_to_string(path)
            {
                let rel = path
                    .strip_prefix(&self.vaults[vault_index].dir)
                    .unwrap_or(path);
                let rel_str = rel.to_string_lossy();
                self.reindex_note_and_file(vault_index, &rel_str, &content, path);
            }
        }
        self.vaults[vault_index].index.commit();
        self.vaults[vault_index].file_index.commit();
        let elapsed = start.elapsed();
        eprintln!(
            "\tindexed {} in {:.1}ms",
            self.vaults[vault_index].name,
            elapsed.as_secs_f64() * 1000.0
        );
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
                            req.headers,
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
                        let body_len = content_length(req.headers);
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
        let vault_index = self.request_vault_index(headers, path_raw);
        let allow_without_unlock = path == "/api/vaults"
            || (method == "POST"
                && path.starts_with("/api/vaults/")
                && path.ends_with("/activate"));

        // Always allow: status, unlock, static assets, index page
        match path {
            "/api/status" => return self.api_status(vault_index, stream),
            "/api/unlock" if method == "POST" => {
                return self.api_unlock(vault_index, stream, headers, raw_buf, header_len);
            }
            _ => {}
        }

        // Static assets are always served (needed for unlock page)
        if path.starts_with("/static/") && method == "GET" {
            let decoded = percent_decode(path);
            #[cfg(feature = "embed")]
            return match decoded.strip_prefix("/static/").unwrap_or("") {
                "app.js" => write_body_cached(stream, "application/javascript", EMBED_APP_JS),
                "app.css" => write_body_cached(stream, "text/css", EMBED_APP_CSS),
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
        if self.is_locked(vault_index) {
            if path.starts_with("/api/") {
                if allow_without_unlock {
                    return self.dispatch_api(
                        vault_index,
                        stream,
                        method,
                        path,
                        path_raw,
                        headers,
                        raw_buf,
                        header_len,
                    );
                }
                return write_error(stream, 403, "Locked");
            }
            return write_redirect(stream, "/");
        }

        // If encrypted, check session
        if self.vaults[vault_index].encrypted
            && !allow_without_unlock
            && !self.check_session(vault_index, headers)
        {
            if path.starts_with("/api/") {
                return write_error(stream, 403, "Unauthorized");
            }
            return write_redirect(stream, "/");
        }

        if path.starts_with("/api/") {
            return self.dispatch_api(
                vault_index,
                stream,
                method,
                path,
                path_raw,
                headers,
                raw_buf,
                header_len,
            );
        }

        if path == "/events" {
            return self.handle_sse(vault_index, stream);
        }

        if method != "GET" {
            return write_error(stream, 405, "Method Not Allowed");
        }

        if path.starts_with("/z-images/") {
            let decoded = percent_decode(path);
            if !normalize_into(&self.vaults[vault_index].dir, &decoded, &mut fp) {
                return write_error(stream, 403, "Forbidden");
            }
            if !fp.is_file() {
                return write_error(stream, 404, "Not Found");
            }
            if self.vaults[vault_index].vault.is_some() {
                // Encrypted mode: decrypt and serve bytes
                let data = self.read_content_bytes(vault_index, &fp)?;
                return write_body_cached(stream, mime(&fp), &data);
            } else {
                let meta = fs::metadata(&fp)?;
                return serve_file_cached(stream, &fp, meta.len(), mime(&fp));
            }
        }

        self.serve_index(stream)
    }

    #[allow(clippy::too_many_arguments)]
    fn dispatch_api(
        &mut self,
        vault_index: usize,
        stream: &mut TcpStream,
        method: &str,
        path: &str,
        path_raw: &str,
        headers: &[httparse::Header<'_>],
        raw_buf: &[u8],
        header_len: usize,
    ) -> io::Result<()> {
        match (method, path) {
            ("GET", "/api/search") => self.api_search(vault_index, stream, path_raw),
            ("GET", "/api/note") => self.api_get_note(vault_index, stream, path_raw),
            ("PUT", "/api/note") => {
                self.api_put_note(vault_index, stream, path_raw, headers, raw_buf, header_len)
            }
            ("GET", "/api/tags") => self.api_get_tags(vault_index, stream, path_raw),
            ("POST", "/api/note") => {
                self.api_create_note(vault_index, stream, path_raw, headers, raw_buf, header_len)
            }
            ("DELETE", "/api/note") => self.api_delete_note(vault_index, stream, path_raw),
            ("POST", "/api/rename") => {
                self.api_rename(vault_index, stream, headers, raw_buf, header_len)
            }
            ("GET", "/api/notes") => self.api_list_notes(vault_index, stream),
            ("GET", "/api/backlinks") => self.api_backlinks(vault_index, stream, path_raw),
            ("POST", "/api/image") => {
                self.api_upload_image(vault_index, stream, headers, raw_buf, header_len)
            }
            ("GET", "/api/revisions") => self.api_list_revisions(vault_index, stream, path_raw),
            ("GET", "/api/revision") => self.api_get_revision(vault_index, stream, path_raw),
            ("POST", "/api/restore") => self.api_restore_revision(vault_index, stream, path_raw),
            ("GET", "/api/state") => self.api_get_state(vault_index, stream),
            ("PUT", "/api/state") => {
                self.api_put_state(vault_index, stream, headers, raw_buf, header_len)
            }
            ("GET", "/api/settings") => self.api_get_settings(vault_index, stream),
            ("PUT", "/api/settings") => {
                self.api_put_settings(vault_index, stream, headers, raw_buf, header_len)
            }
            ("GET", "/api/filesearch") => self.api_filesearch(vault_index, stream, path_raw),
            ("GET", "/api/recentfiles") => self.api_recent_files(vault_index, stream),
            ("GET", "/api/pinned") => self.api_get_pinned(vault_index, stream),
            ("POST", "/api/pin") => self.api_pin(vault_index, stream, headers, raw_buf, header_len),
            ("DELETE", "/api/pin") => {
                self.api_unpin(vault_index, stream, headers, raw_buf, header_len)
            }
            ("GET", "/api/lock") => self.api_lock(vault_index, stream),
            ("POST", "/api/prf/register") => {
                self.api_prf_register(vault_index, stream, headers, raw_buf, header_len)
            }
            ("POST", "/api/prf/remove") => {
                self.api_prf_remove(vault_index, stream, headers, raw_buf, header_len)
            }
            ("GET", "/api/vaults") => self.api_get_vaults(vault_index, stream),
            _ if method == "POST"
                && path.starts_with("/api/vaults/")
                && path.ends_with("/activate") =>
            {
                let idx_str = &path["/api/vaults/".len()..path.len() - "/activate".len()];
                match idx_str.parse::<usize>() {
                    Ok(n) => self.api_activate_vault(stream, n),
                    Err(_) => write_error(stream, 400, "Bad vault index"),
                }
            }
            _ => write_error(stream, 404, "Not Found"),
        }
    }

    #[cfg(not(feature = "embed"))]
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

    fn handle_sse(&self, vault_index: usize, stream: &mut TcpStream) -> io::Result<()> {
        let header = "HTTP/1.1 200 OK\r\n\
                      Content-Type: text/event-stream\r\n\
                      Cache-Control: no-store\r\n\
                      Connection: keep-alive\r\n\
                      \r\n";
        stream.write_all(header.as_bytes())?;
        stream.write_all(b"event: connected\ndata: ok\n\n")?;
        self.sse_clients.lock().unwrap().push(SseClient {
            stream: stream.try_clone()?,
            vault_index,
        });
        Ok(())
    }

    fn api_status(&self, vault_index: usize, sock: &TcpStream) -> io::Result<()> {
        let locked = self.is_locked(vault_index);
        let needs_setup =
            self.vaults[vault_index].encrypted && self.vaults[vault_index].crypto_config.is_none();
        // Credential IDs are needed for WebAuthn allowCredentials (must be public)
        let prf_ids: Vec<String> = self.vaults[vault_index]
            .crypto_config
            .as_ref()
            .map(|c| c.prf_credentials.iter().map(|p| p.id.clone()).collect())
            .unwrap_or_default();
        // Credential names leak device info — only send when unlocked
        let prf_names: Vec<String> = if !locked {
            self.vaults[vault_index]
                .crypto_config
                .as_ref()
                .map(|c| c.prf_credentials.iter().map(|p| p.name.clone()).collect())
                .unwrap_or_default()
        } else {
            vec![]
        };
        respond_json(
            sock,
            &AppStatus {
                locked,
                encrypted: self.vaults[vault_index].encrypted,
                needs_setup,
                prf_credential_ids: prf_ids,
                prf_credential_names: prf_names,
            },
        )
    }

    fn api_unlock(
        &mut self,
        vault_index: usize,
        sock: &mut TcpStream,
        headers: &[httparse::Header<'_>],
        raw_buf: &[u8],
        header_len: usize,
    ) -> io::Result<()> {
        if !self.is_locked(vault_index) {
            return write_error(sock, 400, "Not locked");
        }
        let config = match &self.vaults[vault_index].crypto_config {
            Some(c) => c,
            None => return write_error(sock, 500, "No crypto config"),
        };

        let req: UnlockRequest = parse_body(sock, headers, raw_buf, header_len)?;

        let master = if let Some(rk_str) = req.recovery_key.as_deref() {
            let recovery = match crypto::parse_recovery_key(rk_str) {
                Ok(r) => r,
                Err(_) => return write_error(sock, 403, "Unlock failed"),
            };
            match config.unlock_with_recovery_key(&recovery) {
                Ok(k) => k,
                Err(_) => return write_error(sock, 403, "Unlock failed"),
            }
        } else if let Some(prf_b64) = req.prf_key.as_deref() {
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

        self.vaults[vault_index].vault = Some(Vault::new(master));
        let token_hex = self.create_session(vault_index);
        let session_cookie = format!(
            "{}={token_hex}; HttpOnly; SameSite=Strict; Path=/",
            session_cookie_name(vault_index)
        );
        self.reindex_with_vault(vault_index);

        let json = serde_json::to_string(&OkResponse { ok: true })
            .map_err(|e| io::Error::other(e.to_string()))?;
        write_json_with_cookies(sock, &json, &[&session_cookie])
    }

    fn api_lock(&mut self, vault_index: usize, sock: &TcpStream) -> io::Result<()> {
        if self.vaults[vault_index].encrypted {
            self.lock_vault(vault_index);
        }
        respond_json(sock, &OkResponse { ok: true })
    }

    fn api_prf_register(
        &mut self,
        vault_index: usize,
        sock: &mut TcpStream,
        headers: &[httparse::Header<'_>],
        raw_buf: &[u8],
        header_len: usize,
    ) -> io::Result<()> {
        let vault = match &self.vaults[vault_index].vault {
            Some(v) => v,
            None => return write_error(sock, 403, "Locked"),
        };

        let req: PrfRegisterRequest = parse_body(sock, headers, raw_buf, header_len)?;

        let prf_bytes =
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &req.prf_key)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

        let kek = crypto::kek_from_prf(&prf_bytes);
        let wrapped = vault.wrap_master_key(&kek);

        let dir = self.vaults[vault_index].dir.clone();
        let config = match &mut self.vaults[vault_index].crypto_config {
            Some(c) => c,
            None => return write_error(sock, 500, "No crypto config"),
        };

        config.prf_credentials.push(crypto::PrfCredential {
            id: req.credential_id,
            name: req.name,
            created: timestamp_now(),
            wrapped_key: (&wrapped).into(),
        });
        config.save(&dir)?;

        respond_json(sock, &OkResponse { ok: true })
    }

    fn api_prf_remove(
        &mut self,
        vault_index: usize,
        sock: &mut TcpStream,
        headers: &[httparse::Header<'_>],
        raw_buf: &[u8],
        header_len: usize,
    ) -> io::Result<()> {
        if self.vaults[vault_index].vault.is_none() {
            return write_error(sock, 403, "Locked");
        }

        let req: PrfRemoveRequest = parse_body(sock, headers, raw_buf, header_len)?;

        let dir = self.vaults[vault_index].dir.clone();
        let config = match &mut self.vaults[vault_index].crypto_config {
            Some(c) => c,
            None => return write_error(sock, 500, "No crypto config"),
        };

        config.prf_credentials.retain(|c| c.id != req.credential_id);
        config.save(&dir)?;

        respond_json(sock, &OkResponse { ok: true })
    }

    fn api_search(&self, vault_index: usize, sock: &TcpStream, path_raw: &str) -> io::Result<()> {
        let q = query_param(path_raw, "q").unwrap_or_default();
        if q.is_empty() {
            return write_json(sock, "[]");
        }
        let filter_path = query_param(path_raw, "path");
        let s = &self.vaults[vault_index].settings;
        let results = self.vaults[vault_index].index.search(
            &q,
            s.result_limit,
            filter_path.as_deref(),
            s.fuzzy_distance,
            s.recency_boost,
            s.weights(),
            s.show_score_breakdown,
        );
        let hits: Vec<SearchHit> = results
            .iter()
            .map(|r| SearchHit {
                path: r.path.clone(),
                title: r.title.clone(),
                tags: r.tags.clone(),
                excerpt: r.excerpt.clone(),
                score: r.score,
                field_scores: FieldScores {
                    title: r.field_scores.title,
                    headings: r.field_scores.headings,
                    tags: r.field_scores.tags,
                    content: r.field_scores.content,
                },
            })
            .collect();
        respond_json(sock, &hits)
    }

    fn api_get_note(&self, vault_index: usize, sock: &TcpStream, path_raw: &str) -> io::Result<()> {
        let Some(rel) = query_param(path_raw, "path") else {
            return write_error(sock, 400, "missing path param");
        };
        let Some((rel, full)) = self.resolve_vault_path(vault_index, &rel) else {
            return write_error(sock, 403, "Forbidden");
        };
        if !full.is_file() {
            return write_error(sock, 404, "Not Found");
        }
        let content = self.read_content(vault_index, &full)?;
        let mtime = mtime_secs(&full);
        let tags = frontmatter::split_tags(&content).tags;
        let title = scanner::official_title(&rel, &content);
        respond_json(
            sock,
            &NoteResponse {
                content,
                mtime,
                tags,
                title,
            },
        )
    }

    fn api_get_tags(&self, vault_index: usize, sock: &TcpStream, path_raw: &str) -> io::Result<()> {
        let tags = if let Some(path) = query_param(path_raw, "path") {
            let Some((_, full)) = self.resolve_vault_path(vault_index, &path) else {
                return write_error(sock, 403, "Forbidden");
            };
            if !full.is_file() {
                return write_error(sock, 404, "Not Found");
            }
            let content = self.read_content(vault_index, &full)?;
            frontmatter::split_tags(&content).tags
        } else {
            let mut set = std::collections::BTreeSet::new();
            for note in self.vaults[vault_index].index.get_all_notes() {
                set.extend(note.tags);
            }
            set.into_iter().collect()
        };
        respond_json(sock, &TagListResponse { tags })
    }

    fn api_put_note(
        &mut self,
        vault_index: usize,
        stream: &mut TcpStream,
        path_raw: &str,
        headers: &[httparse::Header<'_>],
        raw_buf: &[u8],
        header_len: usize,
    ) -> io::Result<()> {
        let Some(rel) = query_param(path_raw, "path") else {
            return write_error(stream, 400, "missing path param");
        };
        let Some((rel, full)) = self.resolve_vault_path(vault_index, &rel) else {
            return write_error(stream, 403, "Forbidden");
        };

        let req: PutNoteRequest = parse_body(stream, headers, raw_buf, header_len)?;
        let current_mtime = mtime_secs(&full);

        if req.expected_mtime != 0 && current_mtime != req.expected_mtime {
            let current_content = self.read_content(vault_index, &full).unwrap_or_default();
            return respond_json_status(
                stream,
                409,
                "Conflict",
                &SaveResult {
                    mtime: current_mtime,
                    path: None,
                    title: None,
                    updated: None,
                    conflict: Some(true),
                    content: Some(current_content),
                },
            );
        }

        let current_content = self.read_content(vault_index, &full).unwrap_or_default();
        let title = scanner::official_title(&rel, &req.content);
        let desired_rel = if scanner::scan(&req.content).title.is_empty() {
            rel.clone()
        } else {
            Self::rel_for_title(&rel, &title)
        };

        if current_content == req.content && desired_rel == rel {
            return respond_json(
                stream,
                &SaveResult {
                    mtime: current_mtime,
                    path: Some(rel.clone()),
                    title: Some(title),
                    updated: Some(Vec::new()),
                    conflict: None,
                    content: None,
                },
            );
        }

        revisions::save_revision(&self.vaults[vault_index].dir, &rel, &full);
        let (saved_rel, saved_full) = if desired_rel == rel {
            self.write_content(vault_index, &full, req.content.as_bytes())?;
            (rel.clone(), full.clone())
        } else {
            let (saved_rel, saved_full) =
                self.create_at_available_path(vault_index, &desired_rel, &title, &req.content)?;
            self.remove_content_file(vault_index, &full)?;
            self.vaults[vault_index].index.remove_note(&rel);
            self.vaults[vault_index].file_index.remove_file(&rel);
            revisions::migrate_revisions(&self.vaults[vault_index].dir, &rel, &saved_rel);
            self.update_pinned_path(vault_index, &rel, &saved_rel);
            (saved_rel, saved_full)
        };

        self.reindex_note_and_file(vault_index, &saved_rel, &req.content, &saved_full);
        let updated = if saved_rel == rel {
            Vec::new()
        } else {
            self.update_backlinks(vault_index, &rel, &saved_rel)
        };

        respond_json(
            stream,
            &SaveResult {
                mtime: mtime_secs(&saved_full),
                path: Some(saved_rel),
                title: Some(title),
                updated: Some(updated),
                conflict: None,
                content: None,
            },
        )
    }

    fn api_create_note(
        &mut self,
        vault_index: usize,
        stream: &mut TcpStream,
        path_raw: &str,
        headers: &[httparse::Header<'_>],
        raw_buf: &[u8],
        header_len: usize,
    ) -> io::Result<()> {
        let Some(rel) = query_param(path_raw, "path") else {
            return write_error(stream, 400, "missing path param");
        };
        let Some((rel, _requested_full)) = self.resolve_vault_path(vault_index, &rel) else {
            return write_error(stream, 403, "Forbidden");
        };

        let body = read_body(stream, headers, raw_buf, header_len)?;
        let raw_content = if body.is_empty() {
            String::new()
        } else {
            let req: CreateNoteRequest =
                serde_json::from_slice(&body).map_err(|e| io::Error::other(e.to_string()))?;
            req.content
        };
        let title = scanner::title_from_path(&rel);
        let content = scanner::upsert_title_h1(&raw_content, &title);
        let desired_rel = Self::rel_for_title(&rel, &title);
        let (saved_rel, saved_full) =
            self.create_at_available_path(vault_index, &desired_rel, &title, &content)?;

        self.reindex_note_and_file(vault_index, &saved_rel, &content, &saved_full);

        respond_json_status(
            stream,
            201,
            "Created",
            &SaveResult {
                mtime: mtime_secs(&saved_full),
                path: Some(saved_rel),
                title: Some(scanner::official_title(&desired_rel, &content)),
                updated: Some(Vec::new()),
                conflict: None,
                content: None,
            },
        )
    }

    fn api_delete_note(
        &mut self,
        vault_index: usize,
        sock: &TcpStream,
        path_raw: &str,
    ) -> io::Result<()> {
        let Some(rel) = query_param(path_raw, "path") else {
            return write_error(sock, 400, "missing path param");
        };
        let Some((rel, full)) = self.resolve_vault_path(vault_index, &rel) else {
            return write_error(sock, 403, "Forbidden");
        };

        revisions::save_revision(&self.vaults[vault_index].dir, &rel, &full);
        self.mark_self_write(vault_index, &full);
        fs::remove_file(&full)?;
        self.vaults[vault_index].index.remove_note(&rel);
        self.vaults[vault_index].file_index.remove_file(&rel);

        // Remove from pinned list if present
        let mut pinned = self.load_pinned(vault_index);
        let before = pinned.len();
        pinned.retain(|p| p != &rel);
        if pinned.len() != before {
            let _ = self.save_pinned(vault_index, &pinned);
        }

        respond_json(sock, &OkResponse { ok: true })
    }

    fn api_rename(
        &mut self,
        vault_index: usize,
        stream: &mut TcpStream,
        headers: &[httparse::Header<'_>],
        raw_buf: &[u8],
        header_len: usize,
    ) -> io::Result<()> {
        let req: RenameRequest = parse_body(stream, headers, raw_buf, header_len)?;

        let requested_title = scanner::title_from_path(&req.new_path);
        let Some((old_rel, old_full)) = self.resolve_vault_path(vault_index, &req.old_path) else {
            return write_error(stream, 403, "Forbidden");
        };
        let desired_rel = Self::rel_for_title(&req.new_path, &requested_title);
        let Some((desired_rel, _)) = self.resolve_vault_path(vault_index, &desired_rel) else {
            return write_error(stream, 403, "Forbidden");
        };
        if !old_full.exists() {
            return write_error(stream, 404, "source not found");
        }

        revisions::save_revision(&self.vaults[vault_index].dir, &old_rel, &old_full);
        let old_content = self.read_content(vault_index, &old_full)?;
        let new_content = scanner::upsert_title_h1(&old_content, &requested_title);

        let (saved_rel, saved_full) = if desired_rel == old_rel {
            self.write_content(vault_index, &old_full, new_content.as_bytes())?;
            (old_rel.clone(), old_full.clone())
        } else {
            let (saved_rel, saved_full) = self.create_at_available_path(
                vault_index,
                &desired_rel,
                &requested_title,
                &new_content,
            )?;
            self.remove_content_file(vault_index, &old_full)?;
            (saved_rel, saved_full)
        };

        self.vaults[vault_index].index.remove_note(&old_rel);
        self.vaults[vault_index].file_index.remove_file(&old_rel);
        self.reindex_note_and_file(vault_index, &saved_rel, &new_content, &saved_full);
        if saved_rel != old_rel {
            revisions::migrate_revisions(&self.vaults[vault_index].dir, &old_rel, &saved_rel);
            self.update_pinned_path(vault_index, &old_rel, &saved_rel);
        }
        let updated = self.update_backlinks(vault_index, &old_rel, &saved_rel);
        let title = scanner::official_title(&saved_rel, &new_content);

        respond_json(
            stream,
            &RenameResponse {
                path: saved_rel,
                title,
                updated,
            },
        )
    }

    fn api_list_notes(&self, vault_index: usize, sock: &TcpStream) -> io::Result<()> {
        let notes = self.vaults[vault_index].index.get_all_notes();
        let entries: Vec<NoteEntry> = notes
            .iter()
            .map(|n| NoteEntry {
                path: n.path.clone(),
                title: n.title.clone(),
                tags: n.tags.clone(),
            })
            .collect();
        respond_json(sock, &entries)
    }

    fn api_backlinks(
        &self,
        vault_index: usize,
        sock: &TcpStream,
        path_raw: &str,
    ) -> io::Result<()> {
        let Some(rel) = query_param(path_raw, "path") else {
            return write_error(sock, 400, "missing path param");
        };
        let stem = Path::new(&rel)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&rel);
        let links = self.vaults[vault_index].index.get_backlinks(stem);
        respond_json(sock, &links)
    }

    fn api_upload_image(
        &mut self,
        vault_index: usize,
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

        let images_dir = self.vaults[vault_index].dir.join("z-images");
        fs::create_dir_all(&images_dir)?;

        let base_filename = Path::new(suggested)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("image.webp")
            .to_string();
        let mut filename = base_filename.clone();
        let mut dest = images_dir.join(&filename);
        let mut counter = 1u32;
        while dest.exists() {
            let stem = Path::new(&base_filename)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("image");
            let ext = Path::new(&base_filename)
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("webp");
            filename = format!("{stem}-{counter}.{ext}");
            dest = images_dir.join(&filename);
            counter += 1;
        }

        self.write_content_raw(vault_index, &dest, &body)?;

        respond_json_status(
            stream,
            201,
            "Created",
            &FilenameResponse {
                filename: filename.clone(),
            },
        )
    }

    fn api_list_revisions(
        &self,
        vault_index: usize,
        sock: &TcpStream,
        path_raw: &str,
    ) -> io::Result<()> {
        let Some(rel) = query_param(path_raw, "path") else {
            return write_error(sock, 400, "missing path param");
        };
        let Some((rel, _)) = self.resolve_vault_path(vault_index, &rel) else {
            return write_error(sock, 403, "Forbidden");
        };
        let revs = revisions::list_revisions(&self.vaults[vault_index].dir, &rel);
        respond_json(sock, &revs)
    }

    fn api_get_revision(
        &self,
        vault_index: usize,
        sock: &TcpStream,
        path_raw: &str,
    ) -> io::Result<()> {
        let Some(rel) = query_param(path_raw, "path") else {
            return write_error(sock, 400, "missing path param");
        };
        let Some(ts_str) = query_param(path_raw, "ts") else {
            return write_error(sock, 400, "missing ts param");
        };
        let ts: u64 = ts_str.parse().map_err(|_| io::Error::other("bad ts"))?;
        let Some((rel, _)) = self.resolve_vault_path(vault_index, &rel) else {
            return write_error(sock, 403, "Forbidden");
        };

        match revisions::get_revision(
            &self.vaults[vault_index].dir,
            &rel,
            ts,
            self.vaults[vault_index].vault.as_ref(),
        ) {
            Some(content) => respond_json(sock, &ContentResponse { content }),
            None => write_error(sock, 404, "revision not found"),
        }
    }

    fn api_get_state(&self, vault_index: usize, sock: &TcpStream) -> io::Result<()> {
        let path = self.vaults[vault_index].dir.join(".tansu/state.json");
        match fs::read_to_string(&path) {
            Ok(json) => write_body(sock, "application/json", json.as_bytes()),
            Err(_) => write_json(sock, "{}"),
        }
    }

    fn api_put_state(
        &self,
        vault_index: usize,
        stream: &mut TcpStream,
        headers: &[httparse::Header<'_>],
        raw_buf: &[u8],
        header_len: usize,
    ) -> io::Result<()> {
        let body = read_body(stream, headers, raw_buf, header_len)?;
        // Validate it matches the session state shape we persist.
        let _: SessionStateJson =
            serde_json::from_slice(&body).map_err(|e| io::Error::other(e.to_string()))?;
        let path = self.vaults[vault_index].dir.join(".tansu/state.json");
        fs::write(&path, &body)?;
        respond_json(stream, &OkResponse { ok: true })
    }

    fn api_get_settings(&self, vault_index: usize, sock: &TcpStream) -> io::Result<()> {
        respond_json(sock, &self.vaults[vault_index].settings)
    }

    fn api_put_settings(
        &mut self,
        vault_index: usize,
        stream: &mut TcpStream,
        headers: &[httparse::Header<'_>],
        raw_buf: &[u8],
        header_len: usize,
    ) -> io::Result<()> {
        let new_settings: Settings = parse_body(stream, headers, raw_buf, header_len)?;
        let needs_reindex =
            new_settings.excluded_folders != self.vaults[vault_index].settings.excluded_folders;
        new_settings.save(&self.vaults[vault_index].dir)?;
        self.vaults[vault_index].settings = new_settings;
        if needs_reindex {
            if self.vaults[vault_index].vault.is_some() {
                // Encrypted mode: reindex synchronously using vault
                self.reindex_with_vault(vault_index);
            } else {
                spawn_plaintext_reindex(
                    self.vaults[vault_index].name.clone(),
                    self.vaults[vault_index].dir.clone(),
                    self.vaults[vault_index].index.clone(),
                    self.vaults[vault_index].file_index.clone(),
                    self.vaults[vault_index].settings.excluded_folders.clone(),
                );
            }
        }
        respond_json(stream, &OkResponse { ok: true })
    }

    fn api_restore_revision(
        &mut self,
        vault_index: usize,
        sock: &TcpStream,
        path_raw: &str,
    ) -> io::Result<()> {
        let Some(rel) = query_param(path_raw, "path") else {
            return write_error(sock, 400, "missing path param");
        };
        let Some(ts_str) = query_param(path_raw, "ts") else {
            return write_error(sock, 400, "missing ts param");
        };
        let ts: u64 = ts_str.parse().map_err(|_| io::Error::other("bad ts"))?;

        let Some((rel, full)) = self.resolve_vault_path(vault_index, &rel) else {
            return write_error(sock, 403, "Forbidden");
        };

        let Some(rev_content) = revisions::get_revision(
            &self.vaults[vault_index].dir,
            &rel,
            ts,
            self.vaults[vault_index].vault.as_ref(),
        ) else {
            return write_error(sock, 404, "revision not found");
        };

        revisions::save_revision(&self.vaults[vault_index].dir, &rel, &full);
        self.write_content(vault_index, &full, rev_content.as_bytes())?;
        self.reindex_note_and_file(vault_index, &rel, &rev_content, &full);
        let title = scanner::official_title(&rel, &rev_content);

        respond_json(
            sock,
            &SaveResult {
                mtime: mtime_secs(&full),
                path: Some(rel),
                title: Some(title),
                updated: Some(Vec::new()),
                conflict: None,
                content: None,
            },
        )
    }

    fn api_filesearch(
        &self,
        vault_index: usize,
        sock: &TcpStream,
        path_raw: &str,
    ) -> io::Result<()> {
        let q = query_param(path_raw, "q").unwrap_or_default();
        if q.is_empty() {
            return write_json(sock, "[]");
        }
        let results = self.vaults[vault_index].file_index.search_names(&q, 30);
        let hits: Vec<FileSearchResult> = results
            .iter()
            .map(|r| FileSearchResult {
                path: r.path.clone(),
                title: r.title.clone(),
            })
            .collect();
        respond_json(sock, &hits)
    }

    fn api_recent_files(&self, vault_index: usize, sock: &TcpStream) -> io::Result<()> {
        let results = self.vaults[vault_index].file_index.recent(50);
        let entries: Vec<RecentFileEntry> = results
            .iter()
            .map(|r| RecentFileEntry {
                path: r.path.clone(),
                title: r.title.clone(),
                mtime: r.mtime,
            })
            .collect();
        respond_json(sock, &entries)
    }

    fn pinned_path(&self, vault_index: usize) -> PathBuf {
        self.vaults[vault_index].dir.join(".tansu/pinned.json")
    }

    fn load_pinned(&self, vault_index: usize) -> Vec<String> {
        match fs::read_to_string(self.pinned_path(vault_index)) {
            Ok(json) => serde_json::from_str::<Vec<String>>(&json).unwrap_or_default(),
            Err(_) => Vec::new(),
        }
    }

    fn save_pinned(&self, vault_index: usize, paths: &[String]) -> io::Result<()> {
        let json = serde_json::to_string(paths).map_err(|e| io::Error::other(e.to_string()))?;
        fs::write(self.pinned_path(vault_index), json)
    }

    fn api_get_pinned(&self, vault_index: usize, sock: &TcpStream) -> io::Result<()> {
        let paths = self.load_pinned(vault_index);
        let entries: Vec<PinnedFileEntry> = paths
            .iter()
            .map(|p| {
                let title = self.vaults[vault_index]
                    .file_index
                    .lookup_path(p)
                    .unwrap_or_else(|| {
                        Path::new(p)
                            .file_stem()
                            .and_then(|s| s.to_str())
                            .unwrap_or(p)
                            .to_string()
                    });
                PinnedFileEntry {
                    path: p.clone(),
                    title,
                }
            })
            .collect();
        respond_json(sock, &entries)
    }

    fn api_pin(
        &self,
        vault_index: usize,
        stream: &mut TcpStream,
        headers: &[httparse::Header<'_>],
        raw_buf: &[u8],
        header_len: usize,
    ) -> io::Result<()> {
        let req: PinRequest = parse_body(stream, headers, raw_buf, header_len)?;
        let mut paths = self.load_pinned(vault_index);
        if !paths.contains(&req.path) {
            paths.push(req.path);
            self.save_pinned(vault_index, &paths)?;
        }
        respond_json(stream, &OkResponse { ok: true })
    }

    fn api_unpin(
        &self,
        vault_index: usize,
        stream: &mut TcpStream,
        headers: &[httparse::Header<'_>],
        raw_buf: &[u8],
        header_len: usize,
    ) -> io::Result<()> {
        let req: PinRequest = parse_body(stream, headers, raw_buf, header_len)?;
        let mut paths = self.load_pinned(vault_index);
        let before = paths.len();
        paths.retain(|p| p != &req.path);
        if paths.len() != before {
            self.save_pinned(vault_index, &paths)?;
        }
        respond_json(stream, &OkResponse { ok: true })
    }

    fn api_get_vaults(&self, active_vault_index: usize, sock: &TcpStream) -> io::Result<()> {
        let vaults: Vec<VaultEntry> = self
            .vaults
            .iter()
            .enumerate()
            .map(|(i, vs)| VaultEntry {
                index: i,
                name: vs.name.clone(),
                active: i == active_vault_index,
                encrypted: vs.encrypted,
                locked: vs.encrypted && vs.vault.is_none(),
            })
            .collect();
        respond_json(sock, &vaults)
    }

    fn api_activate_vault(&mut self, sock: &TcpStream, n: usize) -> io::Result<()> {
        if n >= self.vaults.len() {
            return write_error(sock, 400, "Bad vault index");
        }
        respond_json(sock, &OkResponse { ok: true })
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

fn expand_tilde(s: &str) -> PathBuf {
    if let Some(rest) = s.strip_prefix("~/") {
        if let Some(home) = env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    } else if s == "~"
        && let Some(home) = env::var_os("HOME")
    {
        return PathBuf::from(home);
    }
    PathBuf::from(s)
}

fn config_path() -> PathBuf {
    let base = env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(|| PathBuf::from(".config"));
    base.join("tansu/config.toml")
}

/// Returns (name, canonicalized_dir) pairs in config file order.
fn load_vault_configs(config_path: &Path) -> Vec<(String, PathBuf)> {
    let src = match fs::read_to_string(config_path) {
        Ok(s) => s,
        Err(e) => die(&format!(
            "cannot read {}: {e}\n\
             Create ~/.config/tansu/config.toml with:\n\n\
             \x20 [vault.myvault]\n\
             \x20 dir = \"~/notes\"",
            config_path.display()
        )),
    };
    let value: toml::Value = match toml::from_str(&src) {
        Ok(v) => v,
        Err(e) => die(&format!("parse {}: {e}", config_path.display())),
    };
    let table = match value.get("vault").and_then(|v| v.as_table()) {
        Some(t) => t,
        None => die("config.toml must contain at least one [vault.*] entry"),
    };
    table
        .iter()
        .map(|(name, v)| {
            let dir_str = v
                .get("dir")
                .and_then(|d| d.as_str())
                .unwrap_or_else(|| die(&format!("vault.{name}: missing 'dir'")));
            let expanded = expand_tilde(dir_str);
            let dir = match fs::canonicalize(&expanded) {
                Ok(p) if p.is_dir() => p,
                Ok(_) => die(&format!(
                    "vault.{name}: not a directory: {}",
                    expanded.display()
                )),
                Err(e) => die(&format!("vault.{name}: {e}")),
            };
            (name.clone(), dir)
        })
        .collect()
}

fn validate_vault_nesting(vaults: &[(String, PathBuf)]) -> Result<(), String> {
    // Pairwise: catches nesting between freshly-configured vaults with no .tansu/ yet.
    for i in 0..vaults.len() {
        for j in 0..vaults.len() {
            if i == j {
                continue;
            }
            let (name_i, dir_i) = &vaults[i];
            let (name_j, dir_j) = &vaults[j];
            if dir_i.starts_with(dir_j) {
                return Err(format!(
                    "vault.{name_i} ({}) is nested inside vault.{name_j} ({})",
                    dir_i.display(),
                    dir_j.display()
                ));
            }
        }
    }
    // Walk-up: catches nesting inside a vault that exists on disk but isn't in the config.
    for (name, dir) in vaults {
        let mut ancestor = dir.parent();
        while let Some(p) = ancestor {
            if p.join(".tansu").is_dir() {
                return Err(format!(
                    "vault.{name} ({}) is nested inside another vault at {}",
                    dir.display(),
                    p.display()
                ));
            }
            ancestor = p.parent();
        }
    }
    Ok(())
}

fn check_vault_nesting(vaults: &[(String, PathBuf)]) {
    if let Err(msg) = validate_vault_nesting(vaults) {
        die(&msg);
    }
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
                    "usage: tansu [options]\n\
                     \n\
                     commands:\n\
                     \x20 encrypt <dir>   encrypt all notes in directory\n\
                     \x20 decrypt <dir>   decrypt all notes in directory\n\
                     \n\
                     options:\n\
                     \x20 -q              quiet; disable request logging\n\
                     \x20 -p port         port to listen on (default: 3000)\n\
                     \x20 -b address      bind address (default: 127.0.0.1)\n\
                     \n\
                     config: ~/.config/tansu/config.toml"
                );
                std::process::exit(0);
            }
            "-V" | "--version" => {
                println!("tansu {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            other => die(&format!("unknown argument: {other}")),
        }
    }

    let cfg = config_path();
    let vault_entries = load_vault_configs(&cfg);

    // Nesting check before touching any vault (fast-fail, no side effects).
    check_vault_nesting(&vault_entries);

    // Initialize VaultState for each vault. Only the first vault gets a live watcher.
    let mut vaults: Vec<VaultState> = Vec::new();

    for (name, dir) in vault_entries {
        let settings = Settings::load(&dir);
        let crypto_config = CryptoConfig::load_if_exists(&dir)
            .unwrap_or_else(|e| die(&format!("vault.{name}: load crypto.json: {e}")));
        let encrypted = crypto_config.is_some();

        let index_dir = dir.join(".tansu/index");
        fs::create_dir_all(&index_dir)
            .unwrap_or_else(|e| die(&format!("vault.{name}: create index dir: {e}")));
        let index = Index::open_or_create(&index_dir)
            .unwrap_or_else(|e| die(&format!("vault.{name}: open index: {e}")));

        let names_dir = dir.join(".tansu/names-index");
        fs::create_dir_all(&names_dir)
            .unwrap_or_else(|e| die(&format!("vault.{name}: create names index dir: {e}")));
        let file_index = FileNameIndex::open_or_create(&names_dir)
            .unwrap_or_else(|e| die(&format!("vault.{name}: open names index: {e}")));

        let self_writes = Arc::new(Mutex::new(HashMap::<PathBuf, Instant>::new()));

        let (watch_tx, watch_rx) = mpsc::channel();
        let watcher = watcher::start_watcher(&dir, watch_tx, self_writes.clone())
            .unwrap_or_else(|e| die(&format!("vault.{name}: start watcher: {e}")));

        // Only reindex at startup in plaintext mode; encrypted mode rebuilds on unlock.
        if !encrypted {
            spawn_plaintext_reindex(
                name.clone(),
                dir.clone(),
                index.clone(),
                file_index.clone(),
                settings.excluded_folders.clone(),
            );
        }

        vaults.push(VaultState {
            name,
            dir,
            encrypted,
            crypto_config,
            vault: None,
            sessions: Vec::new(),
            index,
            file_index,
            settings,
            _watcher: watcher,
            watch_rx,
            self_writes,
        });
    }

    let addr = format!("{bind}:{port}");
    let listener =
        TcpListener::bind(&addr).unwrap_or_else(|e| die(&format!("failed to bind {addr}: {e}")));

    let first = &vaults[0];
    if first.encrypted {
        eprintln!(
            "\ttansu serving {} vault(s), active: {} on http://{addr} (locked)",
            vaults.len(),
            first.name
        );
    } else {
        eprintln!(
            "\ttansu serving {} vault(s), active: {} on http://{addr}",
            vaults.len(),
            first.name
        );
    }

    let mut srv = Server {
        quiet,
        vaults,
        sse_clients: Arc::new(Mutex::new(Vec::new())),
    };

    for stream in listener.incoming() {
        match stream {
            Ok(s) => {
                if let Err(e) = srv.handle(s)
                    && !quiet
                {
                    eprintln!("error: {e}");
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn expand_tilde_bare() {
        let home = env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
        assert_eq!(expand_tilde("~"), home);
    }

    #[test]
    fn expand_tilde_with_path() {
        let home = env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
        assert_eq!(expand_tilde("~/foo/bar"), home.join("foo/bar"));
    }

    #[test]
    fn expand_tilde_absolute() {
        assert_eq!(
            expand_tilde("/absolute/path"),
            PathBuf::from("/absolute/path")
        );
    }

    #[test]
    fn expand_tilde_relative() {
        assert_eq!(
            expand_tilde("relative/path"),
            PathBuf::from("relative/path")
        );
    }

    #[test]
    fn nesting_ok_disjoint() {
        let tmp = std::env::temp_dir();
        let a = tmp.join("tansu-test-a");
        let b = tmp.join("tansu-test-b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        let vaults = vec![("a".to_string(), a.clone()), ("b".to_string(), b.clone())];
        assert!(validate_vault_nesting(&vaults).is_ok());
        fs::remove_dir_all(&a).ok();
        fs::remove_dir_all(&b).ok();
    }

    #[test]
    fn nesting_err_pairwise() {
        let tmp = std::env::temp_dir();
        let outer = tmp.join("tansu-test-outer");
        let inner = outer.join("inner");
        fs::create_dir_all(&inner).unwrap();
        let vaults = vec![
            ("outer".to_string(), outer.clone()),
            ("inner".to_string(), inner.clone()),
        ];
        let err = validate_vault_nesting(&vaults).unwrap_err();
        assert!(
            err.contains("vault.inner") && err.contains("vault.outer"),
            "{err}"
        );
        fs::remove_dir_all(&outer).ok();
    }

    #[test]
    fn nesting_err_walkup() {
        let tmp = std::env::temp_dir();
        let outer = tmp.join("tansu-test-walkup-outer");
        let inner = outer.join("notes");
        let tansu_dir = outer.join(".tansu");
        fs::create_dir_all(&inner).unwrap();
        fs::create_dir_all(&tansu_dir).unwrap();
        let vaults = vec![("notes".to_string(), inner.clone())];
        let err = validate_vault_nesting(&vaults).unwrap_err();
        assert!(
            err.contains("vault.notes") && err.contains("nested inside"),
            "{err}"
        );
        fs::remove_dir_all(&outer).ok();
    }

    #[test]
    fn resolve_path_under_root_normalizes_relative_segments() {
        let root = PathBuf::from("/tmp/tansu-root");
        let (rel, full) = resolve_path_under_root(&root, "notes/../daily/today.md").unwrap();
        assert_eq!(rel, "daily/today.md");
        assert_eq!(full, root.join("daily/today.md"));
    }

    #[test]
    fn resolve_path_under_root_blocks_escape() {
        let root = PathBuf::from("/tmp/tansu-root");
        assert!(resolve_path_under_root(&root, "../outside.md").is_none());
        assert!(resolve_path_under_root(&root, "notes/../../outside.md").is_none());
    }

    #[test]
    fn cookie_value_reads_named_cookie() {
        let headers = [httparse::Header {
            name: "Cookie",
            value: b"theme=light; tansu_vault=2; mode=test",
        }];
        assert_eq!(cookie_value(&headers, "tansu_vault"), Some("2"));
        assert_eq!(cookie_value(&headers, "missing"), None);
    }

    #[test]
    fn requested_vault_index_prefers_header_then_query() {
        let headers = [httparse::Header {
            name: "X-Tansu-Vault",
            value: b"1",
        }];
        assert_eq!(requested_vault_index(&headers, "/api/notes?vault=2", 3), 1);
        assert_eq!(requested_vault_index(&[], "/api/notes?vault=2", 3), 2);
        assert_eq!(requested_vault_index(&[], "/api/notes?vault=9", 3), 0);
        assert_eq!(requested_vault_index(&[], "/api/notes", 3), 0);
    }
}
