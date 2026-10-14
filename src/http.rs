use std::convert::Infallible;
use std::future::Future;
use std::io;
use std::net::TcpListener;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use http_body_util::{BodyExt, Full, combinators::BoxBody};
use hyper::body::{Bytes, Frame, Incoming};
use hyper::header::{CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE, COOKIE, HOST, ORIGIN};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{HeaderMap, Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener as TokioTcpListener;
use tokio::sync::{Semaphore, mpsc, watch};
use tokio::task::JoinSet;
use tokio::time::{Instant as TokioInstant, timeout};

use crate::api::{api_error_response, handle_api};
use crate::app::App;
use crate::auth::{
    AuthError, AuthPolicy, AuthRequestContext, AuthStore, RequestAction, SessionLease,
    SessionRequirement,
};
use crate::embedded_assets;
use crate::logging::{IncomingLogBatch, LogLevel, fields};
use tansu_webauthn::{AuthenticationResponse, RegistrationResponse, RelyingParty};
use crate::{Error, Result};

const MAX_HEADER_BYTES: usize = 1024 * 1024;
const MAX_HEADER_COUNT: usize = 64;
const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;
const MAX_CONNECTIONS: usize = 64;
const MAX_BLOCKING_REQUESTS: usize = 8;
const MAX_REQUEST_BODY_DURATION: Duration = Duration::from_secs(10);
const MAX_CONNECTION_DURATION: Duration = Duration::from_secs(600);
const MAX_SSE_REPLAY_EVENTS: usize = 512;
const MAX_SSE_REPLAY_BYTES: usize = 2 * 1024 * 1024;
const MAX_SSE_EVENT_BYTES: usize = 128 * 1024;
const MAX_SSE_SOURCE_QUEUE: usize = 64;
const SSE_BODY_QUEUE: usize = 4;

type HttpBody = BoxBody<Bytes, Infallible>;

#[derive(Debug, Clone)]
pub struct HttpRequest {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[derive(Debug)]
pub struct HttpResponse {
    status: u16,
    content_type: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl HttpResponse {
    pub fn json<T: Serialize>(status: u16, value: &T) -> std::result::Result<Self, serde_json::Error> {
        Ok(Self {
            status,
            content_type: "application/json; charset=utf-8".to_string(),
            headers: Vec::new(),
            body: serde_json::to_vec(value)?,
        })
    }

    pub fn text(status: u16, text: &str) -> Self {
        Self {
            status,
            content_type: "text/plain; charset=utf-8".to_string(),
            headers: Vec::new(),
            body: text.as_bytes().to_vec(),
        }
    }

    pub fn bytes(status: u16, content_type: &str, body: Vec<u8>) -> Self {
        Self {
            status,
            content_type: content_type.to_string(),
            headers: Vec::new(),
            body,
        }
    }

    fn with_header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_string(), value.to_string()));
        self
    }

    fn with_no_store(self) -> Self {
        self.with_header("Cache-Control", "no-store")
    }

    fn into_hyper(self) -> Response<HttpBody> {
        let mut builder = Response::builder()
            .status(StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
            .header(CONTENT_TYPE, self.content_type)
            .header("X-Content-Type-Options", "nosniff")
            .header("Referrer-Policy", "no-referrer")
            .header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
            .header(
                "Content-Security-Policy",
                "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
            );
        for (name, value) in self.headers {
            builder = builder.header(name, value);
        }
        builder.body(Full::new(Bytes::from(self.body)).boxed()).expect("valid fixed response")
    }

    #[cfg(test)]
    pub(crate) fn status(&self) -> u16 {
        self.status
    }

    #[cfg(test)]
    pub(crate) fn content_type(&self) -> &str {
        &self.content_type
    }

    #[cfg(test)]
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(header_name, _)| header_name.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    #[cfg(test)]
    pub(crate) fn body(&self) -> &[u8] {
        &self.body
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventEnvelope {
    pub event_version: u64,
    pub payload: serde_json::Value,
}

pub struct EventSubscription {
    pub replay: Vec<EventEnvelope>,
    pub current_version: u64,
    pub resync_required: bool,
    pub events: Box<dyn EventSubscriptionStream>,
}

pub trait EventSubscriptionStream: Send + 'static {
    fn capacity(&self) -> usize;
    fn recv_timeout(
        &mut self,
        timeout: Duration,
    ) -> std::result::Result<EventEnvelope, std::sync::mpsc::RecvTimeoutError>;
}

#[derive(Clone)]
pub struct StreamAuthorization {
    pub expires_at: u64,
    revoked: watch::Receiver<bool>,
    _lease: SessionLease,
}

pub trait EventSource: Send + Sync + 'static {
    fn subscribe(
        &self,
        vault_id: &str,
        after_event_version: Option<u64>,
    ) -> std::result::Result<EventSubscription, String>;
}

#[derive(Clone, Default)]
pub struct ServerServices {
    pub auth: Option<Arc<AuthStore>>,
    pub events: Option<Arc<dyn EventSource>>,
}

#[derive(Clone, Copy)]
struct TransportLimits {
    max_body_bytes: usize,
    max_connections: usize,
    max_blocking_requests: usize,
    request_body_duration: Duration,
    connection_duration: Duration,
}

impl Default for TransportLimits {
    fn default() -> Self {
        Self {
            max_body_bytes: MAX_BODY_BYTES,
            max_connections: MAX_CONNECTIONS,
            max_blocking_requests: MAX_BLOCKING_REQUESTS,
            request_body_duration: MAX_REQUEST_BODY_DURATION,
            connection_duration: MAX_CONNECTION_DURATION,
        }
    }
}

#[derive(Clone)]
struct ServerState {
    app: App,
    services: ServerServices,
    blocking_requests: Arc<Semaphore>,
    shutdown: watch::Receiver<bool>,
    limits: TransportLimits,
}

struct RequestAuthorization {
    stream: Option<StreamAuthorization>,
    session_cookie: Option<String>,
}

enum BodyError {
    TooLarge,
    TimedOut,
    Malformed,
}

pub fn serve(app: App, port: u16) -> Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    log_listen(&app, port);
    serve_listener(app, listener)
}

pub fn serve_with_services(app: App, port: u16, services: ServerServices) -> Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    log_listen(&app, port);
    serve_until_signal(app, listener, services)
}

pub fn serve_listener(app: App, listener: TcpListener) -> Result<()> {
    serve_until_signal(app, listener, ServerServices::default())
}

