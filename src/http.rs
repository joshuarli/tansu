use std::any::Any;
use std::convert::Infallible;
use std::future::{pending, Future};
use std::io;
use std::net::TcpListener;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use async_channel::Receiver;
use async_executor::Executor;
use async_lock::Semaphore;
use async_net::{TcpListener as AsyncTcpListener, TcpStream};
use async_io::Timer;
use futures_lite::future;
use futures_lite::io::{AsyncReadExt, AsyncWriteExt};
use futures_util::stream::FuturesUnordered;
use futures_util::{FutureExt, StreamExt};
use http_body_util::{BodyExt, Full, StreamBody, combinators::UnsyncBoxBody};
use hyper::body::{Bytes, Frame, Incoming};
use hyper::header::{CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE, COOKIE, HOST, ORIGIN};
use hyper::server::conn::{http1, http2};
use hyper::service::service_fn;
use hyper::{HeaderMap, Method, Request, Response, StatusCode};
use serde::{Deserialize, Serialize};

use crate::api::{decode_path_segment, handle_v2_api, validate_v2_server_instance, v2_api_error_response};
use crate::api_types::{AppSettings, V2AppSettingsResponse, V2ApiErrorKind};
use crate::app::App;
use crate::auth::{
    AuthError, AuthPolicy, AuthRequestContext, AuthStore, MAX_CREDENTIALS, RequestAction, SessionLease,
    SessionRequirement, VerifiedSession,
};
use crate::embedded_assets;
use crate::logging::{IncomingLogBatch, LogLevel, fields};
use tansu_webauthn::{AuthenticationResponse, RegistrationResponse, RelyingParty};
use crate::{CancellationToken, Error, Result};

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
const API_BUILD_ID: &str = concat!(env!("CARGO_PKG_NAME"), "-", env!("CARGO_PKG_VERSION"));

type HttpBody = UnsyncBoxBody<Bytes, Infallible>;
type ConnectionError = Box<dyn std::error::Error + Send + Sync>;
type ConnectionTaskResult = std::result::Result<Option<ConnectionError>, Box<dyn Any + Send>>;

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
                "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
            );
        for (name, value) in self.headers {
            builder = builder.header(name, value);
        }
        builder.body(Full::new(Bytes::from(self.body)).boxed_unsync()).expect("valid fixed response")
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

#[derive(Debug)]
pub enum EventSourceError {
    VaultNotFound,
    Internal(String),
}

#[derive(Clone)]
pub struct StreamAuthorization {
    pub expires_at: u64,
    revoked: CancellationToken,
    _lease: SessionLease,
}

pub trait EventSource: Send + Sync + 'static {
    fn subscribe(
        &self,
        vault_id: &str,
        after_event_version: Option<u64>,
    ) -> std::result::Result<EventSubscription, EventSourceError>;
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
    shutdown: CancellationToken,
    executor: Arc<Executor<'static>>,
    limits: TransportLimits,
}

struct RequestAuthorization {
    stream: Option<StreamAuthorization>,
    session_cookie: Option<String>,
    verified_session: Option<VerifiedSession>,
}

#[derive(Clone, Copy)]
enum BodyError {
    TooLarge,
    TimedOut,
    Malformed,
}

fn is_v2_path(path: &str) -> bool {
    path == "/api/v2" || path.starts_with("/api/v2/")
}

fn request_id_from_headers(headers: &HeaderMap) -> String {
    if let Ok(Some(value)) = single_header(headers, "X-Tansu-Request-ID") {
        let value = value.chars().filter(|character| !character.is_control()).take(128).collect::<String>();
        if !value.is_empty() {
            return value;
        }
    }
    format!("srv-{:016x}", fastrand::u64(..))
}

