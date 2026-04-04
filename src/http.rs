use std::{
    borrow::Cow,
    fs::File,
    io::{self, Read, Write},
    net::TcpStream,
    os::unix::io::AsRawFd,
    path::Path,
};

pub fn percent_decode(s: &str) -> Cow<'_, str> {
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

pub fn mime(path: &Path) -> &'static str {
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

pub fn query_param(path_raw: &str, key: &str) -> Option<String> {
    let query = path_raw.split_once('?')?.1;
    for part in query.split('&') {
        let (k, v) = part.split_once('=').unwrap_or((part, ""));
        if k == key {
            return Some(percent_decode(v).into_owned());
        }
    }
    None
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

pub fn write_headers(
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

pub fn write_error(mut sock: &TcpStream, code: u16, msg: &str) -> io::Result<()> {
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

pub fn write_body(sock: &TcpStream, ct: &str, body: &[u8]) -> io::Result<()> {
    write_headers(sock, 200, "OK", ct, body.len() as u64)?;
    let mut w: &TcpStream = sock;
    w.write_all(body)
}

pub fn write_json(sock: &TcpStream, json: &str) -> io::Result<()> {
    write_body(sock, "application/json", json.as_bytes())
}

/// Serialize a value as JSON and write it as a 200 response.
pub fn respond_json(sock: &TcpStream, value: &impl serde::Serialize) -> io::Result<()> {
    let json = serde_json::to_string(value).map_err(|e| io::Error::other(e.to_string()))?;
    write_json(sock, &json)
}

/// Serialize a value as JSON and write it with a custom status code.
pub fn respond_json_status(
    sock: &TcpStream,
    status: u16,
    reason: &str,
    value: &impl serde::Serialize,
) -> io::Result<()> {
    let json = serde_json::to_string(value).map_err(|e| io::Error::other(e.to_string()))?;
    write_headers(sock, status, reason, "application/json", json.len() as u64)?;
    let mut w: &TcpStream = sock;
    w.write_all(json.as_bytes())
}

/// Deserialize a JSON request body.
pub fn parse_body<T: serde::de::DeserializeOwned>(
    stream: &mut TcpStream,
    headers: &[httparse::Header<'_>],
    buf: &[u8],
    header_len: usize,
) -> io::Result<T> {
    let body = read_body(stream, headers, buf, header_len)?;
    serde_json::from_slice(&body).map_err(|e| io::Error::other(e.to_string()))
}

pub fn serve_file(sock: &TcpStream, path: &Path, len: u64, content_type: &str) -> io::Result<()> {
    let file = File::open(path)?;
    write_headers(sock, 200, "OK", content_type, len)?;
    send_file(&file, sock, len)
}

/// Serve a static file with long-lived cache headers.
pub fn serve_file_cached(
    sock: &TcpStream,
    path: &Path,
    len: u64,
    content_type: &str,
) -> io::Result<()> {
    let file = File::open(path)?;
    let mut hdr = [0u8; 512];
    let n = {
        let mut c = io::Cursor::new(&mut hdr[..]);
        write!(
            c,
            "HTTP/1.1 200 OK\r\n\
             Content-Type: {content_type}\r\n\
             Content-Length: {len}\r\n\
             Cache-Control: public, max-age=3600\r\n\
             Connection: close\r\n\
             \r\n"
        )?;
        c.position() as usize
    };
    let mut w: &TcpStream = sock;
    w.write_all(&hdr[..n])?;
    send_file(&file, sock, len)
}

/// Get Content-Length from headers.
pub fn content_length(headers: &[httparse::Header<'_>]) -> usize {
    headers
        .iter()
        .find(|h| h.name.eq_ignore_ascii_case("Content-Length"))
        .and_then(|h| std::str::from_utf8(h.value).ok())
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

/// Read the request body based on Content-Length header.
/// Returns (body, unconsumed trailing bytes).
pub fn read_body(
    stream: &mut TcpStream,
    headers: &[httparse::Header<'_>],
    buf: &[u8],
    header_len: usize,
) -> io::Result<Vec<u8>> {
    let cl = content_length(headers);

    if cl == 0 {
        return Ok(Vec::new());
    }
    if cl > 10 * 1024 * 1024 {
        return Err(io::Error::other("body too large"));
    }

    let mut body = Vec::with_capacity(cl);
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

/// Normalize a request path into `out`, reusing its allocation across calls.
/// Returns `true` if the result is within `base`, `false` for traversal.
pub fn normalize_into(base: &Path, raw: &str, out: &mut std::path::PathBuf) -> bool {
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

/// Get mtime of a file as unix seconds, returning 0 on any error.
pub fn mtime_secs(path: &Path) -> u64 {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn percent_decode_passthrough() {
        assert_eq!(percent_decode("hello"), "hello");
    }

    #[test]
    fn percent_decode_space() {
        assert_eq!(percent_decode("hello%20world"), "hello world");
    }

    #[test]
    fn percent_decode_utf8() {
        assert_eq!(percent_decode("%C3%A9"), "é");
    }

    #[test]
    fn query_param_found() {
        assert_eq!(query_param("/api?foo=bar&baz=1", "foo"), Some("bar".into()));
    }

    #[test]
    fn query_param_missing() {
        assert_eq!(query_param("/api?foo=bar", "missing"), None);
    }

    #[test]
    fn query_param_decoded() {
        assert_eq!(
            query_param("/api?path=hello%20world", "path"),
            Some("hello world".into())
        );
    }

    #[test]
    fn query_param_no_query() {
        assert_eq!(query_param("/api", "foo"), None);
    }

    #[test]
    fn normalize_into_simple() {
        let base = PathBuf::from("/srv");
        let mut out = PathBuf::new();
        assert!(normalize_into(&base, "/foo/bar", &mut out));
        assert_eq!(out, PathBuf::from("/srv/foo/bar"));
    }

    #[test]
    fn normalize_into_traversal_blocked() {
        let base = PathBuf::from("/srv");
        let mut out = PathBuf::new();
        assert!(!normalize_into(&base, "/../etc/passwd", &mut out));
    }

    #[test]
    fn normalize_into_dots_collapsed() {
        let base = PathBuf::from("/srv");
        let mut out = PathBuf::new();
        assert!(normalize_into(&base, "/./foo/../bar", &mut out));
        assert_eq!(out, PathBuf::from("/srv/bar"));
    }

    #[test]
    fn normalize_into_strips_query() {
        let base = PathBuf::from("/srv");
        let mut out = PathBuf::new();
        assert!(normalize_into(&base, "/foo?q=1", &mut out));
        assert_eq!(out, PathBuf::from("/srv/foo"));
    }

    #[test]
    fn mtime_secs_nonexistent() {
        assert_eq!(mtime_secs(Path::new("/nonexistent/file")), 0);
    }

    #[test]
    fn mtime_secs_real_file() {
        let tmp = std::env::temp_dir().join(format!("tansu_test_mtime_{}", std::process::id()));
        std::fs::write(&tmp, "test").unwrap();
        let mtime = mtime_secs(&tmp);
        assert!(mtime > 0);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn mime_known_types() {
        assert_eq!(mime(Path::new("test.html")), "text/html; charset=utf-8");
        assert_eq!(mime(Path::new("test.css")), "text/css");
        assert_eq!(mime(Path::new("test.js")), "application/javascript");
        assert_eq!(mime(Path::new("test.webp")), "image/webp");
        assert_eq!(mime(Path::new("test.md")), "text/plain; charset=utf-8");
    }

    #[test]
    fn mime_unknown_type() {
        assert_eq!(mime(Path::new("test.xyz")), "application/octet-stream");
    }
}
