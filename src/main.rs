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

use tansu::http::*;
use tansu::index::Index;
use tansu::revisions;
use tansu::settings::Settings;
use tansu::watcher::{self, WatchEvent};

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

struct Server {
    dir: PathBuf,
    quiet: bool,
    index: Index,
    settings: Settings,
    watch_rx: mpsc::Receiver<WatchEvent>,
    self_writes: Arc<Mutex<HashSet<PathBuf>>>,
    sse_client: Arc<Mutex<Option<TcpStream>>>,
}

impl Server {
    fn drain_watch_events(&mut self) {
        let mut had_events = false;
        while let Ok(event) = self.watch_rx.try_recv() {
            had_events = true;
            match event {
                WatchEvent::Modified(path) | WatchEvent::Created(path) => {
                    if let Ok(content) = fs::read_to_string(&path) {
                        let rel = path.strip_prefix(&self.dir).unwrap_or(&path);
                        let rel_str = rel.to_string_lossy();
                        self.index.index_note(&rel_str, &content, &path);
                        self.broadcast_sse("changed", &rel_str);
                    }
                }
                WatchEvent::Removed(path) => {
                    let rel = path.strip_prefix(&self.dir).unwrap_or(&path);
                    let rel_str = rel.to_string_lossy();
                    self.index.remove_note(&rel_str);
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

    fn atomic_write(&self, path: &Path, content: &[u8]) -> io::Result<()> {
        self.mark_self_write(path);
        let mut tmp = path.as_os_str().to_owned();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        fs::write(&tmp, content)?;
        fs::rename(&tmp, path)?;
        Ok(())
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
            return match fs::metadata(&fp) {
                Ok(m) if m.is_file() => serve_file_cached(stream, &fp, m.len(), mime(&fp)),
                _ => write_error(stream, 404, "Not Found"),
            };
        }

        if path.starts_with("/static/") {
            let decoded = percent_decode(path);
            let static_dir = self.static_dir();
            if !normalize_into(&static_dir, &decoded.replacen("/static/", "/", 1), &mut fp) {
                return write_error(stream, 403, "Forbidden");
            }
            return match fs::metadata(&fp) {
                Ok(m) if m.is_file() => serve_file_cached(stream, &fp, m.len(), mime(&fp)),
                _ => write_error(stream, 404, "Not Found"),
            };
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
        let content = fs::read_to_string(&full)?;
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
            let current_content = fs::read_to_string(&full).unwrap_or_default();
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

        revisions::save_revision(&self.dir, &rel, &full);
        self.atomic_write(&full, req.content.as_bytes())?;
        self.index.index_note(&rel, &req.content, &full);

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

        self.atomic_write(&full, content.as_bytes())?;
        self.index.index_note(&rel, &content, &full);

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
        if let Ok(content) = fs::read_to_string(&new_full) {
            self.index.index_note(&req.new_path, &content, &new_full);
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
            if let Ok(content) = fs::read_to_string(&note_full) {
                let new_content =
                    content.replace(&format!("[[{old_stem}]]"), &format!("[[{new_stem}]]"));
                if new_content != content {
                    revisions::save_revision(&self.dir, note_path, &note_full);
                    if let Err(e) = self.atomic_write(&note_full, new_content.as_bytes()) {
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

        fs::write(&dest, &body)?;

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

        match revisions::get_revision(&self.dir, &rel, ts) {
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
            let index = self.index.clone();
            let dir = self.dir.clone();
            let excluded = self.settings.excluded_folders.clone();
            std::thread::spawn(move || {
                index.full_reindex(&dir, &excluded);
            });
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

        let Some(rev_content) = revisions::get_revision(&self.dir, &rel, ts) else {
            return write_error(sock, 404, "revision not found");
        };

        revisions::save_revision(&self.dir, &rel, &full);
        self.atomic_write(&full, rev_content.as_bytes())?;
        self.index.index_note(&rel, &rev_content, &full);

        respond_json(
            sock,
            &MtimeResponse {
                mtime: mtime_secs(&full),
            },
        )
    }
}

fn die(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(1);
}

fn main() {
    let mut quiet = false;
    let mut port = String::from("3000");
    let mut bind = String::from("127.0.0.1");
    let mut dir = String::new();

    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-q" => quiet = true,
            "-p" | "--port" => port = args.next().unwrap_or_else(|| die("-p requires a value")),
            "-b" | "--bind" => bind = args.next().unwrap_or_else(|| die("-b requires a value")),
            "-h" | "--help" => {
                eprintln!(
                    "usage: tansu [options] <directory>\n\
                     \n\
                     directory    path to notes directory\n\
                     -q           quiet; disable request logging\n\
                     -p port      port to listen on (default: 3000)\n\
                     -b address   bind address (default: 127.0.0.1)"
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

    let index_dir = dir.join(".tansu/index");
    fs::create_dir_all(&index_dir).unwrap_or_else(|e| die(&format!("create index dir: {e}")));
    let index =
        Index::open_or_create(&index_dir).unwrap_or_else(|e| die(&format!("open index: {e}")));

    let index_clone = index.clone();
    let dir_clone = dir.clone();
    let excluded = settings.excluded_folders.clone();
    std::thread::spawn(move || {
        index_clone.full_reindex(&dir_clone, &excluded);
    });

    let self_writes = Arc::new(Mutex::new(HashSet::<PathBuf>::new()));
    let (watch_tx, watch_rx) = mpsc::channel();
    let _watcher = watcher::start_watcher(&dir, watch_tx, self_writes.clone())
        .unwrap_or_else(|e| die(&format!("start watcher: {e}")));

    let addr = format!("{bind}:{port}");
    let listener =
        TcpListener::bind(&addr).unwrap_or_else(|e| die(&format!("failed to bind {addr}: {e}")));

    eprintln!("\ttansu serving {} on http://{addr}", dir.display());

    let mut srv = Server {
        dir,
        quiet,
        index,
        settings,
        watch_rx,
        self_writes,
        sse_client: Arc::new(Mutex::new(None)),
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