fn serve_until_signal(app: App, listener: TcpListener, services: ServerServices) -> Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build()
        .map_err(|error| Error::Internal(error.to_string()))?;
    let (shutdown_sender, shutdown) = watch::channel(false);
    runtime.block_on(async move {
        let server = serve_listener_with_shutdown(app, listener, services, shutdown);
        tokio::pin!(server);
        tokio::select! {
            result = &mut server => result,
            signal = shutdown_signal() => {
                signal.map_err(|error| Error::Internal(error.to_string()))?;
                let _ = shutdown_sender.send(true);
                server.await
            }
        }
    })
}

async fn shutdown_signal() -> io::Result<()> {
    #[cfg(unix)]
    {
        let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result,
            _ = terminate.recv() => Ok(()),
        }
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c().await
    }
}

pub async fn serve_listener_with_shutdown(
    app: App,
    listener: TcpListener,
    services: ServerServices,
    shutdown: watch::Receiver<bool>,
) -> Result<()> {
    serve_listener_with_limits(app, listener, services, shutdown, TransportLimits::default()).await
}

async fn serve_listener_with_limits(
    app: App,
    listener: TcpListener,
    services: ServerServices,
    mut shutdown: watch::Receiver<bool>,
    limits: TransportLimits,
) -> Result<()> {
    listener.set_nonblocking(true)?;
    let listener = TokioTcpListener::from_std(listener)?;
    let state = ServerState {
        app,
        services,
        blocking_requests: Arc::new(Semaphore::new(limits.max_blocking_requests)),
        shutdown: shutdown.clone(),
        limits,
    };
    let connection_slots = Arc::new(Semaphore::new(limits.max_connections));
    let mut connections = JoinSet::new();

    loop {
        tokio::select! {
            accept_result = listener.accept() => {
                let (stream, _) = accept_result?;
                let Ok(slot) = connection_slots.clone().try_acquire_owned() else {
                    let mut stream = stream;
                    let _ = write_overloaded(&mut stream).await;
                    continue;
                };
                let state = state.clone();
                let shutdown = shutdown.clone();
                connections.spawn(async move {
                    let _slot = slot;
                    handle_connection(stream, state, shutdown).await;
                });
            }
            _ = wait_for_shutdown(&mut shutdown) => break,
            Some(result) = connections.join_next(), if !connections.is_empty() => {
                result.map_err(|error| Error::Internal(format!("connection task failed: {error}")))?;
            }
        }
    }

    while let Some(result) = connections.join_next().await {
        result.map_err(|error| Error::Internal(format!("connection task failed: {error}")))?;
    }
    Ok(())
}

fn log_listen(app: &App, port: u16) {
    if app.logs().enabled() {
        app.logs().server_event(
            LogLevel::Info,
            "system.event",
            None,
            fields([
                ("system", serde_json::json!({ "component": "startup", "action": "listen" })),
                ("address", serde_json::json!(format!("127.0.0.1:{port}"))),
            ]),
        );
    }
}

async fn handle_connection(
    stream: tokio::net::TcpStream,
    state: ServerState,
    mut shutdown: watch::Receiver<bool>,
) {
    let duration = state.limits.connection_duration;
    let io = TokioIo::new(stream);
    let service = service_fn(move |request| {
        let state = state.clone();
        async move { Ok::<_, Infallible>(handle_request(request, state).await) }
    });
    let mut http1 = http1::Builder::new();
    http1.max_buf_size(MAX_HEADER_BYTES);
    http1.max_headers(MAX_HEADER_COUNT);
    http1.keep_alive(false);
    let connection = http1.serve_connection(io, service);
    tokio::pin!(connection);
    tokio::select! {
        _ = wait_for_shutdown(&mut shutdown) => {}
        _ = timeout(duration, &mut connection) => {}
    }
}

async fn wait_for_shutdown(shutdown: &mut watch::Receiver<bool>) {
    loop {
        if *shutdown.borrow_and_update() || shutdown.changed().await.is_err() {
            return;
        }
    }
}

async fn write_overloaded(stream: &mut tokio::net::TcpStream) -> io::Result<()> {
    use tokio::io::AsyncWriteExt;
    stream.write_all(
        b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n\r\n",
    ).await
}

async fn handle_request(request: Request<Incoming>, state: ServerState) -> Response<HttpBody> {
    let (parts, body) = request.into_parts();
    let path = parts.uri.to_string();
    let request_headers = parts.headers.clone();
    let Some(access) = authorize_request(&parts.method, &parts.uri, &request_headers, &state.services) else {
        return HttpResponse::text(401, "unauthorized").with_no_store().into_hyper();
    };

    if let Some(vault_id) = event_vault_id(&parts.uri) {
        if parts.method != Method::GET {
            return HttpResponse::text(405, "method not allowed").with_no_store().into_hyper();
        }
        return event_response(&request_headers, vault_id, access, &state).await;
    }

    if parts.uri.path().starts_with("/api/v2/auth/") {
        let Some(auth) = &state.services.auth else {
            return HttpResponse::text(404, "not found").with_no_store().into_hyper();
        };
        return handle_auth_route(&parts.method, &parts.uri, &request_headers, body, auth.clone(), access.session_cookie.as_deref(), state).await;
    }

    let is_api = path.starts_with("/api/");
    if !is_api {
        return serve_static(&parts.uri).unwrap_or_else(|error| {
            if matches!(error, Error::NotFound(_)) {
                HttpResponse::text(404, "not found")
            } else {
                HttpResponse::text(500, &error.to_string())
            }
        }).into_hyper();
    }

    let Ok(worker_slot) = state.blocking_requests.clone().try_acquire_owned() else {
        return HttpResponse::text(503, "server busy").with_no_store().into_hyper();
    };
    let body = match collect_body(body, &request_headers, state.limits).await {
        Ok(body) => body,
        Err(BodyError::TooLarge) => return HttpResponse::text(413, "request body too large").with_no_store().into_hyper(),
        Err(BodyError::TimedOut) => return HttpResponse::text(408, "request body timed out").with_no_store().into_hyper(),
        Err(BodyError::Malformed) => return HttpResponse::text(400, "invalid request body").with_no_store().into_hyper(),
    };
    let request = HttpRequest {
        method: parts.method.to_string(),
        path,
        headers: request_headers.iter().map(|(name, value)| {
            (name.as_str().to_string(), String::from_utf8_lossy(value.as_bytes()).to_string())
        }).collect(),
        body,
    };
    let app = state.app.clone();
    let started = Instant::now();
    let result = tokio::task::spawn_blocking(move || {
        let _worker_slot = worker_slot;
        let request_id = request_id(&request);
        let response = route(&app, &request);
        log_request(&app, &request, &response, request_id, started.elapsed().as_millis());
        response.with_no_store()
    }).await;
    match result {
        Ok(response) => response.into_hyper(),
        Err(error) => HttpResponse::text(500, &format!("request worker failed: {error}")).with_no_store().into_hyper(),
    }
}

