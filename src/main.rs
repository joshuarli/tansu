use std::{
    borrow::Cow,
    env,
    fmt::Write as _,
    fs::{self, File},
    io::{self, Read, Write},
    net::{TcpListener, TcpStream},
    os::unix::io::AsRawFd,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, mpsc},
    time::Instant,
};

mod index;
mod merge;
mod revisions;
mod scanner;
mod strip;
mod watcher;

use index::Index;
use watcher::WatchEvent;

fn percent_decode(s: &str) -> Cow<'_, str> {
    if !s.as_bytes().contains(&b'%') {
        return Cow::Borrowed(s);
    }
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let (Some(h), Some(l)) = (hex_val(b[i + 1]), hex_val(b[i + 2]))
        {
            out.push((h << 4) | l);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    Cow::Owned(
        String::from_utf8(out)
            .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned()),
    )
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Normalize a request path into `out`, reusing its allocation across calls.
/// Returns `true` if the result is within `base`, `false` for traversal.
fn normalize_into(base: &Path, raw: &str, out: &mut PathBuf) -> bool {
    out.as_mut_os_string().clear();
    out.push(base);
    let raw = raw.split('?').next().unwrap_or("/");
    for seg in raw.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            s => out.push(s),
        }
    }
    out.starts_with(base)
}

fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css",
        "js" | "mjs" => "application/javascript",
        "json" => "application/json",
        "xml" => "application/xml",
        "txt" | "md" => "text/plain; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "webp" => "image/webp",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "wav" => "audio/wav",
        "pdf" => "application/pdf",
        "wasm" => "application/wasm",
        "zip" => "application/zip",
        "gz" | "tgz" => "application/gzip",
        _ => "application/octet-stream",
    }
}

fn query_param(path_raw: &str, key: &str) -> Option<String> {
    let query = path_raw.split_once('?')?.1;
    for part in query.split('&') {
        let (k, v) = part.split_once('=').unwrap_or((part, ""));
        if k == key {
            return Some(percent_decode(v).into_owned());
        }
    }
    None
}