fn body_error_response(error: BodyError, headers: &HeaderMap, limits: TransportLimits) -> HttpResponse {
    let status = match error {
        BodyError::TimedOut => Some(408),
        _ => None,
    };
    let error = match error {
        BodyError::TooLarge => V2ApiErrorKind::RequestTooLarge {
            limit_bytes: limits.max_body_bytes.min(u32::MAX as usize) as u32,
        },
        BodyError::TimedOut => V2ApiErrorKind::BadRequest { message: "request body timed out".to_string() },
        BodyError::Malformed => V2ApiErrorKind::BadRequest { message: "invalid request body".to_string() },
    };
    let mut response = v2_api_error_response(error, &request_id_from_headers(headers));
    if let Some(status) = status {
        response.status = status;
    }
    response
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

pub fn serve_setup(app: App, port: u16) -> Result<()> {
    serve_with_services(app, port, ServerServices::default())
}

pub fn serve_listener(app: App, listener: TcpListener) -> Result<()> {
    serve_until_signal(app, listener, ServerServices::default())
}

fn serve_until_signal(app: App, listener: TcpListener, services: ServerServices) -> Result<()> {
    let shutdown = CancellationToken::new();
    let signal = shutdown.clone();
    ctrlc::try_set_handler(move || signal.cancel())
        .map_err(|error| Error::Internal(error.to_string()))?;
    serve_listener_with_shutdown(app, listener, services, shutdown)
}

/// Blocks the calling thread while an owned executor serves requests until `shutdown` is canceled.
pub fn serve_listener_with_shutdown(
    app: App,
    listener: TcpListener,
    services: ServerServices,
    shutdown: CancellationToken,
) -> Result<()> {
    let executor = Arc::new(Executor::new());
    let server_executor = executor.clone();
    let result = async_io::block_on(executor.run(serve_listener_with_limits(
        app.clone(),
        listener,
        services,
        shutdown,
        server_executor,
        TransportLimits::default(),
    )));
    app.shutdown();
    result
}

async fn serve_listener_with_limits(
    app: App,
    listener: TcpListener,
    services: ServerServices,
    shutdown: CancellationToken,
    executor: Arc<Executor<'static>>,
    limits: TransportLimits,
) -> Result<()> {
    listener.set_nonblocking(true)?;
    let listener = AsyncTcpListener::try_from(listener)?;
    let state = ServerState {
        app,
        services,
        blocking_requests: Arc::new(Semaphore::new(limits.max_blocking_requests)),
        shutdown: shutdown.clone(),
        executor: executor.clone(),
        limits,
    };
    let connection_slots = Arc::new(Semaphore::new(limits.max_connections));
    let mut connections = FuturesUnordered::new();

    loop {
        enum ListenerWake {
            Accepted(io::Result<(TcpStream, std::net::SocketAddr)>),
            Shutdown,
            Connection(Option<ConnectionTaskResult>),
        }

        let completed = async {
            if connections.is_empty() {
                pending::<Option<ConnectionTaskResult>>().await
            } else {
                connections.next().await
            }
        };
        let wake = future::race(
            future::race(
                listener.accept().map(ListenerWake::Accepted),
                shutdown.cancelled().map(|()| ListenerWake::Shutdown),
            ),
            completed.map(ListenerWake::Connection),
        ).await;
        match wake {
            ListenerWake::Accepted(Ok((mut stream, _))) => {
                let Some(slot) = connection_slots.try_acquire_arc() else {
                    if let Err(error) = write_overloaded(&mut stream).await {
                        log_connection_error(&state.app, error.to_string());
                    }
                    continue;
                };
                let state = state.clone();
                let connection = async move {
                    let _slot = slot;
                    handle_connection(stream, state).await
                };
                connections.push(executor.spawn(std::panic::AssertUnwindSafe(connection).catch_unwind()));
            }
            ListenerWake::Accepted(Err(error)) => return Err(Error::Io(error)),
            ListenerWake::Shutdown => break,
            ListenerWake::Connection(Some(result)) => report_connection_result(&state.app, result)?,
            ListenerWake::Connection(None) => {}
        }
    }

    while let Some(result) = connections.next().await {
        report_connection_result(&state.app, result)?;
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

fn log_connection_error(app: &App, error: String) {
    if app.logs().enabled() {
        app.logs().server_event(
            LogLevel::Debug,
            "http.connection",
            None,
            fields([("error", serde_json::json!(error))]),
        );
    }
}

fn report_connection_result(
    app: &App,
    result: ConnectionTaskResult,
) -> Result<()> {
    match result {
        Ok(Some(error)) => log_connection_error(app, error.to_string()),
        Ok(None) => {}
        Err(payload) => return Err(connection_task_failure(payload)),
    }
    Ok(())
}

fn connection_task_failure(payload: Box<dyn Any + Send>) -> Error {
    let message = payload.downcast_ref::<String>().map(String::as_str)
        .or_else(|| payload.downcast_ref::<&str>().copied())
        .unwrap_or("non-string panic payload");
    Error::Internal(format!("connection task failed: {message}"))
}

async fn handle_connection(stream: TcpStream, state: ServerState) -> Option<ConnectionError> {
    let duration = state.limits.connection_duration;
    let shutdown = state.shutdown.clone();
    let connection = async move { drive_connection(stream, state).await };
    future::race(
        future::race(
            connection.map(|result| result.err()),
            shutdown.cancelled().map(|()| None),
        ),
        FutureExt::map(Timer::after(duration), |_| None),
    ).await
}

async fn drive_connection(mut stream: TcpStream, state: ServerState) -> std::result::Result<(), ConnectionError> {
    let Some((prefix, protocol)) = connection_prefix(&mut stream).await? else {
        return Ok(());
    };
    let io = PrefixedIo::new(stream, prefix);
    let executor = ServerExecutor(state.executor.clone());
    let service = service_fn(move |request| {
        let state = state.clone();
        async move { Ok::<_, Infallible>(handle_request(request, state).await) }
    });
    match protocol {
        Protocol::Http1 => {
            let mut builder = http1::Builder::new();
            builder.max_buf_size(MAX_HEADER_BYTES);
            builder.max_headers(MAX_HEADER_COUNT);
            builder.keep_alive(false);
            builder.serve_connection(io, service).await.map_err(|error| Box::new(error) as ConnectionError)
        }
        Protocol::Http2 => {
            let mut builder = http2::Builder::new(executor);
            builder.max_header_list_size(MAX_HEADER_BYTES as u32);
            builder.max_concurrent_streams(32);
            builder.serve_connection(io, service).await.map_err(|error| Box::new(error) as ConnectionError)
        }
    }
}

#[derive(Clone, Copy)]
enum Protocol {
    Http1,
    Http2,
}

const HTTP2_PREFACE: &[u8] = b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";

async fn connection_prefix(stream: &mut TcpStream) -> io::Result<Option<(Vec<u8>, Protocol)>> {
    let mut prefix = Vec::with_capacity(HTTP2_PREFACE.len());
    while prefix.len() < HTTP2_PREFACE.len() {
        let mut bytes = [0_u8; HTTP2_PREFACE.len()];
        let read_len = HTTP2_PREFACE.len() - prefix.len();
        let read = stream.read(&mut bytes[..read_len]).await?;
        if read == 0 {
            return Ok(None);
        }
        prefix.extend_from_slice(&bytes[..read]);
        if !HTTP2_PREFACE.starts_with(&prefix) {
            return Ok(Some((prefix, Protocol::Http1)));
        }
    }
    Ok(Some((prefix, Protocol::Http2)))
}

struct PrefixedIo<T> {
    stream: Pin<Box<T>>,
    prefix: Vec<u8>,
    offset: usize,
}

impl<T> PrefixedIo<T> {
    fn new(stream: T, prefix: Vec<u8>) -> Self {
        Self { stream: Box::pin(stream), prefix, offset: 0 }
    }
}

impl<T: futures_io::AsyncRead> hyper::rt::Read for PrefixedIo<T> {
    fn poll_read(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        mut buffer: hyper::rt::ReadBufCursor<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let capacity = buffer.remaining();
        if capacity == 0 {
            return Poll::Ready(Ok(()));
        }
        let read = {
            let target = buffer.initialize_unfilled();
            if this.offset < this.prefix.len() {
                let count = (this.prefix.len() - this.offset).min(target.len());
                target[..count].copy_from_slice(&this.prefix[this.offset..this.offset + count]);
                this.offset += count;
                count
            } else {
                match futures_io::AsyncRead::poll_read(this.stream.as_mut(), context, target) {
                    Poll::Ready(Ok(count)) => count,
                    Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
                    Poll::Pending => return Poll::Pending,
                }
            }
        };
        if read > capacity {
            return Poll::Ready(Err(io::Error::new(io::ErrorKind::InvalidData, "AsyncRead returned more bytes than requested")));
        }
        unsafe {
            // SAFETY: The initialized target region contains `read` bytes, and the bounds check proves the cursor has enough remaining capacity.
            buffer.advance(read);
        }
        Poll::Ready(Ok(()))
    }
}

impl<T: futures_io::AsyncWrite> hyper::rt::Write for PrefixedIo<T> {
    fn poll_write(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        futures_io::AsyncWrite::poll_write(self.get_mut().stream.as_mut(), context, buffer)
    }

    fn poll_flush(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        futures_io::AsyncWrite::poll_flush(self.get_mut().stream.as_mut(), context)
    }

    fn poll_shutdown(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        futures_io::AsyncWrite::poll_close(self.get_mut().stream.as_mut(), context)
    }
}

#[derive(Clone)]
struct ServerExecutor(Arc<Executor<'static>>);

impl<F> hyper::rt::Executor<F> for ServerExecutor
where
    F: Future<Output = ()> + Send + 'static,
{
    fn execute(&self, future: F) {
        self.0.spawn(future).detach();
    }
}

async fn write_overloaded(stream: &mut TcpStream) -> io::Result<()> {
    stream.write_all(
        b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n\r\n",
    ).await
}

async fn handle_request(request: Request<Incoming>, state: ServerState) -> Response<HttpBody> {
    let is_v2 = is_v2_path(request.uri().path());
    let mut response = handle_request_inner(request, state).await;
    if is_v2 {
        add_v2_protocol_headers(&mut response);
    }
    response
}

fn add_v2_protocol_headers(response: &mut Response<HttpBody>) {
    response.headers_mut().insert("X-Tansu-Api-Version", "2".parse().expect("valid header value"));
    response.headers_mut().insert("X-Tansu-Build-Id", API_BUILD_ID.parse().expect("valid header value"));
}

async fn handle_request_inner(request: Request<Incoming>, state: ServerState) -> Response<HttpBody> {
    let (parts, body) = request.into_parts();
    let path = parts.uri.to_string();
    let request_headers = parts.headers.clone();
    let header_bytes = request_headers.iter().fold(0_usize, |size, (name, value)| {
        size.saturating_add(name.as_str().len()).saturating_add(value.as_bytes().len())
    });
    if request_headers.len() > MAX_HEADER_COUNT || header_bytes > MAX_HEADER_BYTES {
        let mut response = v2_api_error_response(
            V2ApiErrorKind::RequestTooLarge {
                limit_bytes: MAX_HEADER_BYTES.min(u32::MAX as usize) as u32,
            },
            &request_id_from_headers(&request_headers),
        );
        response.status = 431;
        return response.with_no_store().into_hyper();
    }
    if requests_h2c_upgrade(&request_headers) {
        return v2_api_error_response(
            V2ApiErrorKind::BadRequest { message: "HTTP/2 upgrade is not supported".to_string() },
            &request_id_from_headers(&request_headers),
        ).with_no_store().into_hyper();
    }
    if parts.uri.path() == "/events" {
        return v2_api_error_response(
            V2ApiErrorKind::ApiVersionUnsupported {
                requested_version: Some(1),
                supported_version: 2,
            },
            &request_id_from_headers(&request_headers),
        ).with_no_store().into_hyper();
    }
    if parts.uri.path().starts_with("/api/")
        && !is_v2_path(parts.uri.path())
        && !parts.uri.path().starts_with("/api/dev/logs")
    {
        let response = v2_api_error_response(
            V2ApiErrorKind::ApiVersionUnsupported {
                requested_version: Some(1),
                supported_version: 2,
            },
            &request_id_from_headers(&request_headers),
        );
        return response.with_no_store().into_hyper();
    }
    let access = match authorize_request(&parts.method, &parts.uri, &request_headers, &state.services) {
        Ok(access) => access,
        Err(error) => {
            return v2_api_error_response(error, &request_id_from_headers(&request_headers))
                .with_no_store()
                .into_hyper();
        }
    };

    if let Some(vault_id) = event_vault_id(&parts.uri) {
        if parts.method != Method::GET {
            return v2_api_error_response(
                V2ApiErrorKind::BadRequest { message: "events only supports GET".to_string() },
                &request_id_from_headers(&request_headers),
            ).with_no_store().into_hyper();
        }
        return event_response(&parts.uri, &request_headers, vault_id, access, &state).await;
    }

    if parts.uri.path().starts_with("/api/v2/auth/") {
        let Some(auth) = &state.services.auth else {
            return v2_api_error_response(V2ApiErrorKind::NotImplemented, &request_id_from_headers(&request_headers))
                .with_no_store().into_hyper();
        };
        return handle_auth_route(
            &parts.method,
            &parts.uri,
            &request_headers,
            body,
            auth.clone(),
            access.session_cookie.as_deref(),
            access.verified_session,
            state,
        ).await;
    }

    let is_api = path.starts_with("/api/");
    if !is_api {
        return serve_static_response(&parts.uri.to_string()).into_hyper();
    }

    let Some(worker_slot) = state.blocking_requests.try_acquire_arc() else {
        return v2_api_error_response(
            V2ApiErrorKind::RateLimited { retry_after_ms: 100 },
            &request_id_from_headers(&request_headers),
        ).with_no_store().into_hyper();
    };
    let body = match collect_body(body, &request_headers, state.limits).await {
        Ok(body) => body,
        Err(error) => return body_error_response(error, &request_headers, state.limits).with_no_store().into_hyper(),
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
    let request_id_value = request_id(&request).unwrap_or_else(|| "request".to_string());
    let request_id_for_worker = request_id_value.clone();
    let result = blocking::unblock(move || {
        let _worker_slot = worker_slot;
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let response = route(&app, &request);
            log_request(&app, &request, &response, Some(request_id_for_worker), started.elapsed().as_millis());
            response.with_no_store()
        }))
    }).await;
    match result {
        Ok(response) => response.into_hyper(),
        Err(_) => v2_api_error_response(
            V2ApiErrorKind::Internal { request_id: request_id_value.clone() },
            &request_id_value,
        ).with_no_store().into_hyper(),
    }
}

fn requests_h2c_upgrade(headers: &HeaderMap) -> bool {
    headers.get_all(hyper::header::UPGRADE).iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|protocol| protocol.trim().split('/').next().is_some_and(|name| name.eq_ignore_ascii_case("h2c")))
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
    let read_body = async move {
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
    };
    future::race(
        read_body,
        FutureExt::map(Timer::after(limits.request_body_duration), |_| Err(BodyError::TimedOut)),
    ).await
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
    verified_session: Option<VerifiedSession>,
    state: ServerState,
) -> Response<HttpBody> {
    let request_id = request_id_from_headers(headers);
    let Some(worker_slot) = state.blocking_requests.try_acquire_arc() else {
        return v2_api_error_response(V2ApiErrorKind::RateLimited { retry_after_ms: 100 }, &request_id)
            .with_no_store().into_hyper();
    };
    let body = match collect_body(body, headers, state.limits).await {
        Ok(body) => body,
        Err(error) => return body_error_response(error, headers, state.limits).with_no_store().into_hyper(),
    };
    let method = method.to_string();
    let path = uri.path().to_string();
    let session_cookie = session_cookie.map(str::to_string);
    let request_id_for_worker = request_id.clone();
    match blocking::unblock(move || {
        let _worker_slot = worker_slot;
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            handle_auth_route_sync(
                &method,
                &path,
                &body,
                &auth,
                session_cookie.as_deref(),
                verified_session,
                &request_id_for_worker,
            )
        }))
    }).await {
        Ok(response) => response.with_no_store().into_hyper(),
        Err(_) => v2_api_error_response(V2ApiErrorKind::Internal { request_id: request_id.clone() }, &request_id)
            .with_no_store().into_hyper(),
    }
}