async fn collect_body(
    mut body: Incoming,
    headers: &HeaderMap,
    limits: TransportLimits,
) -> std::result::Result<Vec<u8>, BodyError> {
    let content_lengths = headers.get_all(CONTENT_LENGTH).iter().collect::<Vec<_>>();
    if content_lengths.len() > 1 {
        return Err(BodyError::Malformed);
    }
    if let Some(content_length) = content_lengths.first() {
        let content_length = content_length.to_str().map_err(|_| BodyError::Malformed)?
            .parse::<usize>().map_err(|_| BodyError::Malformed)?;
        if content_length > limits.max_body_bytes {
            return Err(BodyError::TooLarge);
        }
    }
    timeout(limits.request_body_duration, async move {
        let mut bytes = Vec::new();
        while let Some(frame) = body.frame().await {
            let frame = frame.map_err(|_| BodyError::Malformed)?;
            if let Ok(data) = frame.into_data() {
                if bytes.len().saturating_add(data.len()) > limits.max_body_bytes {
                    return Err(BodyError::TooLarge);
                }
                bytes.extend_from_slice(&data);
            }
        }
        Ok(bytes)
    }).await.map_err(|_| BodyError::TimedOut)?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistrationStart {
    capability: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CeremonyFinish<T> {
    ceremony_id: String,
    credential: T,
}

async fn handle_auth_route(
    method: &Method,
    uri: &hyper::Uri,
    headers: &HeaderMap,
    body: Incoming,
    auth: Arc<AuthStore>,
    session_cookie: Option<&str>,
    state: ServerState,
) -> Response<HttpBody> {
    let Ok(worker_slot) = state.blocking_requests.clone().try_acquire_owned() else {
        return HttpResponse::text(503, "server busy").with_no_store().into_hyper();
    };
    let body = match collect_body(body, headers, state.limits).await {
        Ok(body) => body,
        Err(BodyError::TooLarge) => return HttpResponse::text(413, "request body too large").with_no_store().into_hyper(),
        Err(BodyError::TimedOut) => return HttpResponse::text(408, "request body timed out").with_no_store().into_hyper(),
        Err(BodyError::Malformed) => return HttpResponse::text(400, "invalid request body").with_no_store().into_hyper(),
    };
    let method = method.to_string();
    let path = uri.path().to_string();
    let session_cookie = session_cookie.map(str::to_string);
    match tokio::task::spawn_blocking(move || {
        let _worker_slot = worker_slot;
        handle_auth_route_sync(&method, &path, &body, &auth, session_cookie.as_deref())
    }).await {
        Ok(response) => response.with_no_store().into_hyper(),
        Err(error) => HttpResponse::text(500, &format!("authentication worker failed: {error}")).with_no_store().into_hyper(),
    }
}

fn handle_auth_route_sync(
    method: &str,
    path: &str,
    body: &[u8],
    auth: &AuthStore,
    session_cookie: Option<&str>,
) -> HttpResponse {
    if method == "GET" && path == "/api/v2/auth/status" {
        return HttpResponse::json(200, &serde_json::json!({ "authenticated": session_cookie.is_some() }))
            .unwrap_or_else(|error| HttpResponse::text(500, &error.to_string()));
    }
    let Some((rp_id, origin, rp_name)) = auth.policy().rp() else {
        return auth_error(AuthError::InvalidRequest("passkeys are disabled in loopback development mode".into()));
    };
    let rp = RelyingParty::new(rp_id, origin, rp_name);
    match (method, path) {
        ("POST", "/api/v2/auth/enrollment/options") => {
            let start: RegistrationStart = match serde_json::from_slice(body) {
                Ok(start) => start,
                Err(error) => return auth_error(AuthError::InvalidRequest(error.to_string())),
            };
            let (options, state) = match rp.start_registration("tansu2-owner-v1", "Tansu Owner") {
                Ok(options) => options,
                Err(error) => return auth_error(AuthError::WebAuthn(error.to_string())),
            };
            let now = match unix_time_seconds() {
                Ok(now) => now,
                Err(error) => return HttpResponse::text(500, &error.to_string()),
            };
            match auth.begin_registration(&state, start.capability.as_deref(), session_cookie, now, 300) {
                Ok(ticket) => HttpResponse::json(200, &serde_json::json!({
                    "ceremonyId": ticket.id,
                    "expiresAt": ticket.expires_at,
                    "publicKey": options,
                })).unwrap_or_else(|error| HttpResponse::text(500, &error.to_string())),
                Err(error) => auth_error(error),
            }
        }
        ("POST", "/api/v2/auth/enrollment/finish") => {
            let finish: CeremonyFinish<RegistrationResponse> = match serde_json::from_slice(body) {
                Ok(finish) => finish,
                Err(error) => return auth_error(AuthError::InvalidRequest(error.to_string())),
            };
            let now = match unix_time_seconds() {
                Ok(now) => now,
                Err(error) => return HttpResponse::text(500, &error.to_string()),
            };
            match auth.finish_registration(&finish.ceremony_id, now, |challenge| {
                rp.finish_registration(&finish.credential, challenge)
                    .map_err(|error| AuthError::WebAuthn(error.to_string()))
            }) {
                Ok(session) => {
                    let csrf = session.as_ref().map(|session| session.csrf_token.as_str());
                    let mut response = HttpResponse::json(200, &serde_json::json!({ "ok": true, "csrfToken": csrf }))
                        .unwrap_or_else(|error| HttpResponse::text(500, &error.to_string()));
                    if let Some(session) = session {
                        response = response.with_header("Set-Cookie", &auth.session_cookie(&session));
                    }
                    response
                }
                Err(error) => auth_error(error),
            }
        }
        ("POST", "/api/v2/auth/login/options") => {
            let credentials = match auth.credentials() {
                Ok(credentials) if !credentials.is_empty() && credentials.len() <= 32 => credentials,
                Ok(_) => return auth_error(AuthError::Unauthorized),
                Err(error) => return auth_error(error),
            };
            let (options, state) = match rp.start_authentication(&credentials, b"tansu2-owner-v1") {
                Ok(options) => options,
                Err(error) => return auth_error(AuthError::WebAuthn(error.to_string())),
            };
            let now = match unix_time_seconds() {
                Ok(now) => now,
                Err(error) => return HttpResponse::text(500, &error.to_string()),
            };
            match auth.begin_authentication(&state, now, 300) {
                Ok(ticket) => HttpResponse::json(200, &serde_json::json!({
                    "ceremonyId": ticket.id,
                    "expiresAt": ticket.expires_at,
                    "publicKey": options,
                })).unwrap_or_else(|error| HttpResponse::text(500, &error.to_string())),
                Err(error) => auth_error(error),
            }
        }
        ("POST", "/api/v2/auth/login/finish") => {
            let finish: CeremonyFinish<AuthenticationResponse> = match serde_json::from_slice(body) {
                Ok(finish) => finish,
                Err(error) => return auth_error(AuthError::InvalidRequest(error.to_string())),
            };
            let now = match unix_time_seconds() {
                Ok(now) => now,
                Err(error) => return HttpResponse::text(500, &error.to_string()),
            };
            match auth.finish_authentication(&finish.ceremony_id, now, |challenge, credentials| {
                let mut last_error = AuthError::Unauthorized;
                for credential in credentials {
                    match rp.finish_authentication(&finish.credential, challenge, credential) {
                        Ok(finish) => return Ok(finish),
                        Err(error) => last_error = AuthError::WebAuthn(error.to_string()),
                    }
                }
                Err(last_error)
            }) {
                Ok(session) => HttpResponse::json(200, &serde_json::json!({ "ok": true, "csrfToken": session.csrf_token }))
                    .unwrap_or_else(|error| HttpResponse::text(500, &error.to_string()))
                    .with_header("Set-Cookie", &auth.session_cookie(&session)),
                Err(error) => auth_error(error),
            }
        }
        ("POST", "/api/v2/auth/logout") => {
            let Some(session_cookie) = session_cookie else { return auth_error(AuthError::Unauthorized); };
            match auth.revoke_session(session_cookie) {
                Ok(()) => HttpResponse::json(200, &serde_json::json!({ "ok": true }))
                    .unwrap_or_else(|error| HttpResponse::text(500, &error.to_string()))
                    .with_header("Set-Cookie", "__Host-tansu_session=; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=0"),
                Err(error) => auth_error(error),
            }
        }
        _ => HttpResponse::text(404, "not found"),
    }
}

fn auth_error(error: AuthError) -> HttpResponse {
    let status = match error {
        AuthError::InvalidRequest(_) | AuthError::WebAuthn(_) => 400,
        AuthError::Unauthorized => 401,
        AuthError::Expired => 410,
        AuthError::CeremonyUsed => 409,
        AuthError::Storage(_) => 500,
    };
    HttpResponse::json(status, &serde_json::json!({ "error": error.to_string() }))
        .unwrap_or_else(|_| HttpResponse::text(500, "authentication error"))
}

fn authorize_request(
    method: &Method,
    uri: &hyper::Uri,
    headers: &HeaderMap,
    services: &ServerServices,
) -> Option<RequestAuthorization> {
    let Some(auth) = &services.auth else {
        return Some(RequestAuthorization { stream: None, session_cookie: None });
    };
    let host = single_header(headers, HOST.as_str()).ok()??;
    let origin = single_header(headers, ORIGIN.as_str()).ok()?;
    let cookie_header = single_header(headers, COOKIE.as_str()).ok()?;
    let session_cookie = match parse_session_cookie(cookie_header) {
        Ok(cookie) => cookie,
        Err(_) => return None,
    };
    let csrf = single_header(headers, "X-Tansu-CSRF").ok()?;
    let state_changing = !matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS);
    let authenticated_mode = matches!(auth.policy(), AuthPolicy::Authenticated { .. });
    let event_stream = event_vault_id(uri).is_some();
    let auth_route = is_public_auth_route(method, uri.path());
    let require_session = authenticated_mode && (uri.path().starts_with("/api/") || event_stream) && !auth_route;
    let now = unix_time_seconds().ok()?;
    let verified = auth.validate_request(AuthRequestContext {
        host,
        origin,
        action: if state_changing { RequestAction::StateChange } else { RequestAction::Read },
        session_cookie: session_cookie.as_deref(),
        csrf_token: csrf,
        session_requirement: if require_session { SessionRequirement::Required } else { SessionRequirement::Optional },
        now,
    }).ok()?;
    let stream = if authenticated_mode && event_stream {
        let cookie = session_cookie.as_deref()?;
        let lease = auth.session_lease(cookie, now).ok()?;
        Some(StreamAuthorization {
            expires_at: lease.expires_at,
            revoked: lease.revoked.clone(),
            _lease: lease,
        })
    } else {
        None
    };
    if require_session && verified.is_none() {
        return None;
    }
    Some(RequestAuthorization { stream, session_cookie })
}

fn single_header<'a>(headers: &'a HeaderMap, name: &'static str) -> std::result::Result<Option<&'a str>, ()> {
    let mut values = headers.get_all(name).iter();
    let value = values.next();
    if values.next().is_some() {
        return Err(());
    }
    value.map(|value| value.to_str().map_err(|_| ())).transpose()
}

fn is_public_auth_route(method: &Method, path: &str) -> bool {
    matches!((method, path),
        (&Method::GET, "/api/v2/auth/status")
        | (&Method::POST, "/api/v2/auth/login/options")
        | (&Method::POST, "/api/v2/auth/login/finish")
        | (&Method::POST, "/api/v2/auth/enrollment/options")
        | (&Method::POST, "/api/v2/auth/enrollment/finish")
    )
}

fn parse_session_cookie(cookie_header: Option<&str>) -> std::result::Result<Option<String>, AuthError> {
    let Some(cookie_header) = cookie_header else { return Ok(None); };
    let mut session = None;
    for part in cookie_header.split(';') {
        let Some((name, value)) = part.trim().split_once('=') else { continue; };
        if name == "__Host-tansu_session" {
            if session.replace(value.to_string()).is_some() {
                return Err(AuthError::Unauthorized);
            }
        }
    }
    Ok(session)
}

fn event_vault_id(uri: &hyper::Uri) -> Option<String> {
    let path = uri.path();
    if path == "/events" {
        return uri.query()?.split('&').find_map(|part| {
            let (key, value) = part.split_once('=')?;
            (key == "vault").then(|| value.to_string())
        });
    }
    let rest = path.strip_prefix("/api/v2/vaults/")?;
    let (vault_id, route) = rest.split_once('/')?;
    (route == "events" && !vault_id.is_empty()).then(|| vault_id.to_string())
}

async fn event_response(
    headers: &HeaderMap,
    vault_id: String,
    authorization: RequestAuthorization,
    state: &ServerState,
) -> Response<HttpBody> {
    let Some(source) = &state.services.events else {
        return HttpResponse::text(404, "events unavailable").with_no_store().into_hyper();
    };
    let last_event_id = match single_header(headers, "Last-Event-ID") {
        Ok(value) => value,
        Err(()) => return HttpResponse::text(400, "invalid Last-Event-ID").with_no_store().into_hyper(),
    };
    let after_event_version = match last_event_id {
        Some(value) => match value.parse::<u64>().ok() {
            Some(version) => Some(version),
            None => return HttpResponse::text(400, "invalid Last-Event-ID").with_no_store().into_hyper(),
        },
        None => None,
    };
    let subscription = match source.subscribe(&vault_id, after_event_version) {
        Ok(subscription) => subscription,
        Err(error) => return HttpResponse::text(500, &error).with_no_store().into_hyper(),
    };
    if subscription.events.capacity() > MAX_SSE_SOURCE_QUEUE {
        return HttpResponse::text(500, "event source queue exceeds transport limit").with_no_store().into_hyper();
    }
    let body = sse_body(subscription, state.shutdown.clone(), authorization.stream, state.limits.connection_duration);
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "text/event-stream; charset=utf-8")
        .header(CACHE_CONTROL, "no-store")
        .header("X-Accel-Buffering", "no")
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
        .body(body)
        .expect("valid SSE response")
}