fn json_string(s: &str, out: &mut String) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => write!(out, "\\u{:04x}", c as u32).unwrap(),
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(target_os = "macos")]
fn send_file(file: &File, sock: &TcpStream, len: u64) -> io::Result<()> {
    unsafe extern "C" {
        fn sendfile(fd: i32, s: i32, offset: i64, len: *mut i64, hdtr: *mut (), flags: i32) -> i32;
    }
    let mut remaining = len as i64;
    let mut offset: i64 = 0;
    while remaining > 0 {
        let mut chunk = remaining;
        let ret = unsafe {
            sendfile(
                file.as_raw_fd(),
                sock.as_raw_fd(),
                offset,
                &mut chunk,
                std::ptr::null_mut(),
                0,
            )
        };
        if chunk > 0 {
            offset += chunk;
            remaining -= chunk;
        }
        if ret == -1 {
            let e = io::Error::last_os_error();
            if e.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(e);
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn send_file(file: &File, sock: &TcpStream, len: u64) -> io::Result<()> {
    unsafe extern "C" {
        fn sendfile(out_fd: i32, in_fd: i32, offset: *mut i64, count: usize) -> isize;
    }
    let mut offset: i64 = 0;
    let mut remaining = len as usize;
    while remaining > 0 {
        let n = unsafe { sendfile(sock.as_raw_fd(), file.as_raw_fd(), &mut offset, remaining) };
        if n == -1 {
            let e = io::Error::last_os_error();
            if e.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(e);
        }
        remaining -= n as usize;
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn send_file(file: &File, sock: &TcpStream, _len: u64) -> io::Result<()> {
    io::copy(&mut file.try_clone()?, &mut sock.try_clone()?)?;
    Ok(())
}

fn write_headers(
    mut sock: &TcpStream,
    status: u16,
    reason: &str,
    ct: &str,
    cl: u64,
) -> io::Result<()> {
    let mut hdr = [0u8; 512];
    let n = {
        let mut c = io::Cursor::new(&mut hdr[..]);
        write!(
            c,
            "HTTP/1.1 {status} {reason}\r\n\
             Content-Type: {ct}\r\n\
             Content-Length: {cl}\r\n\
             Cache-Control: no-store\r\n\
             Connection: close\r\n\
             \r\n"
        )?;
        c.position() as usize
    };
    sock.write_all(&hdr[..n])
}

fn write_error(mut sock: &TcpStream, code: u16, msg: &str) -> io::Result<()> {
    let mut buf = [0u8; 512];
    let body_len = 4 + msg.len();
    let n = {
        let mut c = io::Cursor::new(&mut buf[..]);
        write!(
            c,
            "HTTP/1.1 {code} {msg}\r\n\
             Content-Type: text/plain\r\n\
             Content-Length: {body_len}\r\n\
             Cache-Control: no-store\r\n\
             Connection: close\r\n\
             \r\n\
             {code} {msg}"
        )?;
        c.position() as usize
    };
    sock.write_all(&buf[..n])
}

fn write_body(sock: &TcpStream, ct: &str, body: &[u8]) -> io::Result<()> {
    write_headers(sock, 200, "OK", ct, body.len() as u64)?;
    let mut w: &TcpStream = sock;
    w.write_all(body)
}

fn write_json(sock: &TcpStream, json: &str) -> io::Result<()> {
    write_body(sock, "application/json", json.as_bytes())
}

fn serve_file(sock: &TcpStream, path: &Path, len: u64, content_type: &str) -> io::Result<()> {
    let file = File::open(path)?;
    write_headers(sock, 200, "OK", content_type, len)?;
    send_file(&file, sock, len)
}

/// Read the request body based on Content-Length header.
fn read_body(stream: &mut TcpStream, headers: &[httparse::Header<'_>], buf: &[u8], header_len: usize) -> io::Result<Vec<u8>> {
    let cl: usize = headers
        .iter()
        .find(|h| h.name.eq_ignore_ascii_case("Content-Length"))
        .and_then(|h| std::str::from_utf8(h.value).ok())
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    if cl == 0 {
        return Ok(Vec::new());
    }
    if cl > 10 * 1024 * 1024 {
        return Err(io::Error::other("body too large"));
    }

    let mut body = Vec::with_capacity(cl);
    // Bytes already read past the header
    let already = &buf[header_len..];
    let already_len = already.len().min(cl);
    body.extend_from_slice(&already[..already_len]);

    while body.len() < cl {
        let mut tmp = [0u8; 8192];
        let n = stream.read(&mut tmp)?;
        if n == 0 {
            break;
        }
        let take = n.min(cl - body.len());
        body.extend_from_slice(&tmp[..take]);
    }
    Ok(body)
}

struct Server {
    dir: PathBuf,
    quiet: bool,
    index: Index,
    watch_rx: mpsc::Receiver<WatchEvent>,
    self_writes: Arc<Mutex<std::collections::HashSet<PathBuf>>>,
    sse_client: Arc<Mutex<Option<TcpStream>>>,
    fp: PathBuf,
    buf: String,
}

impl Server {
    fn drain_watch_events(&mut self) {
        while let Ok(event) = self.watch_rx.try_recv() {
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

    fn handle(&mut self, mut stream: TcpStream) -> io::Result<()> {
        self.drain_watch_events();

        let mut buf = [0u8; 8192];
        let mut pos = 0usize;

        loop {
            if pos == buf.len() {
                return write_error(&stream, 431, "Request Header Fields Too Large");
            }
            let n = stream.read(&mut buf[pos..])?;
            if n == 0 {
                return Ok(());
            }
            pos += n;
            let mut hdrs = [httparse::EMPTY_HEADER; 32];
            let mut req = httparse::Request::new(&mut hdrs);
            match req.parse(&buf[..pos]) {
                Ok(httparse::Status::Complete(header_len)) => {
                    let method = req.method.unwrap_or("");
                    let path_raw = req.path.unwrap_or("/");
                    let start = Instant::now();

                    // Copy header info we need before moving stream
                    let method = method.to_string();
                    let path_raw = path_raw.to_string();

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
                        eprintln!("\t{method} {path_raw} ({:.1}ms)", elapsed.as_secs_f64() * 1000.0);
                    }

                    return result;
                }
                Ok(httparse::Status::Partial) => continue,
                Err(_) => return write_error(&stream, 400, "Bad Request"),
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

        // API routes
        if path.starts_with("/api/") {
            return self.dispatch_api(stream, method, path, path_raw, headers, raw_buf, header_len);
        }

        // SSE endpoint
        if path == "/events" {
            return self.handle_sse(stream);
        }

        // Only GET for non-API routes
        if method != "GET" {
            return write_error(stream, 405, "Method Not Allowed");
        }

        // Serve z-images
        if path.starts_with("/z-images/") {
            let decoded = percent_decode(path);
            if !normalize_into(&self.dir, &decoded, &mut self.fp) {
                return write_error(stream, 403, "Forbidden");
            }
            return match fs::metadata(&self.fp) {
                Ok(m) if m.is_file() => serve_file(stream, &self.fp, m.len(), mime(&self.fp)),
                _ => write_error(stream, 404, "Not Found"),
            };
        }

        // Serve static assets
        if path.starts_with("/static/") {
            let decoded = percent_decode(path);
            // Static files are served from web/static/ relative to the executable
            let static_dir = self.static_dir();
            if !normalize_into(&static_dir, &decoded.replacen("/static/", "/", 1), &mut self.fp) {
                return write_error(stream, 403, "Forbidden");
            }
            return match fs::metadata(&self.fp) {
                Ok(m) if m.is_file() => serve_file(stream, &self.fp, m.len(), mime(&self.fp)),
                _ => write_error(stream, 404, "Not Found"),
            };
        }

        // SPA fallback: serve index.html for everything else
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
            ("PUT", "/api/note") => self.api_put_note(stream, path_raw, headers, raw_buf, header_len),
            ("POST", "/api/note") => self.api_create_note(stream, path_raw, headers, raw_buf, header_len),
            ("DELETE", "/api/note") => self.api_delete_note(stream, path_raw),
            ("POST", "/api/rename") => self.api_rename(stream, headers, raw_buf, header_len),
            ("GET", "/api/notes") => self.api_list_notes(stream),
            ("GET", "/api/backlinks") => self.api_backlinks(stream, path_raw),
            ("POST", "/api/image") => self.api_upload_image(stream, headers, raw_buf, header_len),
            ("GET", "/api/revisions") => self.api_list_revisions(stream, path_raw),
            ("GET", "/api/revision") => self.api_get_revision(stream, path_raw),
            ("POST", "/api/restore") => self.api_restore_revision(stream, path_raw),
            _ => write_error(stream, 404, "Not Found"),
        }
    }

    fn static_dir(&self) -> PathBuf {
        // Look for web/static relative to the executable, falling back to cwd
        let exe = env::current_exe().unwrap_or_default();
        let exe_dir = exe.parent().unwrap_or(Path::new("."));
        for candidate in [
            exe_dir.join("web/static"),
            PathBuf::from("web/static"),
        ] {
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
        // Single client enforcement
        let mut guard = self.sse_client.lock().unwrap();
        if guard.is_some() {
            drop(guard);
            return write_error(stream, 409, "Conflict: another client is connected");
        }

        // Write SSE headers (no Content-Length, keep-alive)
        let header = "HTTP/1.1 200 OK\r\n\
                      Content-Type: text/event-stream\r\n\
                      Cache-Control: no-store\r\n\
                      Connection: keep-alive\r\n\
                      \r\n";
        stream.write_all(header.as_bytes())?;

        // Send initial connected event
        stream.write_all(b"event: connected\ndata: ok\n\n")?;

        // Store a clone for broadcasting
        *guard = Some(stream.try_clone()?);
        // The connection stays open; the main loop will move on to accept the next request.
        // SSE messages are written by broadcast_sse() when watch events occur.
        Ok(())
    }

    // --- API handlers ---

    fn api_search(&mut self, sock: &TcpStream, path_raw: &str) -> io::Result<()> {
        let q = query_param(path_raw, "q").unwrap_or_default();
        if q.is_empty() {
            return write_json(sock, "[]");
        }
        let results = self.index.search(&q, 20);
        self.buf.clear();
        self.buf.push('[');
        for (i, r) in results.iter().enumerate() {
            if i > 0 {
                self.buf.push(',');
            }
            self.buf.push('{');
            self.buf.push_str("\"path\":");
            json_string(&r.path, &mut self.buf);
            self.buf.push_str(",\"title\":");
            json_string(&r.title, &mut self.buf);
            self.buf.push_str(",\"excerpt\":");
            json_string(&r.excerpt, &mut self.buf);
            write!(self.buf, ",\"score\":{:.4}", r.score).unwrap();
            self.buf.push('}');
        }
        self.buf.push(']');
        write_json(sock, &self.buf)
    }

    fn api_get_note(&mut self, sock: &TcpStream, path_raw: &str) -> io::Result<()> {
        let Some(rel) = query_param(path_raw, "path") else {
            return write_error(sock, 400, "missing path param");
        };
        let full = self.dir.join(&rel);
        if !full.starts_with(&self.dir) {
            return write_error(sock, 403, "Forbidden");
        }
        let meta = match fs::metadata(&full) {
            Ok(m) => m,
            Err(_) => return write_error(sock, 404, "Not Found"),
        };
        let content = fs::read_to_string(&full)?;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        self.buf.clear();
        self.buf.push_str("{\"content\":");
        json_string(&content, &mut self.buf);
        write!(self.buf, ",\"mtime\":{mtime}}}").unwrap();
        write_json(sock, &self.buf)
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

        let body = read_body(stream, headers, raw_buf, header_len)?;
        let json: serde_json::Value = serde_json::from_slice(&body)
            .map_err(|_| io::Error::other("invalid json"))?;
        let content = json["content"].as_str().ok_or_else(|| io::Error::other("missing content"))?;
        let expected_mtime = json["expected_mtime"].as_u64().unwrap_or(0);

        // mtime conflict check
        let current_mtime = fs::metadata(&full)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        if expected_mtime != 0 && current_mtime != expected_mtime {
            // Conflict: return current content
            let current_content = fs::read_to_string(&full).unwrap_or_default();
            self.buf.clear();
            self.buf.push_str("{\"conflict\":true,\"content\":");
            json_string(&current_content, &mut self.buf);
            write!(self.buf, ",\"mtime\":{current_mtime}}}").unwrap();

            write_headers(stream, 409, "Conflict", "application/json", self.buf.len() as u64)?;
            let mut w: &TcpStream = stream;
            return w.write_all(self.buf.as_bytes());
        }

        // Save revision before overwriting
        revisions::save_revision(&self.dir, &rel, &full);

        // Atomic write
        self.atomic_write(&full, content.as_bytes())?;

        // Re-index
        self.index.index_note(&rel, content, &full);

        let new_mtime = fs::metadata(&full)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        self.buf.clear();
        write!(self.buf, "{{\"mtime\":{new_mtime}}}").unwrap();
        write_json(stream, &self.buf)
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

        // Ensure parent directory exists
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent)?;
        }

        let body = read_body(stream, headers, raw_buf, header_len)?;
        let content = if body.is_empty() {
            String::new()
        } else {
            let json: serde_json::Value = serde_json::from_slice(&body)
                .map_err(|_| io::Error::other("invalid json"))?;
            json["content"].as_str().unwrap_or("").to_string()
        };

        self.atomic_write(&full, content.as_bytes())?;
        self.index.index_note(&rel, &content, &full);

        let mtime = fs::metadata(&full)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        self.buf.clear();
        write!(self.buf, "{{\"mtime\":{mtime}}}").unwrap();

        write_headers(stream, 201, "Created", "application/json", self.buf.len() as u64)?;
        let mut w: &TcpStream = stream;
        w.write_all(self.buf.as_bytes())
    }

    fn api_delete_note(&mut self, sock: &TcpStream, path_raw: &str) -> io::Result<()> {
        let Some(rel) = query_param(path_raw, "path") else {
            return write_error(sock, 400, "missing path param");
        };
        let full = self.dir.join(&rel);
        if !full.starts_with(&self.dir) {
            return write_error(sock, 403, "Forbidden");
        }

        // Save final revision before deleting
        revisions::save_revision(&self.dir, &rel, &full);

        // Mark as self-write so watcher ignores the delete
        self.self_writes.lock().unwrap().insert(full.clone());

        fs::remove_file(&full)?;
        self.index.remove_note(&rel);

        write_json(sock, "{\"ok\":true}")
    }

    fn api_rename(
        &mut self,
        stream: &mut TcpStream,
        headers: &[httparse::Header<'_>],
        raw_buf: &[u8],
        header_len: usize,
    ) -> io::Result<()> {
        let body = read_body(stream, headers, raw_buf, header_len)?;
        let json: serde_json::Value = serde_json::from_slice(&body)
            .map_err(|_| io::Error::other("invalid json"))?;
        let old_path = json["old_path"].as_str().ok_or_else(|| io::Error::other("missing old_path"))?;
        let new_path = json["new_path"].as_str().ok_or_else(|| io::Error::other("missing new_path"))?;

        let old_full = self.dir.join(old_path);
        let new_full = self.dir.join(new_path);
        if !old_full.starts_with(&self.dir) || !new_full.starts_with(&self.dir) {
            return write_error(stream, 403, "Forbidden");
        }

        if !old_full.exists() {
            return write_error(stream, 404, "source not found");
        }
        if new_full.exists() {
            return write_error(stream, 409, "target already exists");
        }

        // Save revision of old path
        revisions::save_revision(&self.dir, old_path, &old_full);

        // Ensure target directory exists
        if let Some(parent) = new_full.parent() {
            fs::create_dir_all(parent)?;
        }

        // Mark as self-writes
        {
            let mut sw = self.self_writes.lock().unwrap();
            sw.insert(old_full.clone());
            sw.insert(new_full.clone());
        }

        // Rename the file
        fs::rename(&old_full, &new_full)?;

        // Update index
        self.index.remove_note(old_path);
        if let Ok(content) = fs::read_to_string(&new_full) {
            self.index.index_note(new_path, &content, &new_full);
        }

        // Find and update all notes that link to the old name
        let old_stem = Path::new(old_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(old_path);
        let new_stem = Path::new(new_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(new_path);

        let mut updated = Vec::new();
        let referencing = self.index.get_backlinks(old_stem);
        for note_path in &referencing {
            let note_full = self.dir.join(note_path);
            if let Ok(content) = fs::read_to_string(&note_full) {
                let new_content = content.replace(
                    &format!("[[{old_stem}]]"),
                    &format!("[[{new_stem}]]"),
                );
                if new_content != content {
                    revisions::save_revision(&self.dir, note_path, &note_full);
                    self.self_writes.lock().unwrap().insert(note_full.clone());
                    let _ = self.atomic_write(&note_full, new_content.as_bytes());
                    self.index.index_note(note_path, &new_content, &note_full);
                    updated.push(note_path.clone());
                }
            }
        }

        // Return updated files list
        self.buf.clear();
        self.buf.push_str("{\"updated\":[");
        for (i, p) in updated.iter().enumerate() {
            if i > 0 {
                self.buf.push(',');
            }
            json_string(p, &mut self.buf);
        }
        self.buf.push_str("]}");
        write_json(stream, &self.buf)
    }

    fn api_list_notes(&mut self, sock: &TcpStream) -> io::Result<()> {
        let notes = self.index.get_all_notes();
        self.buf.clear();
        self.buf.push('[');
        for (i, (path, title)) in notes.iter().enumerate() {
            if i > 0 {
                self.buf.push(',');
            }
            self.buf.push_str("{\"path\":");
            json_string(path, &mut self.buf);
            self.buf.push_str(",\"title\":");
            json_string(title, &mut self.buf);
            self.buf.push('}');
        }
        self.buf.push(']');
        write_json(sock, &self.buf)
    }

    fn api_backlinks(&mut self, sock: &TcpStream, path_raw: &str) -> io::Result<()> {
        let Some(rel) = query_param(path_raw, "path") else {
            return write_error(sock, 400, "missing path param");
        };
        let stem = Path::new(&rel)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&rel);
        let links = self.index.get_backlinks(stem);
        self.buf.clear();
        self.buf.push('[');
        for (i, p) in links.iter().enumerate() {
            if i > 0 {
                self.buf.push(',');
            }
            json_string(p, &mut self.buf);
        }
        self.buf.push(']');
        write_json(sock, &self.buf)
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

        // Get suggested filename from header or generate one
        let suggested = headers
            .iter()
            .find(|h| h.name.eq_ignore_ascii_case("X-Filename"))
            .and_then(|h| std::str::from_utf8(h.value).ok())
            .unwrap_or("image.webp");

        let images_dir = self.dir.join("z-images");
        fs::create_dir_all(&images_dir)?;

        // Deduplicate filename
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

        self.buf.clear();
        self.buf.push_str("{\"filename\":");
        json_string(&filename, &mut self.buf);
        self.buf.push('}');

        write_headers(stream, 201, "Created", "application/json", self.buf.len() as u64)?;
        let mut w: &TcpStream = stream;
        w.write_all(self.buf.as_bytes())
    }

    fn api_list_revisions(&mut self, sock: &TcpStream, path_raw: &str) -> io::Result<()> {
        let Some(rel) = query_param(path_raw, "path") else {
            return write_error(sock, 400, "missing path param");
        };
        let revs = revisions::list_revisions(&self.dir, &rel);
        self.buf.clear();
        self.buf.push('[');
        for (i, ts) in revs.iter().enumerate() {
            if i > 0 {
                self.buf.push(',');
            }
            write!(self.buf, "{ts}").unwrap();
        }
        self.buf.push(']');
        write_json(sock, &self.buf)
    }

    fn api_get_revision(&mut self, sock: &TcpStream, path_raw: &str) -> io::Result<()> {
        let Some(rel) = query_param(path_raw, "path") else {
            return write_error(sock, 400, "missing path param");
        };
        let Some(ts_str) = query_param(path_raw, "ts") else {
            return write_error(sock, 400, "missing ts param");
        };
        let ts: u64 = ts_str.parse().map_err(|_| io::Error::other("bad ts"))?;

        match revisions::get_revision(&self.dir, &rel, ts) {
            Some(content) => {
                self.buf.clear();
                self.buf.push_str("{\"content\":");
                json_string(&content, &mut self.buf);
                self.buf.push('}');
                write_json(sock, &self.buf)
            }
            None => write_error(sock, 404, "revision not found"),
        }
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

        // Save current state as a revision before restoring
        revisions::save_revision(&self.dir, &rel, &full);

        // Write the restored content
        self.self_writes.lock().unwrap().insert(full.clone());
        self.atomic_write(&full, rev_content.as_bytes())?;
        self.index.index_note(&rel, &rev_content, &full);

        let mtime = fs::metadata(&full)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        self.buf.clear();
        write!(self.buf, "{{\"mtime\":{mtime}}}").unwrap();
        write_json(sock, &self.buf)
    }

    /// Write content atomically: write to .tmp sibling, then rename.
    fn atomic_write(&self, path: &Path, content: &[u8]) -> io::Result<()> {
        // Mark as self-write BEFORE writing so watcher ignores the event
        self.self_writes.lock().unwrap().insert(path.to_path_buf());
        let mut tmp = path.as_os_str().to_owned();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        fs::write(&tmp, content)?;
        fs::rename(&tmp, path)?;
        Ok(())
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

    // Initialize tantivy index
    let index_dir = dir.join(".tansu/index");
    fs::create_dir_all(&index_dir).unwrap_or_else(|e| die(&format!("create index dir: {e}")));
    let index = Index::open_or_create(&index_dir)
        .unwrap_or_else(|e| die(&format!("open index: {e}")));

    // Start background indexer
    let index_clone = index.clone();
    let dir_clone = dir.clone();
    std::thread::spawn(move || {
        index_clone.full_reindex(&dir_clone);
    });

    // Start file watcher
    let self_writes = Arc::new(Mutex::new(std::collections::HashSet::<PathBuf>::new()));
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
        watch_rx,
        self_writes,
        sse_client: Arc::new(Mutex::new(None)),
        fp: PathBuf::new(),
        buf: String::new(),
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