fn handle_auth_route_sync(
    method: &str,
    path: &str,
    body: &[u8],
    auth: &AuthStore,
    session_cookie: Option<&str>,
    verified_session: Option<VerifiedSession>,
    request_id: &str,
) -> HttpResponse {
    if method == "GET" && path == "/api/v2/auth/session" {
        let Some(session) = verified_session else {
            return auth_error(AuthError::Unauthorized, request_id);
        };
        return HttpResponse::json(200, &serde_json::json!({
            "authenticated": true,
            "verifiedAt": session.verified_at,
            "expiresAt": session.expires_at,
        })).unwrap_or_else(|_| v2_api_error_response(
            V2ApiErrorKind::Internal { request_id: request_id.to_string() },
            request_id,
        ));
    }
    let Some((rp_id, origin, rp_name)) = auth.policy().rp() else {
        return auth_error(AuthError::InvalidRequest("passkeys are disabled in loopback development mode".into()), request_id);
    };
    let rp = RelyingParty::new(rp_id, origin, rp_name);
    match (method, path) {
        ("POST", "/api/v2/auth/enrollment/options") => {
            let start: RegistrationStart = match serde_json::from_slice(body) {
                Ok(start) => start,
                Err(error) => return auth_error(AuthError::InvalidRequest(error.to_string()), request_id),
            };
            let (options, state) = match rp.start_registration("tansu2-owner-v1", "Tansu Owner") {
                Ok(options) => options,
                Err(error) => return auth_error(AuthError::WebAuthn(error.to_string()), request_id),
            };
            let now = match unix_time_seconds() {
                Ok(now) => now,
                Err(_) => return v2_internal_error(request_id),
            };
            match auth.begin_registration(&state, start.capability.as_deref(), session_cookie, now, 300) {
                Ok(ticket) => HttpResponse::json(200, &serde_json::json!({
                    "ceremonyId": ticket.id,
                    "expiresAt": ticket.expires_at,
                    "publicKey": options,
                })).unwrap_or_else(|_| v2_internal_error(request_id)),
                Err(error) => auth_error(error, request_id),
            }
        }
        ("POST", "/api/v2/auth/enrollment/finish") => {
            let finish: CeremonyFinish<RegistrationResponse> = match serde_json::from_slice(body) {
                Ok(finish) => finish,
                Err(error) => return auth_error(AuthError::InvalidRequest(error.to_string()), request_id),
            };
            let now = match unix_time_seconds() {
                Ok(now) => now,
                Err(_) => return v2_internal_error(request_id),
            };
            match auth.finish_registration(&finish.ceremony_id, now, |challenge| {
                rp.finish_registration(&finish.credential, challenge)
                    .map_err(|error| AuthError::WebAuthn(error.to_string()))
            }) {
                Ok(session) => {
                    let csrf = session.as_ref().map(|session| session.csrf_token.as_str());
                    let mut response = HttpResponse::json(200, &serde_json::json!({ "ok": true, "csrfToken": csrf }))
                        .unwrap_or_else(|_| v2_internal_error(request_id));
                    if let Some(session) = session {
                        response = response.with_header("Set-Cookie", &auth.session_cookie(&session));
                        response = response.with_header("Set-Cookie", &csrf_cookie(&session.csrf_token));
                    }
                    response
                }
                Err(error) => auth_error(error, request_id),
            }
        }
        ("POST", "/api/v2/auth/login/options") => {
            let credentials = match auth.credentials() {
                Ok(credentials) if !credentials.is_empty() && credentials.len() <= MAX_CREDENTIALS => credentials,
                Ok(_) => return auth_error(AuthError::Unauthorized, request_id),
                Err(error) => return auth_error(error, request_id),
            };
            let (options, state) = match rp.start_authentication(&credentials, b"tansu2-owner-v1") {
                Ok(options) => options,
                Err(error) => return auth_error(AuthError::WebAuthn(error.to_string()), request_id),
            };
            let now = match unix_time_seconds() {
                Ok(now) => now,
                Err(_) => return v2_internal_error(request_id),
            };
            match auth.begin_authentication(&state, now, 300) {
                Ok(ticket) => HttpResponse::json(200, &serde_json::json!({
                    "ceremonyId": ticket.id,
                    "expiresAt": ticket.expires_at,
                    "publicKey": options,
                })).unwrap_or_else(|_| v2_internal_error(request_id)),
                Err(error) => auth_error(error, request_id),
            }
        }
        ("POST", "/api/v2/auth/login/finish") => {
            let finish: CeremonyFinish<AuthenticationResponse> = match serde_json::from_slice(body) {
                Ok(finish) => finish,
                Err(error) => return auth_error(AuthError::InvalidRequest(error.to_string()), request_id),
            };
            let now = match unix_time_seconds() {
                Ok(now) => now,
                Err(_) => return v2_internal_error(request_id),
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
                    .unwrap_or_else(|_| v2_internal_error(request_id))
                    .with_header("Set-Cookie", &auth.session_cookie(&session))
                    .with_header("Set-Cookie", &csrf_cookie(&session.csrf_token)),
                Err(error) => auth_error(error, request_id),
            }
        }
        ("POST", "/api/v2/auth/logout") => {
            let Some(session_cookie) = session_cookie else { return auth_error(AuthError::Unauthorized, request_id); };
            match auth.revoke_session(session_cookie) {
                Ok(()) => HttpResponse::json(200, &serde_json::json!({ "ok": true }))
                    .unwrap_or_else(|_| v2_internal_error(request_id))
                    .with_header("Set-Cookie", "__Host-tansu_session=; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=0")
                    .with_header("Set-Cookie", "__Host-tansu_csrf=; Secure; Path=/; SameSite=Strict; Max-Age=0"),
                Err(error) => auth_error(error, request_id),
            }
        }
        _ => v2_api_error_response(V2ApiErrorKind::NotImplemented, request_id),
    }
}

fn csrf_cookie(token: &str) -> String {
    format!("__Host-tansu_csrf={token}; Secure; Path=/; SameSite=Strict")
}

fn v2_internal_error(request_id: &str) -> HttpResponse {
    v2_api_error_response(
        V2ApiErrorKind::Internal { request_id: request_id.to_string() },
        request_id,
    )
}

fn auth_error(error: AuthError, request_id: &str) -> HttpResponse {
    v2_api_error_response(auth_error_kind(error, request_id), request_id)
}

fn auth_error_kind(error: AuthError, request_id: &str) -> V2ApiErrorKind {
    match error {
        AuthError::InvalidRequest(message) | AuthError::WebAuthn(message) => V2ApiErrorKind::BadRequest { message },
        AuthError::CredentialLimit => V2ApiErrorKind::BadRequest { message: AuthError::CredentialLimit.to_string() },
        AuthError::Unauthorized => V2ApiErrorKind::AuthRequired,
        AuthError::OriginRejected => V2ApiErrorKind::OriginRejected,
        AuthError::CsrfRejected => V2ApiErrorKind::CsrfRejected,
        AuthError::Expired | AuthError::CeremonyUsed => V2ApiErrorKind::Forbidden,
        AuthError::CeremonyLimit => V2ApiErrorKind::RateLimited { retry_after_ms: 1000 },
        AuthError::Storage(_) => V2ApiErrorKind::Internal { request_id: request_id.to_string() },
    }
}