fn sse_body(
    subscription: EventSubscription,
    shutdown: watch::Receiver<bool>,
    authorization: Option<StreamAuthorization>,
    max_duration: Duration,
) -> HttpBody {
    let EventSubscription {
        mut replay,
        current_version,
        resync_required,
        mut events,
    } = subscription;
    let (event_sender, mut events_receiver) = mpsc::channel::<EventEnvelope>(MAX_SSE_SOURCE_QUEUE);
    let event_bridge = tokio::task::spawn_blocking(move || loop {
        if event_sender.is_closed() {
            return;
        }
        match events.recv_timeout(Duration::from_millis(250)) {
            Ok(event) => {
                if event_sender.blocking_send(event).is_err() {
                    return;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
        }
    });
    let (sender, receiver) = mpsc::channel::<Bytes>(SSE_BODY_QUEUE);
    let event_pump = tokio::spawn(async move {
        let deadline = TokioInstant::now() + max_duration;
        let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
        heartbeat.tick().await;
        let mut replay_bytes = 0_usize;
        let replay_valid = replay.len() <= MAX_SSE_REPLAY_EVENTS
            && replay.iter().all(|event| {
                event.payload.get("eventVersion").and_then(serde_json::Value::as_u64) == Some(event.event_version)
                    && serde_json::to_vec(&event.payload).is_ok_and(|bytes| {
                    replay_bytes = replay_bytes.saturating_add(bytes.len());
                    bytes.len() <= MAX_SSE_EVENT_BYTES && replay_bytes <= MAX_SSE_REPLAY_BYTES
                })
            });
        let mut stop = StreamStop {
            shutdown,
            authorization,
            deadline,
        };
        if resync_required || !replay_valid {
            let _ = send_sse_bytes(&sender, sse_resync_event(current_version), &mut stop).await;
            return;
        }
        for event in replay.drain(..) {
            let Some(bytes) = sse_event_bytes(&event) else {
                let _ = send_sse_bytes(&sender, sse_resync_event(current_version), &mut stop).await;
                return;
            };
            if !send_sse_bytes(&sender, bytes, &mut stop).await {
                return;
            }
        }
        loop {
            tokio::select! {
                _ = sender.closed() => return,
                _ = wait_for_shutdown(&mut stop.shutdown) => return,
                _ = wait_for_authorization_end(stop.authorization.as_ref()) => return,
                _ = tokio::time::sleep_until(stop.deadline) => return,
                _ = heartbeat.tick() => {
                    if sender.try_send(Bytes::from_static(b": keep-alive\n\n")).is_err() {
                        return;
                    }
                }
                event = events_receiver.recv() => {
                    let Some(event) = event else { return; };
                    let Some(bytes) = sse_event_bytes(&event) else {
                        let version = current_version.max(event.event_version);
                        let _ = send_sse_bytes(&sender, sse_resync_event(version), &mut stop).await;
                        return;
                    };
                    if !send_sse_bytes(&sender, bytes, &mut stop).await {
                        return;
                    }
                }
            }
        }
    });
    ChannelBody { receiver, event_pump: Some(event_pump), event_bridge: Some(event_bridge) }.boxed()
}

struct StreamStop {
    shutdown: watch::Receiver<bool>,
    authorization: Option<StreamAuthorization>,
    deadline: TokioInstant,
}

fn sse_event_bytes(event: &EventEnvelope) -> Option<Bytes> {
    if event.payload.get("eventVersion").and_then(serde_json::Value::as_u64) != Some(event.event_version) {
        return None;
    }
    let json = serde_json::to_vec(&event.payload).ok()?;
    if json.len() > MAX_SSE_EVENT_BYTES {
        return None;
    }
    let event_name = if event.payload.get("resyncRequired").and_then(serde_json::Value::as_bool) == Some(true) {
        "resyncRequired"
    } else {
        "message"
    };
    Some(Bytes::from(format!("id: {}\nevent: {event_name}\ndata: {}\n\n", event.event_version, String::from_utf8_lossy(&json))))
}

fn sse_resync_event(event_version: u64) -> Bytes {
    let payload = serde_json::json!({
        "eventVersion": event_version,
        "resyncRequired": true,
        "update": { "kind": "resyncRequired" },
    });
    Bytes::from(format!("id: {event_version}\nevent: resyncRequired\ndata: {payload}\n\n"))
}

async fn send_sse_bytes(sender: &mpsc::Sender<Bytes>, bytes: Bytes, stop: &mut StreamStop) -> bool {
    tokio::select! {
        result = sender.send(bytes) => result.is_ok(),
        _ = sender.closed() => false,
        _ = wait_for_shutdown(&mut stop.shutdown) => false,
        _ = wait_for_authorization_end(stop.authorization.as_ref()) => false,
        _ = tokio::time::sleep_until(stop.deadline) => false,
    }
}

async fn wait_for_authorization_end(authorization: Option<&StreamAuthorization>) {
    let Some(authorization) = authorization else {
        std::future::pending::<()>().await;
        return;
    };
    let now = unix_time_seconds().unwrap_or(u64::MAX);
    let remaining = authorization.expires_at.saturating_sub(now);
    let expiry = tokio::time::sleep(Duration::from_secs(remaining));
    tokio::pin!(expiry);
    let mut revoked = authorization.revoked.clone();
    loop {
        if *revoked.borrow_and_update() {
            return;
        }
        tokio::select! {
            _ = &mut expiry => return,
            changed = revoked.changed() => {
                if changed.is_err() {
                    return;
                }
            }
        }
    }
}

struct ChannelBody {
    receiver: mpsc::Receiver<Bytes>,
    event_pump: Option<tokio::task::JoinHandle<()>>,
    event_bridge: Option<tokio::task::JoinHandle<()>>,
}

impl Drop for ChannelBody {
    fn drop(&mut self) {
        if let Some(event_pump) = &self.event_pump {
            event_pump.abort();
        }
        if let Some(event_bridge) = &self.event_bridge {
            event_bridge.abort();
        }
    }
}

impl hyper::body::Body for ChannelBody {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<std::result::Result<Frame<Self::Data>, Self::Error>>> {
        match self.receiver.poll_recv(context) {
            Poll::Ready(Some(chunk)) => Poll::Ready(Some(Ok(Frame::data(chunk)))),
            Poll::Ready(None) => {
                if let Some(event_pump) = &mut self.event_pump {
                    match Pin::new(event_pump).poll(context) {
                        Poll::Pending => return Poll::Pending,
                        Poll::Ready(result) => {
                            self.event_pump = None;
                            if let Err(error) = result {
                                eprintln!("SSE event task failed: {error}");
                            }
                        }
                    }
                }
                if let Some(event_bridge) = &mut self.event_bridge {
                    match Pin::new(event_bridge).poll(context) {
                        Poll::Pending => return Poll::Pending,
                        Poll::Ready(result) => {
                            self.event_bridge = None;
                            if let Err(error) = result {
                                eprintln!("SSE source task failed: {error}");
                            }
                        }
                    }
                }
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

fn route(app: &App, request: &HttpRequest) -> HttpResponse {
    if request.path.starts_with("/api/dev/logs") {
        return handle_dev_logs(app, request);
    }
    if request.path.starts_with("/api/") {
        return handle_api(app, request).unwrap_or_else(api_error_response);
    }
    serve_static_path(&request.path).unwrap_or_else(|error| {
        if matches!(error, Error::NotFound(_)) {
            HttpResponse::text(404, "not found")
        } else {
            HttpResponse::text(500, &error.to_string())
        }
    })
}

fn handle_dev_logs(app: &App, request: &HttpRequest) -> HttpResponse {
    if !app.logs().enabled() {
        return HttpResponse::text(404, "not found");
    }
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/api/dev/logs") => HttpResponse::json(200, &app.logs().snapshot())
            .unwrap_or_else(|error| HttpResponse::text(500, &format!("internal serialization error: {error}"))),
        ("POST", "/api/dev/logs") => match serde_json::from_slice::<IncomingLogBatch>(&request.body) {
            Ok(batch) => {
                for event in batch.events {
                    app.logs().ingest(event);
                }
                HttpResponse::json(200, &serde_json::json!({ "ok": true }))
                    .unwrap_or_else(|error| HttpResponse::text(500, &format!("internal serialization error: {error}")))
            }
            Err(error) => HttpResponse::text(400, &error.to_string()),
        },
        _ => HttpResponse::text(404, "not found"),
    }
}

fn serve_static(uri: &hyper::Uri) -> Result<HttpResponse> {
    serve_static_path(&uri.to_string())
}

fn serve_static_path(path: &str) -> Result<HttpResponse> {
    let asset = embedded_assets::get(path).ok_or_else(|| Error::NotFound(path.to_string()))?;
    let cache_control = if asset.immutable {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    Ok(HttpResponse::bytes(200, asset.content_type, asset.body.to_vec())
        .with_header("Cache-Control", cache_control))
}

fn log_request(
    app: &App,
    request: &HttpRequest,
    response: &HttpResponse,
    request_id: Option<String>,
    duration_ms: u128,
) {
    if !app.logs().enabled() || request.path.starts_with("/api/dev/logs") {
        return;
    }
    let level = if response.status >= 500 {
        LogLevel::Error
    } else if response.status >= 400 {
        LogLevel::Warn
    } else {
        LogLevel::Info
    };
    app.logs().server_event(
        level,
        "http.request",
        request_id,
        fields([
            (
                "http",
                serde_json::json!({
                    "method": request.method,
                    "path": request.path,
                    "status": response.status,
                    "durationMs": duration_ms,
                    "vault": request_vault(request),
                }),
            ),
            ("error", api_error_field(response)),
        ]),
    );
}

fn request_id(request: &HttpRequest) -> Option<String> {
    request.headers.iter().find(|(name, _)| name.eq_ignore_ascii_case("x-tansu-request-id"))
        .map(|(_, value)| value.clone())
        .or_else(|| Some(format!("srv-{:016x}", fastrand::u64(..))))
}

fn request_vault(request: &HttpRequest) -> Option<usize> {
    request.path.split_once('?').and_then(|(_, query)| {
        query.split('&').find_map(|pair| pair.split_once("vault=")?.1.parse().ok())
    }).or_else(|| {
        request.headers.iter().find(|(name, _)| name.eq_ignore_ascii_case("x-tansu-vault"))
            .and_then(|(_, value)| value.parse().ok())
    })
}

fn api_error_field(response: &HttpResponse) -> serde_json::Value {
    if response.status < 400 || !response.content_type.starts_with("application/json") {
        return serde_json::Value::Null;
    }
    serde_json::from_slice::<serde_json::Value>(&response.body).ok()
        .and_then(|value| value.get("error").cloned())
        .unwrap_or(serde_json::Value::Null)
}

fn unix_time_seconds() -> Result<u64> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)
        .map_err(|error| Error::Internal(error.to_string()))?.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::thread;

    use crate::config::{Config, VaultConfig};

    #[test]
    fn embedded_static_assets_are_fingerprinted_and_confined() {
        let shell = serve_static_path("/").unwrap();
        assert_eq!(shell.status(), 200);
        assert_eq!(shell.content_type(), "text/html; charset=utf-8");
        assert_eq!(shell.header("cache-control"), Some("no-cache"));
        let html = String::from_utf8_lossy(shell.body());
        let js = html.split("src=\"/assets/").nth(1).unwrap().split('"').next().unwrap();
        let css = html.split("href=\"/assets/").nth(1).unwrap().split('"').next().unwrap();
        assert!(js.starts_with("app.") && js.ends_with(".js"));
        assert!(css.starts_with("app.") && css.ends_with(".css"));
        assert_eq!(serve_static_path(&format!("/assets/{js}")).unwrap().header("cache-control"), Some("public, max-age=31536000, immutable"));
        assert!(serve_static_path("/%2e%2e/Cargo.toml").is_err());
        assert!(serve_static_path("/../Cargo.toml").is_err());
    }

    #[test]
    fn response_security_headers_are_restrictive_and_api_no_store() {
        let response = HttpResponse::json(200, &serde_json::json!({ "ok": true })).unwrap().with_no_store();
        let response = response.into_hyper();
        assert_eq!(response.headers()[CACHE_CONTROL], "no-store");
        assert_eq!(response.headers()["X-Content-Type-Options"], "nosniff");
        let csp = response.headers()["Content-Security-Policy"].to_str().unwrap();
        assert!(csp.contains("script-src 'self'"));
        assert!(!csp.contains("'unsafe-eval'"));
    }

    #[test]
    fn parses_session_cookie_once_and_rejects_duplicates() {
        assert_eq!(parse_session_cookie(Some("other=x; __Host-tansu_session=abc" )).unwrap(), Some("abc".into()));
        assert!(parse_session_cookie(Some("__Host-tansu_session=a; __Host-tansu_session=b")).is_err());
    }

    #[test]
    fn rejects_ambiguous_security_headers() {
        let mut headers = HeaderMap::new();
        headers.append(HOST, "notes.example.com".parse().unwrap());
        headers.append(HOST, "evil.example.com".parse().unwrap());
        assert!(single_header(&headers, HOST.as_str()).is_err());
        headers.clear();
        headers.append(ORIGIN, "https://notes.example.com".parse().unwrap());
        headers.append(ORIGIN, "https://evil.example.com".parse().unwrap());
        assert!(single_header(&headers, ORIGIN.as_str()).is_err());
        headers.clear();
        headers.append("Last-Event-ID", "5".parse().unwrap());
        headers.append("Last-Event-ID", "6".parse().unwrap());
        assert!(single_header(&headers, "Last-Event-ID").is_err());
    }

    #[test]
    fn oversized_slow_and_malformed_requests_are_bounded() {
        let root = tempfile::tempdir().unwrap();
        let vault_path = root.path().join("vault");
        let state_path = root.path().join("state");
        std::fs::create_dir_all(&vault_path).unwrap();
        let app = App::new(Config {
            vaults: vec![VaultConfig {
                name: "Test".into(),
                path: vault_path,
                state_path,
                excluded_folders: Vec::new(),
            }],
            auth: None,
        }).unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, shutdown) = watch::channel(false);
        let server = thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            runtime.block_on(serve_listener_with_limits(
                app,
                listener,
                ServerServices::default(),
                shutdown,
                TransportLimits {
                    max_body_bytes: 8,
                    max_connections: 4,
                    max_blocking_requests: 1,
                    request_body_duration: Duration::from_millis(60),
                    connection_duration: Duration::from_secs(2),
                },
            )).unwrap();
        });

        let mut oversized = TcpStream::connect(address).unwrap();
        oversized.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        oversized.write_all(b"POST /api/notes HTTP/1.1\r\nHost: localhost\r\nContent-Length: 9\r\n\r\n").unwrap();
        let mut oversized_response = String::new();
        oversized.read_to_string(&mut oversized_response).unwrap();
        assert!(oversized_response.starts_with("HTTP/1.1 413"));

        let mut slow = TcpStream::connect(address).unwrap();
        slow.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        slow.write_all(b"POST /api/notes HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\na").unwrap();
        let mut slow_response = String::new();
        slow.read_to_string(&mut slow_response).unwrap();
        assert!(slow_response.starts_with("HTTP/1.1 408"));

        let mut malformed = TcpStream::connect(address).unwrap();
        malformed.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        malformed.write_all(b"GET / HTTP/1.1\r\nHost localhost\r\n\r\n").unwrap();
        let mut malformed_response = String::new();
        let _ = malformed.read_to_string(&mut malformed_response);
        assert!(malformed_response.starts_with("HTTP/1.1 400"));

        stop.send(true).unwrap();
        server.join().unwrap();
    }

    #[derive(Clone)]
    struct MockEventSource;

    struct MockEventStream {
        receiver: std::sync::mpsc::Receiver<EventEnvelope>,
        capacity: usize,
        dropped: Option<std::sync::mpsc::Sender<()>>,
    }

    impl EventSubscriptionStream for MockEventStream {
        fn capacity(&self) -> usize {
            self.capacity
        }

        fn recv_timeout(
            &mut self,
            timeout: Duration,
        ) -> std::result::Result<EventEnvelope, std::sync::mpsc::RecvTimeoutError> {
            self.receiver.recv_timeout(timeout)
        }
    }

    impl Drop for MockEventStream {
        fn drop(&mut self) {
            if let Some(dropped) = self.dropped.take() {
                let _ = dropped.send(());
            }
        }
    }

    impl EventSource for MockEventSource {
        fn subscribe(
            &self,
            _: &str,
            _: Option<u64>,
        ) -> std::result::Result<EventSubscription, String> {
            let (_sender, events) = std::sync::mpsc::sync_channel(2);
            Ok(EventSubscription {
                replay: Vec::new(),
                current_version: 0,
                resync_required: false,
                events: Box::new(MockEventStream { receiver: events, capacity: 2, dropped: None }),
            })
        }
    }

    fn event(version: u64) -> EventEnvelope {
        EventEnvelope {
            event_version: version,
            payload: serde_json::json!({
                "eventVersion": version,
                "resyncRequired": false,
                "update": { "kind": "ready" },
            }),
        }
    }

    fn authenticated_test_session() -> (tempfile::TempDir, AuthStore, crate::auth::SessionMaterial) {
        let root = tempfile::tempdir().unwrap();
        let auth = AuthStore::open(
            root.path().join("auth"),
            AuthPolicy::authenticated("https://notes.example.com", "example.com", "Tansu").unwrap(),
            3600,
            300,
        ).unwrap();
        let (capability, _) = auth.create_enrollment_capability(10, 30).unwrap();
        let challenge = tansu_webauthn::RegChallenge {
            challenge: "challenge".into(),
            user_id: "owner".into(),
            username: "owner".into(),
        };
        let ticket = auth.begin_registration(&challenge, Some(&capability), None, 11, 30).unwrap();
        let session = auth.finish_registration(&ticket.id, 12, |_| Ok(tansu_webauthn::StoredCredential {
            cred_id: vec![1],
            aaguid: [0; 16],
            x: [0; 32],
            y: [0; 32],
            sign_count: 0,
            backup_eligible: false,
            backup_state: false,
        })).unwrap().unwrap();
        (root, auth, session)
    }

    #[test]
    fn app_event_sources_receive_bounded_transport_subscription_contract() {
        let source = MockEventSource;
        let subscription = source.subscribe("vault-1", Some(4)).unwrap();
        assert!(subscription.replay.is_empty());
        assert_eq!(subscription.events.capacity(), 2);
        assert!(!subscription.resync_required);
    }

    #[test]
    fn sse_frames_source_replay_and_resync_payloads() {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let (shutdown_sender, shutdown) = watch::channel(false);
        let (event_sender, events) = std::sync::mpsc::sync_channel(2);
        drop(event_sender);
        let replay = runtime.block_on(async {
            sse_body(
                EventSubscription {
                    replay: vec![event(5), event(6)],
                    current_version: 6,
                    resync_required: false,
                    events: Box::new(MockEventStream { receiver: events, capacity: 2, dropped: None }),
                },
                shutdown.clone(),
                None,
                Duration::from_secs(2),
            ).collect().await.unwrap().to_bytes()
        });
        let replay = String::from_utf8_lossy(&replay);
        assert!(replay.contains("id: 5\nevent: message\ndata: {\"eventVersion\":5"));
        assert!(replay.contains("id: 6\nevent: message\ndata: {\"eventVersion\":6"));
        assert!(!replay.contains("\"event\":{\"kind\":\"ready\"}"));

        let (_event_sender, events) = std::sync::mpsc::sync_channel(2);
        let resync = runtime.block_on(async {
            sse_body(
                EventSubscription {
                    replay: Vec::new(),
                    current_version: 8,
                    resync_required: true,
                    events: Box::new(MockEventStream { receiver: events, capacity: 2, dropped: None }),
                },
                shutdown.clone(),
                None,
                Duration::from_secs(2),
            ).collect().await.unwrap().to_bytes()
        });
        let resync = String::from_utf8_lossy(&resync);
        assert!(resync.contains("id: 8\nevent: resyncRequired\ndata: {\"eventVersion\":8,\"resyncRequired\":true,\"update\":{\"kind\":\"resyncRequired\"}}"));
        shutdown_sender.send(true).unwrap();
    }

    #[test]
    fn sse_disconnect_releases_the_source_subscription() {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let (_shutdown_sender, shutdown) = watch::channel(false);
        let (_event_sender, events) = std::sync::mpsc::sync_channel(2);
        let (dropped_sender, dropped_receiver) = std::sync::mpsc::channel();
        runtime.block_on(async {
            let body = sse_body(
                EventSubscription {
                    replay: Vec::new(),
                    current_version: 0,
                    resync_required: false,
                    events: Box::new(MockEventStream {
                        receiver: events,
                        capacity: 2,
                        dropped: Some(dropped_sender),
                    }),
                },
                shutdown,
                None,
                Duration::from_secs(2),
            );
            drop(body);
            tokio::task::spawn_blocking(move || dropped_receiver.recv_timeout(Duration::from_secs(2)))
                .await.unwrap().unwrap();
        });
    }

    #[test]
    fn open_sse_streams_close_on_session_revocation_and_expiry() {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let (_root, auth, session) = authenticated_test_session();
        let (_shutdown_sender, shutdown) = watch::channel(false);
        let (_event_sender, events) = std::sync::mpsc::sync_channel(2);
        let lease = auth.session_lease(&session.cookie_value, 13).unwrap();
        let expiry = StreamAuthorization {
            expires_at: 0,
            revoked: lease.revoked.clone(),
            _lease: lease,
        };
        let expired = runtime.block_on(async {
            let body = sse_body(
                EventSubscription {
                    replay: Vec::new(),
                    current_version: 0,
                    resync_required: false,
                    events: Box::new(MockEventStream { receiver: events, capacity: 2, dropped: None }),
                },
                shutdown.clone(),
                Some(expiry),
                Duration::from_secs(2),
            );
            body.collect().await.unwrap().to_bytes()
        });
        assert!(expired.is_empty());

        let (_event_sender, events) = std::sync::mpsc::sync_channel(2);
        let lease = auth.session_lease(&session.cookie_value, 13).unwrap();
        let revocation = StreamAuthorization {
            expires_at: lease.expires_at,
            revoked: lease.revoked.clone(),
            _lease: lease,
        };
        let revoked = runtime.block_on(async {
            let body = sse_body(
                EventSubscription {
                    replay: Vec::new(),
                    current_version: 0,
                    resync_required: false,
                    events: Box::new(MockEventStream { receiver: events, capacity: 2, dropped: None }),
                },
                shutdown.clone(),
                Some(revocation),
                Duration::from_secs(2),
            );
            let stream = tokio::spawn(body.collect());
            tokio::task::yield_now().await;
            auth.revoke_session(&session.cookie_value).unwrap();
            tokio::time::timeout(Duration::from_secs(1), stream)
                .await.unwrap().unwrap().unwrap().to_bytes()
        });
        assert!(revoked.is_empty());
    }

    #[test]
    fn sse_stream_ends_when_server_shutdown_is_signaled() {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let (shutdown_sender, shutdown) = watch::channel(false);
        let (_event_sender, events) = std::sync::mpsc::sync_channel(2);
        let closed = runtime.block_on(async {
            let body = sse_body(
                EventSubscription {
                    replay: Vec::new(),
                    current_version: 0,
                    resync_required: false,
                    events: Box::new(MockEventStream { receiver: events, capacity: 2, dropped: None }),
                },
                shutdown,
                None,
                Duration::from_secs(2),
            );
            let stream = tokio::spawn(body.collect());
            tokio::task::yield_now().await;
            shutdown_sender.send(true).unwrap();
            tokio::time::timeout(Duration::from_secs(1), stream)
                .await.unwrap().unwrap().unwrap().to_bytes()
        });
        assert!(closed.is_empty());
    }
}