fn authorize_request(
    method: &Method,
    uri: &hyper::Uri,
    headers: &HeaderMap,
    services: &ServerServices,
) -> std::result::Result<RequestAuthorization, V2ApiErrorKind> {
    let Some(auth) = &services.auth else {
        return Ok(RequestAuthorization { stream: None, session_cookie: None, verified_session: None });
    };
    let host = single_header(headers, HOST.as_str())
        .map_err(|()| V2ApiErrorKind::OriginRejected)?
        .ok_or(V2ApiErrorKind::OriginRejected)?;
    let origin = single_header(headers, ORIGIN.as_str()).map_err(|()| V2ApiErrorKind::OriginRejected)?;
    let cookie_header = single_header(headers, COOKIE.as_str()).map_err(|()| V2ApiErrorKind::AuthRequired)?;
    let session_cookie = parse_session_cookie(cookie_header).map_err(|_| V2ApiErrorKind::AuthRequired)?;
    let csrf = single_header(headers, "X-Tansu-CSRF").map_err(|()| V2ApiErrorKind::CsrfRejected)?;
    let state_changing = !matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS);
    let authenticated_mode = matches!(auth.policy(), AuthPolicy::Authenticated { .. });
    let event_stream = event_vault_id(uri).is_some();
    let ceremony_route = is_ceremony_route(method, uri.path());
    let login_route = is_login_ceremony_route(method, uri.path());
    let public_health_route = *method == Method::GET && uri.path() == "/api/v2/health";
    let ignore_session = login_route || public_health_route;
    let require_session = authenticated_mode
        && (uri.path().starts_with("/api/") || event_stream)
        && !ceremony_route
        && !public_health_route;
    let now = unix_time_seconds().map_err(|_| V2ApiErrorKind::Internal {
        request_id: request_id_from_headers(headers),
    })?;
    let action = if state_changing { RequestAction::StateChange } else { RequestAction::Read };
    let session_requirement = if require_session { SessionRequirement::Required } else { SessionRequirement::Optional };
    let (verified, effective_session_cookie) = match auth.validate_request(AuthRequestContext {
        host,
        origin,
        action,
        session_cookie: if ignore_session { None } else { session_cookie.as_deref() },
        csrf_token: if ignore_session { None } else { csrf },
        session_requirement,
        now,
    }) {
        Ok(verified) => (verified, if ignore_session { None } else { session_cookie }),
        Err(AuthError::Unauthorized) if ceremony_route && !login_route => {
            let verified = auth.validate_request(AuthRequestContext {
                host,
                origin,
                action,
                session_cookie: None,
                csrf_token: None,
                session_requirement: SessionRequirement::Optional,
                now,
            }).map_err(|error| auth_error_kind(error, &request_id_from_headers(headers)))?;
            (verified, None)
        }
        Err(error) => return Err(auth_error_kind(error, &request_id_from_headers(headers))),
    };
    let stream = if authenticated_mode && event_stream {
        let cookie = effective_session_cookie.as_deref().ok_or(V2ApiErrorKind::AuthRequired)?;
        let lease = auth.session_lease(cookie, now)
            .map_err(|error| auth_error_kind(error, &request_id_from_headers(headers)))?;
        Some(StreamAuthorization {
            expires_at: lease.expires_at,
            revoked: lease.revoked.clone(),
            _lease: lease,
        })
    } else {
        None
    };
    if require_session && verified.is_none() {
        return Err(V2ApiErrorKind::AuthRequired);
    }
    Ok(RequestAuthorization { stream, session_cookie: effective_session_cookie, verified_session: verified })
}

fn single_header<'a>(headers: &'a HeaderMap, name: &'static str) -> std::result::Result<Option<&'a str>, ()> {
    let mut values = headers.get_all(name).iter();
    let value = values.next();
    if values.next().is_some() {
        return Err(());
    }
    value.map(|value| value.to_str().map_err(|_| ())).transpose()
}

fn is_ceremony_route(method: &Method, path: &str) -> bool {
    matches!((method, path),
        (&Method::POST, "/api/v2/auth/login/options")
        | (&Method::POST, "/api/v2/auth/login/finish")
        | (&Method::POST, "/api/v2/auth/enrollment/options")
        | (&Method::POST, "/api/v2/auth/enrollment/finish")
    )
}

fn is_login_ceremony_route(method: &Method, path: &str) -> bool {
    matches!((method, path),
        (&Method::POST, "/api/v2/auth/login/options")
        | (&Method::POST, "/api/v2/auth/login/finish")
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
    let rest = path.strip_prefix("/api/v2/vaults/")?;
    let (vault_id, route) = rest.split_once('/')?;
    if route != "events" {
        return None;
    }
    decode_path_segment(vault_id).ok()
}

async fn event_response(
    uri: &hyper::Uri,
    headers: &HeaderMap,
    vault_id: String,
    authorization: RequestAuthorization,
    state: &ServerState,
) -> Response<HttpBody> {
    let request_id = request_id_from_headers(headers);
    if is_v2_path(uri.path()) {
        if let Err(error) = validate_v2_server_instance(&state.app, &header_pairs(headers)) {
            return v2_api_error_response(error, &request_id).with_no_store().into_hyper();
        }
    }
    let Some(source) = &state.services.events else {
        return v2_api_error_response(V2ApiErrorKind::NotImplemented, &request_id)
            .with_no_store().into_hyper();
    };
    let after_event_version = match event_after_version(uri, headers) {
        Ok(version) => version,
        Err(error) => return v2_api_error_response(error, &request_id).with_no_store().into_hyper(),
    };
    let subscription = match source.subscribe(&vault_id, after_event_version) {
        Ok(subscription) => subscription,
        Err(EventSourceError::VaultNotFound) => {
            return v2_api_error_response(
                V2ApiErrorKind::VaultNotFound { vault_id },
                &request_id,
            ).with_no_store().into_hyper();
        }
        Err(EventSourceError::Internal(_)) => {
            return v2_internal_error(&request_id).with_no_store().into_hyper();
        }
    };
    if subscription.events.capacity() > MAX_SSE_SOURCE_QUEUE {
        return v2_internal_error(&request_id).with_no_store().into_hyper();
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

fn header_pairs(headers: &HeaderMap) -> Vec<(String, String)> {
    headers.iter().map(|(name, value)| {
        (name.as_str().to_string(), String::from_utf8_lossy(value.as_bytes()).to_string())
    }).collect()
}

fn event_after_version(
    uri: &hyper::Uri,
    headers: &HeaderMap,
) -> std::result::Result<Option<u64>, V2ApiErrorKind> {
    let mut query_after = None;
    if let Some(query) = uri.query() {
        for pair in query.split('&') {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            if name == "after" {
                if query_after.is_some() {
                    return Err(V2ApiErrorKind::BadRequest { message: "duplicate after parameter".to_string() });
                }
                query_after = Some(value.parse::<u64>().map_err(|_| {
                    V2ApiErrorKind::BadRequest { message: "invalid after event version".to_string() }
                })?);
            }
        }
    }
    if query_after.is_some() {
        return Ok(query_after);
    }
    match single_header(headers, "Last-Event-ID") {
        Ok(None) => Ok(None),
        Ok(Some(value)) => value.parse::<u64>().map(Some).map_err(|_| {
            V2ApiErrorKind::BadRequest { message: "invalid Last-Event-ID".to_string() }
        }),
        Err(()) => Err(V2ApiErrorKind::BadRequest { message: "duplicate Last-Event-ID".to_string() }),
    }
}

fn sse_body(
    subscription: EventSubscription,
    shutdown: CancellationToken,
    authorization: Option<StreamAuthorization>,
    max_duration: Duration,
) -> HttpBody {
    let EventSubscription {
        replay,
        current_version,
        resync_required,
        mut events,
    } = subscription;
    let (event_sender, receiver) = async_channel::bounded(SSE_BODY_QUEUE);
    let (replay, resync) = sse_replay_frames(replay, current_version, resync_required);
    let live = !resync;
    let event_bridge = live.then(|| {
        blocking::unblock(move || loop {
            if event_sender.is_closed() {
                return;
            }
            match events.recv_timeout(Duration::from_millis(250)) {
                Ok(event) => {
                    if event_sender.send_blocking(event).is_err() {
                        return;
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
            }
        })
    });
    let deadline = Instant::now() + max_duration;
    let authorization_deadline = authorization.as_ref().map(|authorization| {
        let now = unix_time_seconds().unwrap_or(u64::MAX);
        let remaining = authorization.expires_at.saturating_sub(now);
        Instant::now().checked_add(Duration::from_secs(remaining)).unwrap_or(deadline).min(deadline)
    });
    let state = SseBodyState {
        replay,
        receiver,
        event_bridge,
        shutdown,
        authorization,
        authorization_deadline,
        deadline,
        next_heartbeat: Instant::now() + Duration::from_secs(15),
        live,
        current_version,
    };
    StreamBody::new(futures_util::stream::unfold(state, |mut state| async move {
        state.next().await.map(|bytes| (Ok(Frame::data(bytes)), state))
    })).boxed_unsync()
}

fn sse_replay_frames(
    replay: Vec<EventEnvelope>,
    current_version: u64,
    resync_required: bool,
) -> (std::collections::VecDeque<Bytes>, bool) {
    if resync_required || replay.len() > MAX_SSE_REPLAY_EVENTS {
        return ([sse_resync_event(current_version)].into(), true);
    }
    let mut frames = std::collections::VecDeque::with_capacity(replay.len());
    let mut total_bytes = 0_usize;
    for event in replay {
        let Some(bytes) = sse_event_bytes(&event) else {
            return ([sse_resync_event(current_version.max(event.event_version))].into(), true);
        };
        total_bytes = total_bytes.saturating_add(bytes.len());
        if total_bytes > MAX_SSE_REPLAY_BYTES {
            return ([sse_resync_event(current_version)].into(), true);
        }
        frames.push_back(bytes);
    }
    (frames, false)
}

enum SseWake {
    Event(std::result::Result<EventEnvelope, async_channel::RecvError>),
    Shutdown,
    Revoked,
    Timer,
}

struct SseBodyState {
    replay: std::collections::VecDeque<Bytes>,
    receiver: Receiver<EventEnvelope>,
    event_bridge: Option<blocking::Task<()>>,
    shutdown: CancellationToken,
    authorization: Option<StreamAuthorization>,
    authorization_deadline: Option<Instant>,
    deadline: Instant,
    next_heartbeat: Instant,
    live: bool,
    current_version: u64,
}

impl SseBodyState {
    async fn next(&mut self) -> Option<Bytes> {
        if let Some(frame) = self.replay.pop_front() {
            return Some(frame);
        }
        if !self.live || self.shutdown.is_cancelled() {
            self.close().await;
            return None;
        }
        loop {
            let now = Instant::now();
            if now >= self.deadline || self.authorization_deadline.is_some_and(|deadline| now >= deadline) {
                self.close().await;
                return None;
            }
            let wake_at = self.authorization_deadline.unwrap_or(self.deadline)
                .min(self.deadline)
                .min(self.next_heartbeat);
            let timer = FutureExt::map(Timer::at(wake_at), |_| SseWake::Timer);
            let revoked = async {
                match &self.authorization {
                    Some(authorization) => authorization.revoked.cancelled().await,
                    None => pending::<()>().await,
                }
                SseWake::Revoked
            };
            let wake = future::race(
                future::race(
                    self.receiver.recv().map(SseWake::Event),
                    self.shutdown.cancelled().map(|()| SseWake::Shutdown),
                ),
                future::race(revoked, timer),
            ).await;
            match wake {
                SseWake::Event(Ok(event)) => {
                    if let Some(bytes) = sse_event_bytes(&event) {
                        return Some(bytes);
                    }
                    self.live = false;
                    return Some(sse_resync_event(self.current_version.max(event.event_version)));
                }
                SseWake::Event(Err(_)) | SseWake::Shutdown | SseWake::Revoked => {
                    self.close().await;
                    return None;
                }
                SseWake::Timer => {
                    let now = Instant::now();
                    if now >= self.deadline || self.authorization_deadline.is_some_and(|deadline| now >= deadline) {
                        self.close().await;
                        return None;
                    }
                    if now >= self.next_heartbeat {
                        self.next_heartbeat = now + Duration::from_secs(15);
                        return Some(Bytes::from_static(b": keep-alive\n\n"));
                    }
                }
            }
        }
    }

    async fn close(&mut self) {
        self.live = false;
        self.receiver.close();
        if let Some(bridge) = self.event_bridge.take() {
            bridge.await;
        }
    }
}

impl Drop for SseBodyState {
    fn drop(&mut self) {
        self.receiver.close();
    }
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

fn route(app: &App, request: &HttpRequest) -> HttpResponse {
    if request.path == "/api/v2/app/settings" {
        return handle_app_settings(app, request).with_no_store();
    }
    if request.path.starts_with("/api/dev/logs") {
        return handle_dev_logs(app, request);
    }
    if is_v2_path(&request.path) {
        let request_id = request_id(request).unwrap_or_else(|| "request".to_string());
        return handle_v2_api(app, request, &request_id).with_no_store();
    }
    if request.path.starts_with("/api/") {
        return v2_api_error_response(
            V2ApiErrorKind::ApiVersionUnsupported {
                requested_version: Some(1),
                supported_version: 2,
            },
            &request_id(request).unwrap_or_else(|| "request".to_string()),
        ).with_no_store();
    }
    let path = if app.setup_mode() && request.path == "/" { "/setup" } else { &request.path };
    serve_static_response(path)
}

fn handle_app_settings(app: &App, request: &HttpRequest) -> HttpResponse {
    match request.method.as_str() {
        "GET" => match app.app_settings() {
            Ok(settings) => HttpResponse::json(200, &V2AppSettingsResponse {
                settings,
                restart_required: false,
            }).unwrap_or_else(|error| HttpResponse::text(500, &error.to_string())),
            Err(error) => HttpResponse::text(500, &error.to_string()),
        },
        "PUT" => match serde_json::from_slice::<AppSettings>(&request.body) {
            Ok(settings) => match app.save_app_settings(&settings) {
                Ok(()) => HttpResponse::json(200, &V2AppSettingsResponse {
                    settings: Some(settings),
                    restart_required: true,
                }).unwrap_or_else(|error| HttpResponse::text(500, &error.to_string())),
                Err(error) => HttpResponse::text(400, &error.to_string()),
            },
            Err(error) => HttpResponse::text(400, &error.to_string()),
        },
        _ => HttpResponse::text(405, "method not allowed").with_header("Allow", "GET, PUT"),
    }
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

fn serve_static_response(path: &str) -> HttpResponse {
    serve_static_path(path).unwrap_or_else(|error| {
        if matches!(error, Error::NotFound(_)) {
            HttpResponse::text(404, "not found")
        } else {
            HttpResponse::text(500, &error.to_string())
        }
    })
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

    use crate::config::{Config, ConfigStore, VaultConfig};

    #[test]
    fn request_metadata_and_error_fields_preserve_transport_contracts() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "X-Tansu-Request-ID",
            hyper::header::HeaderValue::from_bytes(b"req\tid").unwrap(),
        );
        assert_eq!(request_id_from_headers(&headers), "reqid");
        headers.insert(
            "X-Tansu-Request-ID",
            hyper::header::HeaderValue::from_str(&"x".repeat(150)).unwrap(),
        );
        assert_eq!(request_id_from_headers(&headers), "x".repeat(128));
        headers.insert("X-Tansu-Request-ID", hyper::header::HeaderValue::from_static(""));
        assert!(request_id_from_headers(&headers).starts_with("srv-"));

        let request = HttpRequest {
            method: "GET".to_string(),
            path: "/api/v2/health?vault=3".to_string(),
            headers: vec![("X-Tansu-Vault".to_string(), "5".to_string())],
            body: Vec::new(),
        };
        assert!(request_id(&request).unwrap().starts_with("srv-"));
        assert_eq!(request_vault(&request), Some(3));
        let mut identified = request.clone();
        identified.headers.push(("X-Tansu-Request-ID".to_string(), "request-9".to_string()));
        assert_eq!(request_id(&identified).as_deref(), Some("request-9"));
        let header_vault = HttpRequest { path: "/api/v2/health".to_string(), ..request };
        assert_eq!(request_vault(&header_vault), Some(5));

        assert!(api_error_field(&HttpResponse::json(200, &serde_json::json!({"error": "ignored"})).unwrap()).is_null());
        assert!(api_error_field(&HttpResponse::text(500, "broken")).is_null());
        let malformed_json = HttpResponse {
            status: 500,
            content_type: "application/json; charset=utf-8".to_string(),
            headers: Vec::new(),
            body: b"{".to_vec(),
        };
        assert!(api_error_field(&malformed_json).is_null());
        let response = v2_api_error_response(V2ApiErrorKind::NotImplemented, "request-id");
        assert_eq!(api_error_field(&response)["code"], "not_implemented");
    }

    #[test]
    fn body_errors_use_bounded_v2_responses() {
        let mut headers = HeaderMap::new();
        headers.insert("X-Tansu-Request-ID", "request-body".parse().unwrap());
        let limits = TransportLimits {
            max_body_bytes: 64,
            ..TransportLimits::default()
        };
        for (error, status, expected) in [
            (BodyError::TooLarge, 413, "request_too_large"),
            (BodyError::TimedOut, 408, "bad_request"),
            (BodyError::Malformed, 400, "bad_request"),
        ] {
            let response = body_error_response(error, &headers, limits);
            assert_eq!(response.status(), status);
            assert!(String::from_utf8_lossy(response.body()).contains(expected));
        }
    }

    #[test]
    fn ceremony_limit_uses_rate_limited_response_with_retry_delay() {
        let response = auth_error(AuthError::CeremonyLimit, "request-id");

        assert_eq!(response.status(), 429);
        assert_eq!(
            api_error_field(&response),
            serde_json::json!({ "code": "rate_limited", "retryAfterMs": 1000 }),
        );
    }

    #[test]
    fn credential_limit_is_a_bad_request_naming_the_limit() {
        let response = auth_error(AuthError::CredentialLimit, "request-id");

        assert_eq!(response.status(), 400);
        let error = api_error_field(&response);
        assert_eq!(error["code"], "bad_request");
        assert!(error["message"].as_str().unwrap().contains(&MAX_CREDENTIALS.to_string()));
    }

    #[test]
    fn route_handles_embedded_assets_and_disabled_development_logs() {
        let root = tempfile::tempdir().unwrap();
        let vault_path = root.path().join("vault");
        std::fs::create_dir_all(&vault_path).unwrap();
        let app = App::new(Config {
            vaults: vec![VaultConfig {
                name: "Test".into(),
                path: vault_path,
                state_path: root.path().join("state"),

            }],
            auth: None,
        })
        .unwrap();

        let shell = route(
            &app,
            &HttpRequest {
                method: "GET".to_string(),
                path: "/".to_string(),
                headers: Vec::new(),
                body: Vec::new(),
            },
        );
        assert_eq!(shell.status(), 200);
        let missing = route(
            &app,
            &HttpRequest {
                method: "GET".to_string(),
                path: "/missing".to_string(),
                headers: Vec::new(),
                body: Vec::new(),
            },
        );
        assert_eq!(missing.status(), 404);
        for method in ["GET", "POST", "DELETE"] {
            let response = route(
                &app,
                &HttpRequest {
                    method: method.to_string(),
                    path: "/api/dev/logs".to_string(),
                    headers: Vec::new(),
                    body: Vec::new(),
                },
            );
            assert_eq!(response.status(), 404);
        }
        log_request(
            &app,
            &HttpRequest {
                method: "GET".to_string(),
                path: "/api/v2/health".to_string(),
                headers: Vec::new(),
                body: Vec::new(),
            },
            &shell,
            None,
            0,
        );
        assert!(app.logs().snapshot().events.is_empty());
    }

    #[test]
    fn first_run_setup_saves_app_settings_and_requires_restart() {
        let root = tempfile::tempdir().unwrap();
        let store = ConfigStore::open(&root.path().join("config/settings.sqlite3")).unwrap();
        let app = App::setup_only(store);
        let request = |method: &str, path: &str, body: &[u8]| HttpRequest {
            method: method.to_string(),
            path: path.to_string(),
            headers: Vec::new(),
            body: body.to_vec(),
        };

        let setup = route(&app, &request("GET", "/", &[]));
        assert_eq!(setup.status(), 200);
        assert!(String::from_utf8_lossy(setup.body()).contains("Set up Tansu2"));

        let initial = route(&app, &request("GET", "/api/v2/app/settings", &[]));
        let initial: serde_json::Value = serde_json::from_slice(initial.body()).unwrap();
        assert_eq!(initial["settings"], serde_json::Value::Null);
        assert_eq!(initial["restartRequired"], false);

        let body = serde_json::json!({
            "vaults": [{ "name": "Notes", "path": root.path().join("notes") }],
            "auth": null,
        }).to_string();
        let saved = route(&app, &request("PUT", "/api/v2/app/settings", body.as_bytes()));
        assert_eq!(saved.status(), 200, "{}", String::from_utf8_lossy(saved.body()));
        let saved: serde_json::Value = serde_json::from_slice(saved.body()).unwrap();
        assert_eq!(saved["restartRequired"], true);
        assert_eq!(saved["settings"]["vaults"][0]["name"], "Notes");
        assert!(app.setup_mode());

        let invalid = route(&app, &request("PUT", "/api/v2/app/settings", br##"{"vaults":[],"auth":null,"unknown":true}"##));
        assert_eq!(invalid.status(), 400);
    }

    fn spawn_server(
        app: App,
        listener: TcpListener,
        services: ServerServices,
        limits: TransportLimits,
    ) -> (std::net::SocketAddr, CancellationToken, thread::JoinHandle<()>) {
        let address = listener.local_addr().unwrap();
        let shutdown = CancellationToken::new();
        let server_shutdown = shutdown.clone();
        let executor = Arc::new(Executor::new());
        let server_executor = executor.clone();
        let server = thread::spawn(move || {
            async_io::block_on(executor.run(serve_listener_with_limits(
                app,
                listener,
                services,
                server_shutdown,
                server_executor,
                limits,
            ))).unwrap();
        });
        (address, shutdown, server)
    }

    #[test]
    fn listener_with_shutdown_returns_for_a_cancelled_token() {
        let root = tempfile::tempdir().unwrap();
        let app = App::new(Config {
            vaults: vec![VaultConfig {
                name: "Test".to_string(),
                path: root.path().join("vault"),
                state_path: root.path().join("state"),

            }],
            auth: None,
        })
        .unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let shutdown = CancellationToken::new();
        shutdown.cancel();

        let retained = app.clone();

        serve_listener_with_shutdown(app, listener, ServerServices::default(), shutdown).unwrap();

        let vault_id = retained.v2_bootstrap().vaults[0].vault_id.clone();
        assert!(retained.vault_by_id(&vault_id).unwrap().workers_stopped());
    }

    #[test]
    fn embedded_static_assets_are_fingerprinted_and_confined() {
        let shell = serve_static_path("/").unwrap();
        assert_eq!(shell.status(), 200);
        assert_eq!(shell.content_type(), "text/html; charset=utf-8");
        assert_eq!(shell.header("cache-control"), Some("no-cache"));
        let html = String::from_utf8_lossy(shell.body());
        let js = html.split("src=\"/assets/").nth(1).unwrap().split('"').next().unwrap();
        let css = html
            .split("href=\"/assets/")
            .filter_map(|value| value.split('"').next())
            .find(|asset| asset.starts_with("app.") && asset.ends_with(".css"))
            .unwrap();
        assert!(js.starts_with("app.") && js.ends_with(".js"));
        assert!(css.starts_with("app.") && css.ends_with(".css"));
        assert_eq!(serve_static_path(&format!("/assets/{js}")).unwrap().header("cache-control"), Some("public, max-age=31536000, immutable"));
        assert!(serve_static_path("/%2e%2e/Cargo.toml").is_err());
        assert!(serve_static_path("/../Cargo.toml").is_err());
    }

    #[test]
    fn webp_encoder_assets_are_immutable_only_under_fingerprinted_urls() {
        let encoder_urls = embedded_assets::ASSETS
            .iter()
            .map(|asset| asset.url)
            .filter(|url| url.contains("jsquash-webp"))
            .collect::<Vec<_>>();
        assert!(encoder_urls.iter().any(|url| url.ends_with("/webp_enc.wasm")));
        for url in encoder_urls {
            let directory = url.strip_prefix("/assets/jsquash-webp.").unwrap();
            let fingerprint = directory.split('/').next().unwrap();
            assert!(fingerprint.len() == 12 && fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit()), "{url}");
            assert_eq!(serve_static_path(url).unwrap().header("cache-control"), Some("public, max-age=31536000, immutable"));
        }
        assert!(serve_static_path("/assets/jsquash-webp/encode.js").is_err());
    }

    #[test]
    fn response_security_headers_are_restrictive_and_api_no_store() {
        let response = HttpResponse::json(200, &serde_json::json!({ "ok": true })).unwrap().with_no_store();
        let response = response.into_hyper();
        assert_eq!(response.headers()[CACHE_CONTROL], "no-store");
        assert_eq!(response.headers()["X-Content-Type-Options"], "nosniff");
        let csp = response.headers()["Content-Security-Policy"].to_str().unwrap();
        assert!(csp.contains("script-src 'self'"));
        assert!(csp.contains("'wasm-unsafe-eval'"));
        assert!(!csp.contains("'unsafe-eval'"));
    }

    #[test]
    fn all_v2_transport_responses_receive_version_and_build_headers() {
        let mut response = HttpResponse::json(401, &serde_json::json!({ "error": "auth_required" }))
            .unwrap()
            .with_no_store()
            .into_hyper();
        add_v2_protocol_headers(&mut response);
        assert_eq!(response.headers()["X-Tansu-Api-Version"], "2");
        assert_eq!(response.headers()["X-Tansu-Build-Id"], API_BUILD_ID);
    }

    #[test]
    fn connection_task_panics_keep_internal_error_context() {
        assert!(matches!(
            connection_task_failure(Box::new("broken connection")),
            Error::Internal(message) if message.contains("broken connection")
        ));
    }

    #[test]
    fn hyper_response_preserves_both_auth_cookies() {
        let response = HttpResponse::json(200, &serde_json::json!({ "ok": true }))
            .unwrap()
            .with_header("Set-Cookie", "__Host-tansu_session=session")
            .with_header("Set-Cookie", "__Host-tansu_csrf=csrf")
            .into_hyper();
        let cookies = response.headers().get_all("Set-Cookie").iter().collect::<Vec<_>>();
        assert_eq!(cookies.len(), 2);
        assert!(cookies.iter().any(|cookie| cookie.as_bytes().starts_with(b"__Host-tansu_session=")));
        assert!(cookies.iter().any(|cookie| cookie.as_bytes().starts_with(b"__Host-tansu_csrf=")));
    }

    #[test]
    fn parses_session_cookie_once_and_rejects_duplicates() {
        assert_eq!(parse_session_cookie(Some("other=x; __Host-tansu_session=abc" )).unwrap(), Some("abc".into()));
        assert!(parse_session_cookie(Some("__Host-tansu_session=a; __Host-tansu_session=b")).is_err());
    }

    #[test]
    fn readable_csrf_cookie_survives_reload_and_logout_clears_both_cookies() {
        let (_root, auth, session) = authenticated_test_session();
        let auth = Arc::new(auth);
        let csrf_set_cookie = csrf_cookie(&session.csrf_token);
        assert!(csrf_set_cookie.contains("Secure; Path=/; SameSite=Strict"));
        assert!(!csrf_set_cookie.contains("HttpOnly"));
        let browser_cookie = csrf_set_cookie.split(';').next().unwrap();
        let (name, csrf_token) = browser_cookie.split_once('=').unwrap();
        assert_eq!(name, "__Host-tansu_csrf");
        let cookie_header = format!(
            "__Host-tansu_session={}; {browser_cookie}",
            session.cookie_value,
        );

        let mut headers = HeaderMap::new();
        headers.insert(HOST, "notes.example.com".parse().unwrap());
        headers.insert(ORIGIN, "https://notes.example.com".parse().unwrap());
        headers.insert(COOKIE, cookie_header.parse().unwrap());
        headers.insert("X-Tansu-CSRF", csrf_token.parse().unwrap());
        let services = ServerServices { auth: Some(auth.clone()), events: None };
        let access = authorize_request(
            &Method::POST,
            &"/api/v2/vaults/vault-1/settings".parse().unwrap(),
            &headers,
            &services,
        ).unwrap();
        assert!(access.verified_session.is_some());

        headers.remove("X-Tansu-CSRF");
        assert!(matches!(
            authorize_request(
                &Method::POST,
                &"/api/v2/vaults/vault-1/settings".parse().unwrap(),
                &headers,
                &services,
            ),
            Err(V2ApiErrorKind::CsrfRejected)
        ));

        let response = handle_auth_route_sync(
            "POST",
            "/api/v2/auth/logout",
            &[],
            &auth,
            Some(&session.cookie_value),
            access.verified_session,
            "request-test",
        );
        let cookies = response.headers.iter()
            .filter(|(header, _)| header.eq_ignore_ascii_case("set-cookie"))
            .map(|(_, value)| value.as_str())
            .collect::<Vec<_>>();
        assert_eq!(cookies.len(), 2);
        assert!(cookies.iter().any(|value| value.starts_with("__Host-tansu_session=") && value.contains("Max-Age=0")));
        assert!(cookies.iter().any(|value| value.starts_with("__Host-tansu_csrf=") && value.contains("Max-Age=0")));
    }

    #[test]
    fn auth_session_route_is_available_before_bootstrap_and_requires_a_session() {
        let (_root, auth, session) = authenticated_test_session();
        let auth = Arc::new(auth);
        let services = ServerServices { auth: Some(auth.clone()), events: None };
        let mut headers = HeaderMap::new();
        headers.insert(HOST, "notes.example.com".parse().unwrap());
        headers.insert(ORIGIN, "https://notes.example.com".parse().unwrap());
        assert!(authorize_request(
            &Method::GET,
            &"/api/v2/health".parse().unwrap(),
            &headers,
            &services,
        ).is_ok());
        headers.insert(ORIGIN, "https://attacker.example".parse().unwrap());
        assert!(matches!(
            authorize_request(
                &Method::GET,
                &"/api/v2/health".parse().unwrap(),
                &headers,
                &services,
            ),
            Err(V2ApiErrorKind::OriginRejected)
        ));
        headers.insert(ORIGIN, "https://notes.example.com".parse().unwrap());
        assert!(matches!(
            authorize_request(
                &Method::GET,
                &"/api/v2/auth/session".parse().unwrap(),
                &headers,
                &services,
            ),
            Err(V2ApiErrorKind::AuthRequired)
        ));
        let bootstrap_access = authorize_request(
            &Method::GET,
            &"/api/v2/bootstrap".parse().unwrap(),
            &headers,
            &services,
        );
        assert!(matches!(bootstrap_access, Err(V2ApiErrorKind::AuthRequired)));

        let mut request_headers = headers;
        request_headers.insert(COOKIE, format!("__Host-tansu_session={}", session.cookie_value).parse().unwrap());
        let access = authorize_request(
            &Method::GET,
            &"/api/v2/auth/session".parse().unwrap(),
            &request_headers,
            &services,
        ).unwrap();
        let session_response = handle_auth_route_sync(
            "GET",
            "/api/v2/auth/session",
            &[],
            &auth,
            Some(&session.cookie_value),
            access.verified_session,
            "request-test",
        );
        assert_eq!(session_response.status(), 200);
        let body: serde_json::Value = serde_json::from_slice(session_response.body()).unwrap();
        assert_eq!(body["authenticated"], true);
        assert!(body["expiresAt"].as_u64().is_some());
    }

    #[test]
    fn stale_session_cookie_does_not_block_passkey_login_recovery() {
        let (_root, auth, session) = authenticated_test_session();
        auth.revoke_session(&session.cookie_value).unwrap();
        let services = ServerServices { auth: Some(Arc::new(auth)), events: None };
        let mut headers = HeaderMap::new();
        headers.insert(HOST, "notes.example.com".parse().unwrap());
        headers.insert(ORIGIN, "https://notes.example.com".parse().unwrap());
        headers.insert(
            COOKIE,
            format!("__Host-tansu_session={}", session.cookie_value).parse().unwrap(),
        );

        for path in ["/api/v2/auth/login/options", "/api/v2/auth/login/finish"] {
            let access = authorize_request(
                &Method::POST,
                &path.parse().unwrap(),
                &headers,
                &services,
            ).unwrap();
            assert!(access.session_cookie.is_none());
            assert!(access.verified_session.is_none());
        }
    }

    #[test]
    fn enrollment_options_allow_initial_capability_and_require_csrf_for_owner_session() {
        let (_root, auth, session) = authenticated_test_session();
        let auth = Arc::new(auth);
        let services = ServerServices { auth: Some(auth), events: None };
        let uri = "/api/v2/auth/enrollment/options".parse().unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(HOST, "notes.example.com".parse().unwrap());
        headers.insert(ORIGIN, "https://notes.example.com".parse().unwrap());

        let initial_enrollment = authorize_request(&Method::POST, &uri, &headers, &services).unwrap();
        assert!(initial_enrollment.verified_session.is_none());

        headers.insert(COOKIE, format!("__Host-tansu_session={}", session.cookie_value).parse().unwrap());
        assert!(matches!(
            authorize_request(&Method::POST, &uri, &headers, &services),
            Err(V2ApiErrorKind::CsrfRejected)
        ));

        headers.insert("X-Tansu-CSRF", session.csrf_token.parse().unwrap());
        let owner_registration = authorize_request(&Method::POST, &uri, &headers, &services).unwrap();
        assert!(owner_registration.verified_session.is_some());
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
    fn event_query_after_takes_precedence_over_last_event_id() {
        let mut headers = HeaderMap::new();
        headers.insert("Last-Event-ID", "5".parse().unwrap());
        let uri = "/api/v2/vaults/vault%2D1/events?after=7".parse().unwrap();
        assert_eq!(event_vault_id(&uri).as_deref(), Some("vault-1"));
        assert_eq!(event_after_version(&uri, &headers).unwrap(), Some(7));

        let uri = "/api/v2/vaults/vault-1/events".parse().unwrap();
        assert_eq!(event_after_version(&uri, &headers).unwrap(), Some(5));

        let duplicate = "/api/v2/vaults/vault-1/events?after=4&after=5".parse().unwrap();
        assert!(matches!(
            event_after_version(&duplicate, &headers),
            Err(V2ApiErrorKind::BadRequest { .. })
        ));
    }

    #[test]
    fn event_route_maps_missing_vaults_to_typed_not_found() {
        let root = tempfile::tempdir().unwrap();
        let vault_path = root.path().join("vault");
        std::fs::create_dir_all(&vault_path).unwrap();
        let app = App::new(Config {
            vaults: vec![VaultConfig {
                name: "Test".into(),
                path: vault_path,
                state_path: root.path().join("state"),

            }],
            auth: None,
        }).unwrap();
        let server_instance_id = app.server_instance_id().to_string();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let (address, shutdown, server) = spawn_server(
            app,
            listener,
            ServerServices {
                auth: None,
                events: Some(Arc::new(LookupErrorEventSource)),
            },
            TransportLimits::default(),
        );

        let send = |vault_id: &str| {
            let mut stream = TcpStream::connect(address).unwrap();
            write!(
                stream,
                "GET /api/v2/vaults/{vault_id}/events HTTP/1.1\r\nHost: localhost\r\nX-Tansu-Server-Instance: {server_instance_id}\r\nConnection: close\r\n\r\n"
            ).unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            response
        };

        let not_found = send("missing");
        assert!(not_found.starts_with("HTTP/1.1 404"), "{not_found}");
        assert!(not_found.contains("vault_not_found"), "{not_found}");
        assert!(not_found.to_ascii_lowercase().contains("x-tansu-api-version: 2"), "{not_found}");

        let internal = send("broken");
        assert!(internal.starts_with("HTTP/1.1 500"), "{internal}");
        assert!(internal.contains("\"code\":\"internal\""), "{internal}");

        shutdown.cancel();
        server.join().unwrap();
    }

    #[test]
    fn accepts_http2_prior_knowledge_requests() {
        let root = tempfile::tempdir().unwrap();
        let vault_path = root.path().join("vault");
        std::fs::create_dir_all(&vault_path).unwrap();
        let app = App::new(Config {
            vaults: vec![VaultConfig {
                name: "Test".into(),
                path: vault_path,
                state_path: root.path().join("state"),

            }],
            auth: None,
        }).unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let (address, shutdown, server) = spawn_server(
            app,
            listener,
            ServerServices::default(),
            TransportLimits::default(),
        );
        let executor = Arc::new(Executor::new());
        let connection_executor = executor.clone();
        let (status, api_version, body) = async_io::block_on(executor.run(async move {
            let stream = async_net::TcpStream::connect(address).await.unwrap();
            let io = PrefixedIo::new(stream, Vec::new());
            let (mut sender, connection) = hyper::client::conn::http2::handshake(
                ServerExecutor(connection_executor.clone()),
                io,
            ).await.unwrap();
            connection_executor.spawn(async move {
                let _ = connection.await;
            }).detach();
            let request = Request::builder()
                .method(Method::GET)
                .uri("/api/v2/health")
                .header(HOST, "localhost")
                .body(Full::new(Bytes::new()))
                .unwrap();
            let response = sender.send_request(request).await.unwrap();
            let status = response.status();
            let api_version = response.headers()["X-Tansu-Api-Version"].clone();
            let body = response.into_body().collect().await.unwrap().to_bytes();
            (status, api_version, body)
        }));
        assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
        assert_eq!(api_version, "2");
        assert!(std::str::from_utf8(&body).unwrap().contains("\"ok\":true"));
        shutdown.cancel();
        server.join().unwrap();
    }

    #[test]
    fn legacy_api_requests_fail_with_version_error_before_mutating() {
        let root = tempfile::tempdir().unwrap();
        let vault_path = root.path().join("vault");
        let state_path = root.path().join("state");
        std::fs::create_dir_all(&vault_path).unwrap();
        let app = App::new(Config {
            vaults: vec![VaultConfig {
                name: "Test".into(),
                path: vault_path.clone(),
                state_path,
            }],
            auth: None,
        }).unwrap();
        let response = route(&app, &HttpRequest {
            method: "POST".to_string(),
            path: "/api/notes".to_string(),
            headers: vec![("X-Tansu-Vault".to_string(), "0".to_string())],
            body: br##"{"path":"legacy.md","content":"# Legacy"}"##.to_vec(),
        });
        assert_eq!(response.status(), 409);
        assert!(String::from_utf8_lossy(response.body()).contains("api_version_unsupported"));
        assert!(!vault_path.join("legacy.md").exists());
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
            }],
            auth: None,
        }).unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let (address, shutdown, server) = spawn_server(
            app,
            listener,
            ServerServices::default(),
            TransportLimits {
                max_body_bytes: 8,
                max_connections: 4,
                max_blocking_requests: 1,
                request_body_duration: Duration::from_millis(60),
                connection_duration: Duration::from_secs(2),
            },
        );

        let mut oversized = TcpStream::connect(address).unwrap();
        oversized.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        oversized.write_all(b"POST /api/v2/vaults/vault-1/notes HTTP/1.1\r\nHost: localhost\r\nContent-Length: 9\r\n\r\n").unwrap();
        let mut oversized_response = String::new();
        oversized.read_to_string(&mut oversized_response).unwrap();
        assert!(oversized_response.starts_with("HTTP/1.1 413"));

        let mut slow = TcpStream::connect(address).unwrap();
        slow.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        slow.write_all(b"POST /api/v2/vaults/vault-1/notes HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\na").unwrap();
        let mut slow_response = String::new();
        slow.read_to_string(&mut slow_response).unwrap();
        assert!(slow_response.starts_with("HTTP/1.1 408"));

        let mut malformed = TcpStream::connect(address).unwrap();
        malformed.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        malformed.write_all(b"GET / HTTP/1.1\r\nHost localhost\r\n\r\n").unwrap();
        let mut malformed_response = String::new();
        let _ = malformed.read_to_string(&mut malformed_response);
        assert!(malformed_response.starts_with("HTTP/1.1 400"));

        let mut h2c = TcpStream::connect(address).unwrap();
        h2c.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        h2c.write_all(b"GET /api/v2/health HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade, HTTP2-Settings\r\nUpgrade: h2c\r\nHTTP2-Settings: AAQAAP__\r\n\r\n").unwrap();
        let mut h2c_response = String::new();
        h2c.read_to_string(&mut h2c_response).unwrap();
        assert!(h2c_response.starts_with("HTTP/1.1 400"), "{h2c_response}");
        assert!(h2c_response.contains("bad_request"), "{h2c_response}");

        shutdown.cancel();
        server.join().unwrap();
    }

    #[derive(Clone)]
    struct MockEventSource;

    struct MockEventStream {
        receiver: std::sync::mpsc::Receiver<EventEnvelope>,
        capacity: usize,
        dropped: Option<std::sync::mpsc::Sender<()>>,
        started: Option<std::sync::mpsc::Sender<()>>,
    }

    impl EventSubscriptionStream for MockEventStream {
        fn capacity(&self) -> usize {
            self.capacity
        }

        fn recv_timeout(
            &mut self,
            timeout: Duration,
        ) -> std::result::Result<EventEnvelope, std::sync::mpsc::RecvTimeoutError> {
            if let Some(started) = self.started.take() {
                let _ = started.send(());
            }
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
        ) -> std::result::Result<EventSubscription, EventSourceError> {
            let (_sender, events) = std::sync::mpsc::sync_channel(2);
            Ok(EventSubscription {
                replay: Vec::new(),
                current_version: 0,
                resync_required: false,
                events: Box::new(MockEventStream { receiver: events, capacity: 2, dropped: None, started: None }),
            })
        }
    }

    #[derive(Clone)]
    struct LookupErrorEventSource;

    impl EventSource for LookupErrorEventSource {
        fn subscribe(&self, vault_id: &str, _: Option<u64>) -> std::result::Result<EventSubscription, EventSourceError> {
            match vault_id {
                "missing" => Err(EventSourceError::VaultNotFound),
                _ => Err(EventSourceError::Internal("event storage unavailable".to_string())),
            }
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
        let now = unix_time_seconds().unwrap();
        let (capability, _) = auth.create_enrollment_capability(now, 300).unwrap();
        let challenge = tansu_webauthn::RegChallenge {
            challenge: "challenge".into(),
            user_id: "owner".into(),
            username: "owner".into(),
        };
        let ticket = auth.begin_registration(&challenge, Some(&capability), None, now + 1, 300).unwrap();
        let session = auth.finish_registration(&ticket.id, now + 2, |_| Ok(tansu_webauthn::StoredCredential {
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
        let shutdown = CancellationToken::new();
        let (event_sender, events) = std::sync::mpsc::sync_channel(2);
        drop(event_sender);
        let replay = async_io::block_on(async {
            sse_body(
                EventSubscription {
                    replay: vec![event(5), event(6)],
                    current_version: 6,
                    resync_required: false,
                    events: Box::new(MockEventStream { receiver: events, capacity: 2, dropped: None, started: None }),
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
        let resync = async_io::block_on(async {
            sse_body(
                EventSubscription {
                    replay: Vec::new(),
                    current_version: 8,
                    resync_required: true,
                    events: Box::new(MockEventStream { receiver: events, capacity: 2, dropped: None, started: None }),
                },
                shutdown.clone(),
                None,
                Duration::from_secs(2),
            ).collect().await.unwrap().to_bytes()
        });
        let resync = String::from_utf8_lossy(&resync);
        assert!(resync.contains("id: 8\nevent: resyncRequired\ndata: {\"eventVersion\":8,\"resyncRequired\":true,\"update\":{\"kind\":\"resyncRequired\"}}"));
    }

    #[test]
    fn sse_disconnect_releases_the_source_subscription() {
        let shutdown = CancellationToken::new();
        let (_event_sender, events) = std::sync::mpsc::sync_channel(2);
        let (dropped_sender, dropped_receiver) = std::sync::mpsc::channel();
        let body = sse_body(
            EventSubscription {
                replay: Vec::new(),
                current_version: 0,
                resync_required: false,
                events: Box::new(MockEventStream {
                    receiver: events,
                    capacity: 2,
                    dropped: Some(dropped_sender),
                    started: None,
                }),
            },
            shutdown,
            None,
            Duration::from_secs(2),
        );
        drop(body);
        dropped_receiver.recv_timeout(Duration::from_secs(2)).unwrap();
    }

    #[test]
    fn open_sse_streams_close_on_session_revocation_and_expiry() {
        let (_root, auth, session) = authenticated_test_session();
        let shutdown = CancellationToken::new();
        let (_event_sender, events) = std::sync::mpsc::sync_channel(2);
        let lease = auth.session_lease(&session.cookie_value, 13).unwrap();
        let expiry = StreamAuthorization {
            expires_at: 0,
            revoked: lease.revoked.clone(),
            _lease: lease,
        };
        let expired = async_io::block_on(async {
            let body = sse_body(
                EventSubscription {
                    replay: Vec::new(),
                    current_version: 0,
                    resync_required: false,
                    events: Box::new(MockEventStream { receiver: events, capacity: 2, dropped: None, started: None }),
                },
                shutdown.clone(),
                Some(expiry),
                Duration::from_secs(2),
            );
            body.collect().await.unwrap().to_bytes()
        });
        assert!(expired.is_empty());

        let (_event_sender, events) = std::sync::mpsc::sync_channel(2);
        let (started_sender, started_receiver) = std::sync::mpsc::channel();
        let lease = auth.session_lease(&session.cookie_value, 13).unwrap();
        let revocation = StreamAuthorization {
            expires_at: lease.expires_at,
            revoked: lease.revoked.clone(),
            _lease: lease,
        };
        let body = sse_body(
            EventSubscription {
                replay: Vec::new(),
                current_version: 0,
                resync_required: false,
                events: Box::new(MockEventStream {
                    receiver: events,
                    capacity: 2,
                    dropped: None,
                    started: Some(started_sender),
                }),
            },
            shutdown.clone(),
            Some(revocation),
            Duration::from_secs(2),
        );
        let executor = Executor::new();
        let revoked = async_io::block_on(executor.run(async {
            let stream = executor.spawn(body.collect());
            blocking::unblock(move || started_receiver.recv_timeout(Duration::from_secs(2)))
                .await.unwrap();
            auth.revoke_session(&session.cookie_value).unwrap();
            stream.await.unwrap().to_bytes()
        }));
        assert!(revoked.is_empty());
    }

    #[test]
    fn sse_stream_ends_when_server_shutdown_is_signaled() {
        let shutdown = CancellationToken::new();
        let (_event_sender, events) = std::sync::mpsc::sync_channel(2);
        let (started_sender, started_receiver) = std::sync::mpsc::channel();
        let body = sse_body(
            EventSubscription {
                replay: Vec::new(),
                current_version: 0,
                resync_required: false,
                events: Box::new(MockEventStream {
                    receiver: events,
                    capacity: 2,
                    dropped: None,
                    started: Some(started_sender),
                }),
            },
            shutdown.clone(),
            None,
            Duration::from_secs(2),
        );
        let executor = Executor::new();
        let closed = async_io::block_on(executor.run(async {
            let stream = executor.spawn(body.collect());
            blocking::unblock(move || started_receiver.recv_timeout(Duration::from_secs(2)))
                .await.unwrap();
            shutdown.cancel();
            stream.await.unwrap().to_bytes()
        }));
        assert!(closed.is_empty());
    }
}
