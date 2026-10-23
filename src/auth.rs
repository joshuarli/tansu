use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::ffi::OsString;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use blake3::hash as blake3_hash;
use rusqlite::backup::Backup;
use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior, params};
use rustix::fs::{AtFlags, Mode, OFlags, RenameFlags, openat, renameat_with, unlinkat};
use serde::{Deserialize, Serialize};
use tansu_webauthn::{AuthChallenge, AuthenticationFinish, CounterResult, RegChallenge, StoredCredential};

use crate::CancellationToken;

const MAX_PENDING_CEREMONIES: i64 = 256;
pub const MAX_CREDENTIALS: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthError {
    InvalidRequest(String),
    Unauthorized,
    OriginRejected,
    CsrfRejected,
    Expired,
    CeremonyUsed,
    CeremonyLimit,
    CredentialLimit,
    Storage(String),
    WebAuthn(String),
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidRequest(message) | Self::Storage(message) | Self::WebAuthn(message) => f.write_str(message),
            Self::Unauthorized => f.write_str("authentication required"),
            Self::OriginRejected => f.write_str("request origin rejected"),
            Self::CsrfRejected => f.write_str("CSRF token rejected"),
            Self::Expired => f.write_str("authentication state expired"),
            Self::CeremonyUsed => f.write_str("ceremony already used"),
            Self::CeremonyLimit => f.write_str("too many pending authentication ceremonies"),
            Self::CredentialLimit => write!(f, "passkey limit of {MAX_CREDENTIALS} reached; remove a passkey before enrolling another"),
        }
    }
}

impl std::error::Error for AuthError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthPolicy {
    LoopbackDevelopment,
    Authenticated {
        external_origin: String,
        host: String,
        rp_id: String,
        rp_name: String,
    },
}

impl AuthPolicy {
    pub fn loopback_development() -> Self {
        Self::LoopbackDevelopment
    }

    pub fn authenticated(external_origin: &str, rp_id: &str, rp_name: &str) -> Result<Self, AuthError> {
        let (scheme, host) = split_origin(external_origin)?;
        if scheme != "https" {
            return Err(AuthError::InvalidRequest("authenticated mode requires an HTTPS origin".into()));
        }
        let rp_id = rp_id.to_ascii_lowercase();
        let hostname = match host.strip_prefix('[') {
            Some(bracketed) => bracketed.split_once(']').map_or(bracketed, |(address, _)| address),
            None => host.split_once(':').map_or(host.as_str(), |(name, _)| name),
        };
        let exact_origin_host = hostname == rp_id;
        let origin_suffix = hostname.strip_suffix(&rp_id).is_some_and(|prefix| prefix.ends_with('.'));
        if !exact_origin_host && !origin_suffix {
            return Err(AuthError::InvalidRequest(
                "RP ID must match the origin host or be a registrable domain suffix".into(),
            ));
        }
        if !is_valid_rp_id_domain(&rp_id) {
            return Err(AuthError::InvalidRequest(
                "RP ID must be a registrable domain, localhost, or a single-label local name, not a public suffix or IP address".into(),
            ));
        }
        Ok(Self::Authenticated {
            external_origin: external_origin.to_string(),
            host,
            rp_id,
            rp_name: rp_name.to_string(),
        })
    }

    pub fn rp(&self) -> Option<(&str, &str, &str)> {
        match self {
            Self::LoopbackDevelopment => None,
            Self::Authenticated { external_origin, host: _, rp_id, rp_name } => {
                Some((rp_id, external_origin, rp_name))
            }
        }
    }

    fn persisted_identity(&self) -> (&str, &str) {
        match self {
            Self::LoopbackDevelopment => ("", ""),
            Self::Authenticated { external_origin, rp_id, .. } => (external_origin, rp_id),
        }
    }

    fn validate_origin_host(&self, host: &str, origin: Option<&str>, state_changing: bool) -> Result<(), AuthError> {
        match self {
            Self::Authenticated { external_origin, host: expected_host, .. } => {
                if !host.eq_ignore_ascii_case(expected_host) || origin.is_some_and(|origin| origin != external_origin) {
                    return Err(AuthError::OriginRejected);
                }
                if state_changing && origin != Some(external_origin) {
                    return Err(AuthError::OriginRejected);
                }
            }
            Self::LoopbackDevelopment => {
                if !is_loopback_host(&host.to_ascii_lowercase()) {
                    return Err(AuthError::OriginRejected);
                }
                let Some(origin) = origin else {
                    if state_changing {
                        return Err(AuthError::OriginRejected);
                    }
                    return Ok(());
                };
                let (scheme, origin_host) = split_origin(origin).map_err(|_| AuthError::OriginRejected)?;
                if scheme != "http" || !is_loopback_host(&origin_host) || !host.eq_ignore_ascii_case(&origin_host) {
                    return Err(AuthError::OriginRejected);
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionMaterial {
    pub cookie_value: String,
    pub csrf_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedSession {
    pub verified_at: u64,
    pub expires_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestAction {
    Read,
    StateChange,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionRequirement {
    Optional,
    Required,
}

pub struct AuthRequestContext<'a> {
    pub host: &'a str,
    pub origin: Option<&'a str>,
    pub action: RequestAction,
    pub session_cookie: Option<&'a str>,
    pub csrf_token: Option<&'a str>,
    pub session_requirement: SessionRequirement,
    pub now: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CeremonyTicket {
    pub id: String,
    pub expires_at: u64,
}

#[derive(Clone)]
pub struct SessionLease {
    pub(crate) expires_at: u64,
    pub(crate) revoked: CancellationToken,
    _registration: Arc<LeaseRegistration>,
}

struct ActiveLease {
    revoked: CancellationToken,
    leases: usize,
}

struct LeaseRegistration {
    session_hash: Vec<u8>,
    active_leases: std::sync::Weak<Mutex<HashMap<Vec<u8>, ActiveLease>>>,
}

impl Drop for LeaseRegistration {
    fn drop(&mut self) {
        let Some(active_leases) = self.active_leases.upgrade() else { return; };
        let mut active_leases = active_leases.lock().expect("lease mutex poisoned");
        if let Some(active) = active_leases.get_mut(&self.session_hash) {
            active.leases = active.leases.saturating_sub(1);
            if active.leases == 0 {
                active_leases.remove(&self.session_hash);
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredRegistration {
    state: RegChallenge,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredAuthentication {
    state: AuthChallenge,
}

#[derive(Debug)]
struct CeremonyRow {
    kind: String,
    state: Vec<u8>,
    expires_at: u64,
    capability_hash: Option<Vec<u8>>,
    session_hash: Option<Vec<u8>>,
}

pub struct AuthStore {
    connection: Mutex<Connection>,
    policy: AuthPolicy,
    session_ttl_secs: u64,
    recent_verification_secs: u64,
    active_leases: Arc<Mutex<HashMap<Vec<u8>, ActiveLease>>>,
    _process_lock: File,
}

impl AuthStore {
    pub fn open(
        state_directory: impl AsRef<Path>,
        policy: AuthPolicy,
        session_ttl_secs: u64,
        recent_verification_secs: u64,
    ) -> Result<Self, AuthError> {
        let directory = secure_auth_directory(state_directory.as_ref())?;
        let process_lock = acquire_process_lock(&directory)?;
        let path = directory.join("auth.db");
        secure_file(&path)?;
        validate_database_sidecars(&path)?;
        let connection = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(storage)?;
        connection.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             CREATE TABLE IF NOT EXISTS enrollment_capabilities (
                 token_hash BLOB PRIMARY KEY,
                 expires_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS sessions (
                 token_hash BLOB PRIMARY KEY,
                 csrf_hash BLOB NOT NULL,
                 created_at INTEGER NOT NULL,
                 verified_at INTEGER NOT NULL,
                 expires_at INTEGER NOT NULL,
                 revoked INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS ceremonies (
                 id_hash BLOB PRIMARY KEY,
                 kind TEXT NOT NULL,
                 state BLOB NOT NULL,
                 expires_at INTEGER NOT NULL,
                 capability_hash BLOB,
                 session_hash BLOB
             );
             CREATE TABLE IF NOT EXISTS credentials (
                 credential_id BLOB PRIMARY KEY,
                 value BLOB NOT NULL
             );
             CREATE TABLE IF NOT EXISTS credential_counter_anomalies (
                 credential_id BLOB PRIMARY KEY,
                 previous_count INTEGER NOT NULL CHECK(previous_count BETWEEN 0 AND 4294967295),
                 observed_count INTEGER NOT NULL CHECK(observed_count BETWEEN 0 AND previous_count),
                 backup_eligible INTEGER NOT NULL CHECK(backup_eligible IN (0, 1)),
                 recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0)
             );
             CREATE TABLE IF NOT EXISTS auth_identity (
                 singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                 external_origin TEXT NOT NULL,
                 rp_id TEXT NOT NULL
             );",
        ).map_err(storage)?;
        bind_auth_identity(&connection, &policy)?;
        Ok(Self {
            connection: Mutex::new(connection),
            policy,
            session_ttl_secs,
            recent_verification_secs,
            active_leases: Arc::new(Mutex::new(HashMap::new())),
            _process_lock: process_lock,
        })
    }

    pub fn policy(&self) -> &AuthPolicy {
        &self.policy
    }

    pub fn validate_request(&self, request: AuthRequestContext<'_>) -> Result<Option<VerifiedSession>, AuthError> {
        let state_changing = request.action == RequestAction::StateChange;
        self.policy.validate_origin_host(request.host, request.origin, state_changing)?;
        let Some(cookie) = request.session_cookie else {
            if request.session_requirement == SessionRequirement::Required {
                return Err(AuthError::Unauthorized);
            }
            return Ok(None);
        };
        let session_hash = token_hash(cookie)?;
        let connection = self.connection.lock().expect("auth DB mutex poisoned");
        let session = read_session(&connection, &session_hash)?;
        let Some(session) = session else {
            return Err(AuthError::Unauthorized);
        };
        if session.revoked || session.expires_at <= request.now {
            return Err(AuthError::Unauthorized);
        }
        if state_changing {
            let csrf_token = request.csrf_token.ok_or(AuthError::CsrfRejected)?;
            let csrf_hash = token_hash(csrf_token).map_err(|_| AuthError::CsrfRejected)?;
            if !constant_time_eq(&csrf_hash, &session.csrf_hash) {
                return Err(AuthError::CsrfRejected);
            }
        }
        Ok(Some(VerifiedSession {
            verified_at: session.verified_at,
            expires_at: session.expires_at,
        }))
    }

    pub fn create_enrollment_capability(&self, now: u64, ttl_secs: u64) -> Result<(String, u64), AuthError> {
        let capability = random_token()?;
        let capability_hash = token_hash(&capability)?;
        let expires_at = now.checked_add(ttl_secs).ok_or_else(|| AuthError::InvalidRequest("capability expiry overflow".into()))?;
        let mut connection = self.connection.lock().expect("auth DB mutex poisoned");
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(storage)?;
        if credential_count(&transaction)? != 0 {
            return Err(AuthError::InvalidRequest("initial enrollment is already complete".into()));
        }
        transaction.execute("DELETE FROM enrollment_capabilities", []).map_err(storage)?;
        transaction.execute(
            "INSERT INTO enrollment_capabilities(token_hash, expires_at) VALUES (?1, ?2)",
            params![capability_hash, to_i64(expires_at)?],
        ).map_err(storage)?;
        transaction.commit().map_err(storage)?;
        Ok((capability, expires_at))
    }

    pub fn begin_registration(
        &self,
        state: &RegChallenge,
        capability: Option<&str>,
        session_cookie: Option<&str>,
        now: u64,
        ttl_secs: u64,
    ) -> Result<CeremonyTicket, AuthError> {
        if !matches!(self.policy, AuthPolicy::Authenticated { .. }) {
            return Err(AuthError::InvalidRequest("passkeys are disabled in loopback development mode".into()));
        }
        let ceremony_id = random_token()?;
        let id_hash = token_hash(&ceremony_id)?;
        let expires_at = now.checked_add(ttl_secs).ok_or_else(|| AuthError::InvalidRequest("ceremony expiry overflow".into()))?;
        let mut connection = self.connection.lock().expect("auth DB mutex poisoned");
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(storage)?;
        let credentials = credential_count(&transaction)?;
        let (capability_hash, session_hash) = if credentials != 0 {
            let session_cookie = session_cookie.ok_or(AuthError::Unauthorized)?;
            let session_hash = token_hash(session_cookie)?;
            let session = read_session(&transaction, &session_hash)?.ok_or(AuthError::Unauthorized)?;
            if session.revoked || session.expires_at <= now || !session.verified_at.checked_add(self.recent_verification_secs).is_some_and(|deadline| deadline >= now) {
                return Err(AuthError::Unauthorized);
            }
            if credentials >= MAX_CREDENTIALS as u64 {
                return Err(AuthError::CredentialLimit);
            }
            (None, Some(session_hash))
        } else {
            let capability = capability.ok_or(AuthError::Unauthorized)?;
            let capability_hash = token_hash(capability)?;
            let expires_at: Option<i64> = transaction.query_row(
                "SELECT expires_at FROM enrollment_capabilities WHERE token_hash = ?1",
                params![capability_hash],
                |row| row.get(0),
            ).optional().map_err(storage)?;
            if expires_at.is_none_or(|expires_at| expires_at as u64 <= now) {
                return Err(AuthError::Unauthorized);
            }
            (Some(capability_hash), None)
        };
        let pending_ceremonies = prune_expired_ceremonies(&transaction, now)?;
        if pending_ceremonies >= MAX_PENDING_CEREMONIES {
            transaction.commit().map_err(storage)?;
            return Err(AuthError::CeremonyLimit);
        }
        let state = serde_json::to_vec(&StoredRegistration { state: state.clone() }).map_err(storage)?;
        transaction.execute(
            "INSERT INTO ceremonies(id_hash, kind, state, expires_at, capability_hash, session_hash) VALUES (?1, 'registration', ?2, ?3, ?4, ?5)",
            params![id_hash, state, to_i64(expires_at)?, capability_hash, session_hash],
        ).map_err(storage)?;
        transaction.commit().map_err(storage)?;
        Ok(CeremonyTicket { id: ceremony_id, expires_at })
    }

    pub fn finish_registration<F>(
        &self,
        ceremony_id: &str,
        now: u64,
        finish: F,
    ) -> Result<Option<SessionMaterial>, AuthError>
    where
        F: FnOnce(&RegChallenge) -> Result<StoredCredential, AuthError>,
    {
        let id_hash = token_hash(ceremony_id)?;
        let mut connection = self.connection.lock().expect("auth DB mutex poisoned");
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(storage)?;
        let row = read_ceremony(&transaction, &id_hash)?;
        let Some(row) = row else { return Err(AuthError::CeremonyUsed); };
        if row.kind != "registration" {
            transaction.execute("DELETE FROM ceremonies WHERE id_hash = ?1", params![id_hash]).map_err(storage)?;
            transaction.commit().map_err(storage)?;
            return Err(AuthError::InvalidRequest("wrong ceremony type".into()));
        }
        let state: StoredRegistration = serde_json::from_slice(&row.state).map_err(storage)?;
        transaction.execute("DELETE FROM ceremonies WHERE id_hash = ?1", params![id_hash]).map_err(storage)?;
        let capability_expiry = if let Some(capability_hash) = &row.capability_hash {
            transaction.query_row(
                "SELECT expires_at FROM enrollment_capabilities WHERE token_hash = ?1",
                params![capability_hash],
                |row| row.get::<_, i64>(0),
            ).optional().map_err(storage)?
        } else {
            None
        };
        if let Some(capability_hash) = &row.capability_hash {
            transaction.execute("DELETE FROM enrollment_capabilities WHERE token_hash = ?1", params![capability_hash]).map_err(storage)?;
        }
        let result = if row.expires_at <= now {
            Err(AuthError::Expired)
        } else if row.capability_hash.is_some() {
            if capability_expiry.is_none_or(|expires_at| expires_at as u64 <= now) {
                Err(AuthError::Expired)
            } else {
                finish(&state.state)
            }
        } else if let Some(session_hash) = &row.session_hash {
            if session_authorized(&transaction, session_hash, now, self.recent_verification_secs)? {
                finish(&state.state)
            } else {
                Err(AuthError::Unauthorized)
            }
        } else {
            Err(AuthError::Unauthorized)
        };
        let result = match result {
            Ok(credential) => {
                if !credential_exists(&transaction, &credential.cred_id)? && credential_count(&transaction)? >= MAX_CREDENTIALS as u64 {
                    transaction.commit().map_err(storage)?;
                    return Err(AuthError::CredentialLimit);
                }
                store_credential(&transaction, &credential)?;
                if row.capability_hash.is_some() {
                    Some(create_session(&transaction, now, self.session_ttl_secs)?)
                } else {
                    None
                }
            }
            Err(error) => {
                transaction.commit().map_err(storage)?;
                return Err(error);
            }
        };
        transaction.commit().map_err(storage)?;
        Ok(result)
    }

    pub fn begin_authentication(&self, state: &AuthChallenge, now: u64, ttl_secs: u64) -> Result<CeremonyTicket, AuthError> {
        let ceremony_id = random_token()?;
        let id_hash = token_hash(&ceremony_id)?;
        let expires_at = now.checked_add(ttl_secs).ok_or_else(|| AuthError::InvalidRequest("ceremony expiry overflow".into()))?;
        let mut connection = self.connection.lock().expect("auth DB mutex poisoned");
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(storage)?;
        let pending_ceremonies = prune_expired_ceremonies(&transaction, now)?;
        if pending_ceremonies >= MAX_PENDING_CEREMONIES {
            transaction.commit().map_err(storage)?;
            return Err(AuthError::CeremonyLimit);
        }
        let state = serde_json::to_vec(&StoredAuthentication { state: state.clone() }).map_err(storage)?;
        transaction.execute(
            "INSERT INTO ceremonies(id_hash, kind, state, expires_at) VALUES (?1, 'authentication', ?2, ?3)",
            params![id_hash, state, to_i64(expires_at)?],
        ).map_err(storage)?;
        transaction.commit().map_err(storage)?;
        Ok(CeremonyTicket { id: ceremony_id, expires_at })
    }

    pub fn finish_authentication<F>(
        &self,
        ceremony_id: &str,
        now: u64,
        finish: F,
    ) -> Result<SessionMaterial, AuthError>
    where
        F: FnOnce(&AuthChallenge, &[StoredCredential]) -> Result<AuthenticationFinish, AuthError>,
    {
        let id_hash = token_hash(ceremony_id)?;
        let mut connection = self.connection.lock().expect("auth DB mutex poisoned");
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(storage)?;
        let row = read_ceremony(&transaction, &id_hash)?;
        let Some(row) = row else { return Err(AuthError::CeremonyUsed); };
        if row.kind != "authentication" {
            transaction.execute("DELETE FROM ceremonies WHERE id_hash = ?1", params![id_hash]).map_err(storage)?;
            transaction.commit().map_err(storage)?;
            return Err(AuthError::InvalidRequest("wrong ceremony type".into()));
        }
        let state: StoredAuthentication = serde_json::from_slice(&row.state).map_err(storage)?;
        transaction.execute("DELETE FROM ceremonies WHERE id_hash = ?1", params![id_hash]).map_err(storage)?;
        let (result, credentials) = if row.expires_at <= now {
            (Err(AuthError::Expired), Vec::new())
        } else {
            let credentials = read_credentials(&transaction)?;
            (finish(&state.state, &credentials), credentials)
        };
        let result = match result {
            Ok(mut finish) => {
                if !state.state.allowed_credential_ids.iter().any(|credential_id| credential_id == &finish.credential.cred_id) {
                    transaction.commit().map_err(storage)?;
                    return Err(AuthError::Unauthorized);
                }
                let Some(stored_credential) = credentials.iter().find(|credential| credential.cred_id == finish.credential.cred_id) else {
                    transaction.commit().map_err(storage)?;
                    return Err(AuthError::Unauthorized);
                };
                match finish.counter {
                    CounterResult::NonIncreasing { .. } if !stored_credential.backup_eligible => {
                        transaction.commit().map_err(storage)?;
                        return Err(AuthError::Unauthorized);
                    }
                    CounterResult::NonIncreasing { previous, observed } => {
                        record_counter_anomaly(
                            &transaction,
                            &finish.credential.cred_id,
                            previous,
                            observed,
                            stored_credential.backup_eligible,
                            now,
                        )?;
                        finish.credential.sign_count = finish.credential.sign_count.max(previous).max(observed);
                    }
                    CounterResult::Unsupported | CounterResult::Increased { .. } => {}
                }
                finish.credential.sign_count = finish.credential.sign_count.max(stored_credential.sign_count);
                store_credential(&transaction, &finish.credential)?;
                create_session(&transaction, now, self.session_ttl_secs)?
            }
            Err(error) => {
                transaction.commit().map_err(storage)?;
                return Err(error);
            }
        };
        transaction.commit().map_err(storage)?;
        Ok(result)
    }

    pub fn credentials(&self) -> Result<Vec<StoredCredential>, AuthError> {
        let connection = self.connection.lock().expect("auth DB mutex poisoned");
        read_credentials(&connection)
    }

    pub fn revoke_session(&self, cookie_value: &str) -> Result<(), AuthError> {
        let session_hash = token_hash(cookie_value)?;
        let active_leases = self.active_leases.lock().expect("lease mutex poisoned");
        let connection = self.connection.lock().expect("auth DB mutex poisoned");
        connection.execute(
            "UPDATE sessions SET revoked = 1 WHERE token_hash = ?1",
            params![session_hash],
        ).map_err(storage)?;
        if let Some(active) = active_leases.get(&session_hash) {
            active.revoked.cancel();
        }
        Ok(())
    }

    pub fn session_lease(&self, cookie_value: &str, now: u64) -> Result<SessionLease, AuthError> {
        let session_hash = token_hash(cookie_value)?;
        let mut leases = self.active_leases.lock().expect("lease mutex poisoned");
        let connection = self.connection.lock().expect("auth DB mutex poisoned");
        let session = read_session(&connection, &session_hash)?.ok_or(AuthError::Unauthorized)?;
        if session.revoked || session.expires_at <= now {
            return Err(AuthError::Unauthorized);
        }
        leases.entry(session_hash.clone()).or_insert_with(|| ActiveLease {
            revoked: CancellationToken::new(),
            leases: 0,
        }).leases += 1;
        let revoked = leases.get(&session_hash).expect("active lease inserted").revoked.clone();
        Ok(SessionLease {
            expires_at: session.expires_at,
            revoked,
            _registration: Arc::new(LeaseRegistration {
                session_hash,
                active_leases: Arc::downgrade(&self.active_leases),
            }),
        })
    }

    pub fn session_cookie(&self, material: &SessionMaterial) -> String {
        format!("__Host-tansu_session={}; HttpOnly; Secure; Path=/; SameSite=Strict", material.cookie_value)
    }

    /// Creates a SQLite backup at a path that does not already exist.
    /// Requires exclusive access to the auth state directory.
    pub fn backup_to(
        state_directory: impl AsRef<Path>,
        backup_path: impl AsRef<Path>,
    ) -> Result<(), AuthError> {
        let database_path = existing_auth_database(state_directory.as_ref())?;
        let directory = database_path.parent().expect("auth database parent exists");
        let _process_lock = acquire_process_lock(directory)?;
        validate_database_sidecars(&database_path)?;
        let source = Connection::open_with_flags(
            &database_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
            .map_err(storage)?;
        let (temporary, file) = create_temporary_database(directory)?;
        drop(file);
        let mut destination_database = Connection::open_with_flags(&temporary.path, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(storage)?;
        copy_database(&source, &mut destination_database)?;
        verify_database(&destination_database)?;
        set_delete_journal(&destination_database)?;
        drop(destination_database);
        File::open(&temporary.path).map_err(storage)?.sync_all().map_err(storage)?;
        publish_new_database(&temporary, backup_path.as_ref())
    }

    /// Replaces auth state from a validated backup and clears transient auth state.
    /// Requires exclusive access to the auth state directory.
    pub fn restore_from_backup(
        state_directory: impl AsRef<Path>,
        backup_path: impl AsRef<Path>,
    ) -> Result<(), AuthError> {
        let directory = secure_auth_directory(state_directory.as_ref())?;
        let _process_lock = acquire_process_lock(&directory)?;
        let database_path = directory.join("auth.db");
        ensure_regular_file_if_present(&database_path, "auth database")?;
        let backup_path = backup_path.as_ref();
        let (backup_directory, backup_name) = open_user_file_parent(backup_path)?;
        let source_fd = openat(
            &backup_directory,
            backup_name,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(storage)?;
        let mut backup_file = File::from(source_fd);
        if !backup_file.metadata().map_err(storage)?.is_file() {
            return Err(AuthError::InvalidRequest("auth backup must be a regular file".into()));
        }
        let (temporary, mut source_copy) = create_temporary_database(&directory)?;
        io::copy(&mut backup_file, &mut source_copy).map_err(storage)?;
        source_copy.sync_all().map_err(storage)?;
        drop(source_copy);
        let destination_database = Connection::open_with_flags(
            &temporary.path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
            .map_err(storage)?;
        verify_database(&destination_database)?;
        destination_database.execute_batch(
            "BEGIN IMMEDIATE;
             DELETE FROM sessions;
             DELETE FROM enrollment_capabilities;
             DELETE FROM ceremonies;
             COMMIT;",
        ).map_err(storage)?;
        verify_database(&destination_database)?;
        set_delete_journal(&destination_database)?;
        drop(destination_database);
        File::open(&temporary.path).map_err(storage)?.sync_all().map_err(storage)?;
        checkpoint_database_for_replacement(&database_path)?;
        remove_database_sidecars(&database_path)?;
        File::open(&directory).map_err(storage)?.sync_all().map_err(storage)?;
        fs::rename(&temporary.path, &database_path).map_err(storage)?;
        File::open(&directory).map_err(storage)?.sync_all().map_err(storage)?;
        Ok(())
    }
}

struct TemporaryDatabase {
    path: PathBuf,
}

impl Drop for TemporaryDatabase {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

struct TemporaryOutput {
    directory: File,
    name: OsString,
}

impl Drop for TemporaryOutput {
    fn drop(&mut self) {
        let _ = unlinkat(&self.directory, self.name.as_os_str(), AtFlags::empty());
    }
}

fn existing_auth_database(state_directory: &Path) -> Result<PathBuf, AuthError> {
    let directory = secure_auth_directory(state_directory)?;
    let database_path = directory.join("auth.db");
    ensure_regular_file_if_present(&database_path, "auth database")?;
    Ok(database_path)
}

fn acquire_process_lock(directory: &Path) -> Result<File, AuthError> {
    let directory = File::open(directory).map_err(storage)?;
    let descriptor = openat(
        &directory,
        "auth.lock",
        OFlags::RDWR | OFlags::CREATE | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::RUSR | Mode::WUSR,
    )
    .map_err(storage)?;
    let lock = File::from(descriptor);
    if !lock.metadata().map_err(storage)?.is_file() {
        return Err(AuthError::InvalidRequest("auth lock must be a regular file".into()));
    }
    {
        use std::os::unix::fs::PermissionsExt;
        lock.set_permissions(fs::Permissions::from_mode(0o600)).map_err(storage)?;
    }
    lock.try_lock().map_err(|error| {
        AuthError::Storage(format!("auth state is already in use or cannot be locked: {error}"))
    })?;
    Ok(lock)
}

fn open_user_file_parent(path: &Path) -> Result<(File, OsString), AuthError> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let directory = File::open(parent).map_err(storage)?;
    if !directory.metadata().map_err(storage)?.is_dir() {
        return Err(AuthError::InvalidRequest("auth backup parent must be a directory".into()));
    }
    let name = path
        .file_name()
        .ok_or_else(|| AuthError::InvalidRequest("auth backup path needs a file name".into()))?
        .to_os_string();
    Ok((directory, name))
}

fn ensure_regular_file_if_present(path: &Path, description: &str) -> Result<(), AuthError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(AuthError::InvalidRequest(format!("{description} must be a regular file")))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(storage(error)),
    }
}

fn create_temporary_database(parent: &Path) -> Result<(TemporaryDatabase, File), AuthError> {
    for _ in 0..8 {
        let path = parent.join(format!(".tansu-auth-{}", random_token()?));
        let mut options = OpenOptions::new();
        options.read(true).write(true).create_new(true);
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(file) => {
                let temporary = TemporaryDatabase { path };
                {
                    use std::os::unix::fs::PermissionsExt;
                    file.set_permissions(fs::Permissions::from_mode(0o600)).map_err(storage)?;
                }
                return Ok((temporary, file));
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(storage(error)),
        }
    }
    Err(AuthError::Storage("could not allocate an auth database temp file".into()))
}

fn create_temporary_output(directory: &File) -> Result<(TemporaryOutput, File), AuthError> {
    for _ in 0..8 {
        let name = OsString::from(format!(".tansu-auth-{}", random_token()?));
        match openat(
            directory,
            name.as_os_str(),
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::RUSR | Mode::WUSR,
        ) {
            Ok(descriptor) => {
                let output = File::from(descriptor);
                let guard = TemporaryOutput {
                    directory: directory.try_clone().map_err(storage)?,
                    name,
                };
                {
                    use std::os::unix::fs::PermissionsExt;
                    output.set_permissions(fs::Permissions::from_mode(0o600)).map_err(storage)?;
                }
                return Ok((guard, output));
            }
            Err(error) if error == rustix::io::Errno::EXIST => continue,
            Err(error) => return Err(storage(error)),
        }
    }
    Err(AuthError::Storage("could not allocate an auth backup temp file".into()))
}

fn copy_database(source: &Connection, destination: &mut Connection) -> Result<(), AuthError> {
    let backup = Backup::new(source, destination).map_err(storage)?;
    backup
        .run_to_completion(64, Duration::from_millis(25), None)
        .map_err(storage)
}

fn verify_database(connection: &Connection) -> Result<(), AuthError> {
    let result: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(storage)?;
    if result == "ok" {
        Ok(())
    } else {
        Err(AuthError::Storage("auth database integrity check failed".into()))
    }
}

fn set_delete_journal(connection: &Connection) -> Result<(), AuthError> {
    let mode: String = connection
        .query_row("PRAGMA journal_mode = DELETE", [], |row| row.get(0))
        .map_err(storage)?;
    if mode.eq_ignore_ascii_case("delete") {
        Ok(())
    } else {
        Err(AuthError::Storage("auth database could not leave WAL mode".into()))
    }
}

fn publish_new_database(temporary: &TemporaryDatabase, destination: &Path) -> Result<(), AuthError> {
    let (destination_parent, destination_name) = open_user_file_parent(destination)?;
    let (output_temporary, mut output_file) = create_temporary_output(&destination_parent)?;
    let mut source_file = File::open(&temporary.path).map_err(storage)?;
    if !source_file.metadata().map_err(storage)?.is_file() {
        return Err(AuthError::InvalidRequest("auth backup staging file must be regular".into()));
    }
    io::copy(&mut source_file, &mut output_file).map_err(storage)?;
    output_file.sync_all().map_err(storage)?;
    drop(output_file);
    renameat_with(
        &output_temporary.directory,
        output_temporary.name.as_os_str(),
        &destination_parent,
        destination_name.as_os_str(),
        RenameFlags::NOREPLACE,
    )
    .map_err(storage)?;
    destination_parent.sync_all().map_err(storage)
}

fn checkpoint_database_for_replacement(path: &Path) -> Result<(), AuthError> {
    validate_database_sidecars(path)?;
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err(AuthError::InvalidRequest("auth database must be a regular file".into()));
        }
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(storage(error)),
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
        .map_err(storage)?;
    let busy: i64 = connection
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))
        .map_err(storage)?;
    if busy != 0 {
        return Err(AuthError::Storage("auth database is busy; stop Tansu before restoring".into()));
    }
    set_delete_journal(&connection)?;
    drop(connection);
    Ok(())
}

fn remove_database_sidecars(path: &Path) -> Result<(), AuthError> {
    validate_database_sidecars(path)?;
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = path.as_os_str().to_os_string();
        sidecar.push(suffix);
        let sidecar = PathBuf::from(sidecar);
        match fs::symlink_metadata(&sidecar) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                return Err(AuthError::InvalidRequest("auth database sidecar must be a regular file".into()));
            }
            Ok(_) => fs::remove_file(sidecar).map_err(storage)?,
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(storage(error)),
        }
    }
    Ok(())
}

fn validate_database_sidecars(path: &Path) -> Result<(), AuthError> {
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = path.as_os_str().to_os_string();
        sidecar.push(suffix);
        match fs::symlink_metadata(PathBuf::from(sidecar)) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                return Err(AuthError::InvalidRequest("auth database sidecar must be a regular file".into()));
            }
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(storage(error)),
        }
    }
    Ok(())
}

fn bind_auth_identity(connection: &Connection, policy: &AuthPolicy) -> Result<(), AuthError> {
    let (external_origin, rp_id) = policy.persisted_identity();
    let transaction = connection.unchecked_transaction().map_err(storage)?;
    let stored: Option<(String, String)> = transaction.query_row(
        "SELECT external_origin, rp_id FROM auth_identity WHERE singleton = 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional().map_err(storage)?;
    match stored {
        Some((stored_origin, stored_rp_id)) if stored_origin != external_origin || stored_rp_id != rp_id => {
            transaction.execute("DELETE FROM credentials", []).map_err(storage)?;
            transaction.execute("DELETE FROM sessions", []).map_err(storage)?;
            transaction.execute("DELETE FROM ceremonies", []).map_err(storage)?;
            transaction.execute("DELETE FROM enrollment_capabilities", []).map_err(storage)?;
            transaction.execute("DELETE FROM credential_counter_anomalies", []).map_err(storage)?;
            transaction.execute(
                "UPDATE auth_identity SET external_origin = ?1, rp_id = ?2 WHERE singleton = 1",
                params![external_origin, rp_id],
            ).map_err(storage)?;
        }
        Some(_) => {}
        None => {
            transaction.execute(
                "INSERT INTO auth_identity(singleton, external_origin, rp_id) VALUES (1, ?1, ?2)",
                params![external_origin, rp_id],
            ).map_err(storage)?;
        }
    }
    transaction.commit().map_err(storage)
}

#[derive(Debug)]
struct SessionRow {
    csrf_hash: Vec<u8>,
    verified_at: u64,
    expires_at: u64,
    revoked: bool,
}

fn is_valid_rp_id_domain(rp_id: &str) -> bool {
    if rp_id.parse::<std::net::IpAddr>().is_ok() {
        return false;
    }
    if rp_id == "localhost" || psl::domain_str(rp_id).is_some() {
        return true;
    }
    !rp_id.contains('.') && !psl::suffix(rp_id.as_bytes()).is_some_and(|suffix| suffix.is_known())
}

fn split_origin(origin: &str) -> Result<(&str, String), AuthError> {
    let (scheme, authority) = origin.split_once("://").ok_or_else(|| AuthError::InvalidRequest("origin must have a scheme and authority".into()))?;
    if !matches!(scheme, "https" | "http") || authority.is_empty() || authority.contains(['/', '?', '#', '@']) {
        return Err(AuthError::InvalidRequest("invalid origin".into()));
    }
    let host = authority.to_ascii_lowercase();
    if host.chars().any(char::is_whitespace) || !valid_host_authority(&host) {
        return Err(AuthError::InvalidRequest("invalid origin host".into()));
    }
    Ok((scheme, host))
}

fn valid_host_authority(host: &str) -> bool {
    if let Some(after_bracket) = host.strip_prefix('[').and_then(|host| host.split_once(']').map(|(_, after)| after)) {
        return after_bracket.is_empty() || after_bracket.strip_prefix(':').is_some_and(|port| valid_port(port));
    }
    match host.rsplit_once(':') {
        Some((hostname, port)) => !hostname.is_empty() && valid_hostname(hostname) && valid_port(port),
        None => valid_hostname(host),
    }
}

fn valid_hostname(host: &str) -> bool {
    !host.is_empty() && host.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
}

fn valid_port(port: &str) -> bool {
    port.parse::<u16>().is_ok_and(|port| port != 0)
}

fn is_loopback_host(host: &str) -> bool {
    host.starts_with("localhost:") || host == "localhost" || host.starts_with("127.0.0.1:") || host == "127.0.0.1" || host.starts_with("[::1]:") || host == "[::1]"
}

fn secure_auth_directory(state_directory: &Path) -> Result<PathBuf, AuthError> {
    fs::create_dir_all(state_directory).map_err(storage)?;
    let metadata = fs::symlink_metadata(state_directory).map_err(storage)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(AuthError::InvalidRequest("auth state path must be a real directory".into()));
    }
    let directory = fs::canonicalize(state_directory).map_err(storage)?;
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).map_err(storage)?;
    }
    Ok(directory)
}

fn secure_file(path: &Path) -> Result<(), AuthError> {
    let metadata = fs::symlink_metadata(path);
    if metadata.as_ref().is_ok_and(|metadata| metadata.file_type().is_symlink() || !metadata.is_file()) {
        return Err(AuthError::InvalidRequest("auth database must be a regular file".into()));
    }
    let file = if metadata.as_ref().is_ok_and(|metadata| metadata.is_file()) {
        OpenOptions::new().write(true).open(path).map_err(storage)?
    } else {
        OpenOptions::new().write(true).create_new(true).open(path).map_err(storage)?
    };
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600)).map_err(storage)?;
    }
    Ok(())
}

fn read_session(connection: &Connection, session_hash: &[u8]) -> Result<Option<SessionRow>, AuthError> {
    connection.query_row(
        "SELECT csrf_hash, verified_at, expires_at, revoked FROM sessions WHERE token_hash = ?1",
        params![session_hash],
        |row| Ok(SessionRow {
            csrf_hash: row.get(0)?,
            verified_at: row.get::<_, i64>(1)? as u64,
            expires_at: row.get::<_, i64>(2)? as u64,
            revoked: row.get::<_, i64>(3)? != 0,
        }),
    ).optional().map_err(storage)
}

fn session_authorized(transaction: &Transaction<'_>, session_hash: &[u8], now: u64, recent_secs: u64) -> Result<bool, AuthError> {
    let session = read_session(transaction, session_hash)?;
    Ok(session.is_some_and(|session| {
        !session.revoked && session.expires_at > now && session.verified_at.checked_add(recent_secs).is_some_and(|deadline| deadline >= now)
    }))
}

fn prune_expired_ceremonies(transaction: &Transaction<'_>, now: u64) -> Result<i64, AuthError> {
    transaction.execute("DELETE FROM ceremonies WHERE expires_at <= ?1", params![to_i64(now)?]).map_err(storage)?;
    transaction.query_row("SELECT COUNT(*) FROM ceremonies", [], |row| row.get(0)).map_err(storage)
}

fn read_ceremony(transaction: &Transaction<'_>, id_hash: &[u8]) -> Result<Option<CeremonyRow>, AuthError> {
    transaction.query_row(
        "SELECT kind, state, expires_at, capability_hash, session_hash FROM ceremonies WHERE id_hash = ?1",
        params![id_hash],
        |row| Ok(CeremonyRow {
            kind: row.get(0)?,
            state: row.get(1)?,
            expires_at: row.get::<_, i64>(2)? as u64,
            capability_hash: row.get(3)?,
            session_hash: row.get(4)?,
        }),
    ).optional().map_err(storage)
}

fn credential_count(transaction: &Transaction<'_>) -> Result<u64, AuthError> {
    transaction.query_row("SELECT COUNT(*) FROM credentials", [], |row| row.get::<_, i64>(0))
        .map(|count| count as u64).map_err(storage)
}

fn credential_exists(transaction: &Transaction<'_>, credential_id: &[u8]) -> Result<bool, AuthError> {
    transaction.query_row("SELECT EXISTS(SELECT 1 FROM credentials WHERE credential_id = ?1)", params![credential_id], |row| row.get(0))
        .map_err(storage)
}

fn read_credentials(connection: &Connection) -> Result<Vec<StoredCredential>, AuthError> {
    let mut statement = connection.prepare("SELECT value FROM credentials ORDER BY credential_id").map_err(storage)?;
    let values = statement.query_map([], |row| row.get::<_, Vec<u8>>(0)).map_err(storage)?;
    values.map(|value| {
        let value = value.map_err(storage)?;
        serde_json::from_slice(&value).map_err(storage)
    }).collect()
}

fn store_credential(transaction: &Transaction<'_>, credential: &StoredCredential) -> Result<(), AuthError> {
    let value = serde_json::to_vec(credential).map_err(storage)?;
    transaction.execute(
        "INSERT INTO credentials(credential_id, value) VALUES (?1, ?2) ON CONFLICT(credential_id) DO UPDATE SET value = excluded.value",
        params![credential.cred_id, value],
    ).map_err(storage)?;
    Ok(())
}

fn record_counter_anomaly(
    transaction: &Transaction<'_>,
    credential_id: &[u8],
    previous_count: u32,
    observed_count: u32,
    backup_eligible: bool,
    recorded_at: u64,
) -> Result<(), AuthError> {
    transaction.execute(
        "INSERT INTO credential_counter_anomalies(credential_id, previous_count, observed_count, backup_eligible, recorded_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(credential_id) DO UPDATE SET previous_count = excluded.previous_count,
             observed_count = excluded.observed_count, backup_eligible = excluded.backup_eligible,
             recorded_at = excluded.recorded_at",
        params![credential_id, previous_count, observed_count, backup_eligible, to_i64(recorded_at)?],
    ).map_err(storage)?;
    Ok(())
}

fn create_session(transaction: &Transaction<'_>, now: u64, ttl_secs: u64) -> Result<SessionMaterial, AuthError> {
    let cookie_value = random_token()?;
    let csrf_token = random_token()?;
    let cookie_hash = token_hash(&cookie_value)?;
    let csrf_hash = token_hash(&csrf_token)?;
    let expires_at = now.checked_add(ttl_secs).ok_or_else(|| AuthError::InvalidRequest("session expiry overflow".into()))?;
    transaction.execute(
        "INSERT INTO sessions(token_hash, csrf_hash, created_at, verified_at, expires_at) VALUES (?1, ?2, ?3, ?3, ?4)",
        params![cookie_hash, csrf_hash, to_i64(now)?, to_i64(expires_at)?],
    ).map_err(storage)?;
    Ok(SessionMaterial { cookie_value, csrf_token })
}

fn random_token() -> Result<String, AuthError> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| AuthError::Storage(format!("OS random source failed: {error}")))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn token_hash(token: &str) -> Result<Vec<u8>, AuthError> {
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AuthError::Unauthorized);
    }
    Ok(blake3_hash(token.as_bytes()).as_bytes().to_vec())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len() && left.iter().zip(right).fold(0_u8, |acc, (left, right)| acc | (left ^ right)) == 0
}

fn to_i64(value: u64) -> Result<i64, AuthError> {
    i64::try_from(value).map_err(|_| AuthError::InvalidRequest("timestamp out of range".into()))
}

fn storage(error: impl std::fmt::Display) -> AuthError {
    AuthError::Storage(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tansu_webauthn::CounterResult;

    fn store() -> (tempfile::TempDir, AuthStore) {
        let root = tempfile::tempdir().unwrap();
        let store = AuthStore::open(
            root.path().join("auth"),
            AuthPolicy::authenticated("https://notes.example.com", "example.com", "Tansu" ).unwrap(),
            3600,
            300,
        ).unwrap();
        (root, store)
    }

    fn credential(id: u8) -> StoredCredential {
        StoredCredential {
            cred_id: vec![id],
            aaguid: [0; 16],
            x: [0; 32],
            y: [0; 32],
            sign_count: 0,
            backup_eligible: false,
            backup_state: false,
        }
    }

    #[test]
    fn token_hashes_use_blake3() {
        let token = "00".repeat(32);
        assert_eq!(token_hash(&token).unwrap(), blake3_hash(token.as_bytes()).as_bytes());
    }

    #[test]
    fn authentication_ceremonies_are_pruned_and_bounded() {
        let (_root, store) = store();
        let state = AuthChallenge {
            challenge: "login".into(),
            allowed_credential_ids: vec![vec![1]],
            owner_handle: vec![7, 8],
        };
        for _ in 0..MAX_PENDING_CEREMONIES {
            store.begin_authentication(&state, 10, 300).unwrap();
        }
        assert!(matches!(
            store.begin_authentication(&state, 10, 300),
            Err(AuthError::CeremonyLimit)
        ));
        assert_eq!(authentication_ceremony_count(&store), MAX_PENDING_CEREMONIES);

        store.begin_authentication(&state, 311, 300).unwrap();
        assert_eq!(authentication_ceremony_count(&store), 1);
    }

    #[test]
    fn non_increasing_single_device_counter_rejects_without_rollback_or_session() {
        let (_root, store) = store();
        let mut stored = credential(1);
        stored.sign_count = 5;
        seed_credential(&store, &stored);
        let state = auth_challenge();
        let ticket = store.begin_authentication(&state, 10, 30).unwrap();

        let result = store.finish_authentication(&ticket.id, 11, |_, _| {
            let mut updated = stored.clone();
            updated.sign_count = 3;
            Ok(AuthenticationFinish {
                credential: updated,
                counter: CounterResult::NonIncreasing { previous: 5, observed: 3 },
            })
        });

        assert_eq!(result, Err(AuthError::Unauthorized));
        assert_eq!(store.credentials().unwrap()[0].sign_count, 5);
        assert_eq!(session_count(&store), 0);
        assert_eq!(store.finish_authentication(&ticket.id, 12, |_, _| unreachable!()), Err(AuthError::CeremonyUsed));
    }

    #[test]
    fn non_increasing_backup_eligible_counter_records_anomaly_and_keeps_maximum() {
        let (_root, store) = store();
        let mut stored = credential(1);
        stored.sign_count = 5;
        stored.backup_eligible = true;
        seed_credential(&store, &stored);
        let ticket = store.begin_authentication(&auth_challenge(), 10, 30).unwrap();

        let session = store.finish_authentication(&ticket.id, 11, |_, _| {
            let mut updated = stored.clone();
            updated.sign_count = 3;
            Ok(AuthenticationFinish {
                credential: updated,
                counter: CounterResult::NonIncreasing { previous: 5, observed: 3 },
            })
        }).unwrap();

        assert!(!session.cookie_value.is_empty());
        assert_eq!(store.credentials().unwrap()[0].sign_count, 5);
        let next_ticket = store.begin_authentication(&auth_challenge(), 12, 30).unwrap();
        store.finish_authentication(&next_ticket.id, 13, |_, _| {
            let mut updated = stored.clone();
            updated.sign_count = 4;
            Ok(AuthenticationFinish {
                credential: updated,
                counter: CounterResult::NonIncreasing { previous: 5, observed: 4 },
            })
        }).unwrap();
        assert_eq!(store.credentials().unwrap()[0].sign_count, 5);
        let connection = store.connection.lock().unwrap();
        let anomaly: (Vec<u8>, i64, i64, bool, i64) = connection.query_row(
            "SELECT credential_id, previous_count, observed_count, backup_eligible, recorded_at FROM credential_counter_anomalies",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        ).unwrap();
        assert_eq!(anomaly, (vec![1], 5, 4, true, 13));
        let anomalies: i64 = connection.query_row("SELECT COUNT(*) FROM credential_counter_anomalies", [], |row| row.get(0)).unwrap();
        assert_eq!(anomalies, 1);
        let sessions: i64 = connection.query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0)).unwrap();
        assert_eq!(sessions, 2);
    }

    #[test]
    fn failed_backup_eligible_authentication_rolls_back_anomaly_and_session() {
        let (_root, store) = store();
        let mut stored = credential(1);
        stored.sign_count = 5;
        stored.backup_eligible = true;
        seed_credential(&store, &stored);
        store.connection.lock().unwrap().execute_batch(
            "CREATE TRIGGER reject_session_insert BEFORE INSERT ON sessions
             BEGIN SELECT RAISE(ABORT, 'session insert rejected'); END;",
        ).unwrap();
        let ticket = store.begin_authentication(&auth_challenge(), 10, 30).unwrap();

        let result = store.finish_authentication(&ticket.id, 11, |_, _| {
            let mut updated = stored.clone();
            updated.sign_count = 3;
            Ok(AuthenticationFinish {
                credential: updated,
                counter: CounterResult::NonIncreasing { previous: 5, observed: 3 },
            })
        });

        assert!(matches!(result, Err(AuthError::Storage(_))));
        assert_eq!(store.credentials().unwrap()[0].sign_count, 5);
        assert_eq!(session_count(&store), 0);
        assert_eq!(authentication_ceremony_count(&store), 1);
        let anomalies: i64 = store.connection.lock().unwrap()
            .query_row("SELECT COUNT(*) FROM credential_counter_anomalies", [], |row| row.get(0))
            .unwrap();
        assert_eq!(anomalies, 0);
    }

    fn auth_challenge() -> AuthChallenge {
        AuthChallenge {
            challenge: "login".into(),
            allowed_credential_ids: vec![vec![1]],
            owner_handle: vec![7, 8],
        }
    }

    fn seed_credential(store: &AuthStore, credential: &StoredCredential) {
        let mut connection = store.connection.lock().unwrap();
        let transaction = connection.transaction().unwrap();
        store_credential(&transaction, credential).unwrap();
        transaction.commit().unwrap();
    }

    fn session_count(store: &AuthStore) -> i64 {
        store.connection.lock().unwrap()
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .unwrap()
    }

    fn authentication_ceremony_count(store: &AuthStore) -> i64 {
        store.connection.lock().unwrap()
            .query_row("SELECT COUNT(*) FROM ceremonies WHERE kind = 'authentication'", [], |row| row.get(0))
            .unwrap()
    }

    fn request<'a>(
        host: &'a str,
        origin: Option<&'a str>,
        action: RequestAction,
        session_cookie: Option<&'a str>,
        csrf_token: Option<&'a str>,
        session_requirement: SessionRequirement,
        now: u64,
    ) -> AuthRequestContext<'a> {
        AuthRequestContext {
            host,
            origin,
            action,
            session_cookie,
            csrf_token,
            session_requirement,
            now,
        }
    }

    #[test]
    fn enforces_exact_origin_host_and_csrf_for_mutations() {
        let (_root, store) = store();
        assert_eq!(store.validate_request(request("notes.example.com", Some("https://notes.example.com"), RequestAction::StateChange, None, None, SessionRequirement::Optional, 1)), Ok(None));
        assert!(store.validate_request(request("evil.example.com", Some("https://notes.example.com"), RequestAction::Read, None, None, SessionRequirement::Optional, 1)).is_err());
        assert!(store.validate_request(request("notes.example.com", Some("https://evil.example.com"), RequestAction::Read, None, None, SessionRequirement::Optional, 1)).is_err());
        assert!(store.validate_request(request("notes.example.com", None, RequestAction::StateChange, None, None, SessionRequirement::Optional, 1)).is_err());
    }

    #[test]
    fn capability_is_hash_only_one_time_and_expiring() {
        let (_root, store) = store();
        let (capability, expires_at) = store.create_enrollment_capability(10, 30).unwrap();
        let hash = token_hash(&capability).unwrap();
        let connection = store.connection.lock().unwrap();
        let stored: Vec<u8> = connection.query_row("SELECT token_hash FROM enrollment_capabilities", [], |row| row.get(0)).unwrap();
        assert_eq!(stored, hash);
        assert_eq!(expires_at, 40);
        drop(connection);
        let state = RegChallenge { challenge: "challenge".into(), user_id: "owner".into(), username: "owner".into() };
        assert_eq!(store.begin_registration(&state, None, None, 39, 30), Err(AuthError::Unauthorized));
        assert_eq!(store.begin_registration(&state, Some(&capability), None, 40, 30), Err(AuthError::Unauthorized));
        assert!(store.create_enrollment_capability(10, 30).is_ok());
    }

    #[test]
    fn session_cookie_is_host_scoped_secure_and_revocable() {
        let (_root, store) = store();
        let (capability, _) = store.create_enrollment_capability(10, 30).unwrap();
        let state = RegChallenge { challenge: "challenge".into(), user_id: "owner".into(), username: "owner".into() };
        let ticket = store.begin_registration(&state, Some(&capability), None, 11, 30).unwrap();
        let session = store.finish_registration(&ticket.id, 12, |_| Ok(credential(1))).unwrap().unwrap();
        let cookie = store.session_cookie(&session);
        assert!(cookie.contains("HttpOnly; Secure; Path=/; SameSite=Strict"));
        assert!(store.validate_request(request("notes.example.com", Some("https://notes.example.com"), RequestAction::StateChange, Some(&session.cookie_value), Some(&session.csrf_token), SessionRequirement::Required, 13)).unwrap().is_some());
        let lease = store.session_lease(&session.cookie_value, 13).unwrap();
        assert_eq!(lease.expires_at, 3612);
        store.revoke_session(&session.cookie_value).unwrap();
        assert!(lease.revoked.is_cancelled());
        assert!(store.validate_request(request("notes.example.com", Some("https://notes.example.com"), RequestAction::Read, Some(&session.cookie_value), None, SessionRequirement::Required, 14)).is_err());
    }

    #[test]
    fn capability_cannot_be_replayed_and_failed_finish_consumes_it() {
        let (_root, store) = store();
        let (capability, _) = store.create_enrollment_capability(10, 30).unwrap();
        let state = RegChallenge { challenge: "challenge".into(), user_id: "owner".into(), username: "owner".into() };
        let ticket = store.begin_registration(&state, Some(&capability), None, 11, 30).unwrap();
        assert_eq!(store.finish_registration(&ticket.id, 12, |_| Err(AuthError::WebAuthn("bad assertion".into()))), Err(AuthError::WebAuthn("bad assertion".into())));
        assert_eq!(store.finish_registration(&ticket.id, 13, |_| Ok(credential(1))), Err(AuthError::CeremonyUsed));
        assert!(store.begin_registration(&state, Some(&capability), None, 14, 30).is_err());
    }

    #[test]
    fn concurrent_registration_finishes_consume_the_ceremony_once() {
        let (_root, store) = store();
        let store = Arc::new(store);
        let (capability, _) = store.create_enrollment_capability(10, 30).unwrap();
        let state = RegChallenge { challenge: "challenge".into(), user_id: "owner".into(), username: "owner".into() };
        let ticket = store.begin_registration(&state, Some(&capability), None, 11, 30).unwrap();
        let start = Arc::new(std::sync::Barrier::new(3));
        let finishes = (0..2).map(|_| {
            let store = store.clone();
            let start = start.clone();
            let ceremony_id = ticket.id.clone();
            std::thread::spawn(move || {
                start.wait();
                store.finish_registration(&ceremony_id, 12, |_| Ok(credential(1)))
            })
        }).collect::<Vec<_>>();
        start.wait();
        let outcomes = finishes.into_iter().map(|finish| finish.join().unwrap()).collect::<Vec<_>>();
        assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
        assert_eq!(outcomes.iter().filter(|outcome| matches!(outcome, Err(AuthError::CeremonyUsed))).count(), 1);
        assert_eq!(store.credentials().unwrap().len(), 1);
    }

    #[test]
    fn ceremony_expiry_and_verified_session_policy_are_enforced() {
        let (_root, store) = store();
        let (capability, _) = store.create_enrollment_capability(1, 10).unwrap();
        let state = RegChallenge { challenge: "challenge".into(), user_id: "owner".into(), username: "owner".into() };
        let ticket = store.begin_registration(&state, Some(&capability), None, 2, 10).unwrap();
        assert_eq!(store.finish_registration(&ticket.id, 13, |_| Ok(credential(1))), Err(AuthError::Expired));
        assert_eq!(store.finish_registration(&ticket.id, 14, |_| Ok(credential(1))), Err(AuthError::CeremonyUsed));
    }

    #[test]
    fn enrollment_beyond_the_credential_limit_is_rejected_and_login_keeps_working() {
        let (_root, store) = store();
        let (capability, _) = store.create_enrollment_capability(10, 30).unwrap();
        let state = RegChallenge { challenge: "first".into(), user_id: "owner".into(), username: "owner".into() };
        let ticket = store.begin_registration(&state, Some(&capability), None, 11, 30).unwrap();
        store.finish_registration(&ticket.id, 12, |_| Ok(credential(1))).unwrap();
        for id in 2..=MAX_CREDENTIALS as u8 {
            seed_credential(&store, &credential(id));
        }
        let login = AuthChallenge { challenge: "login".into(), allowed_credential_ids: vec![vec![1]], owner_handle: vec![7, 8] };
        let login_ticket = store.begin_authentication(&login, 13, 30).unwrap();
        let session = store.finish_authentication(&login_ticket.id, 14, |_, credentials| {
            let credential = credentials.first().ok_or(AuthError::Unauthorized)?.clone();
            Ok(AuthenticationFinish { credential, counter: CounterResult::Unsupported })
        }).unwrap();
        assert_eq!(
            store.begin_registration(&state, None, Some(&session.cookie_value), 15, 30),
            Err(AuthError::CredentialLimit),
        );
        assert_eq!(store.credentials().unwrap().len(), MAX_CREDENTIALS);
    }

    #[test]
    fn a_ceremony_begun_below_the_limit_is_rejected_at_finish_when_the_limit_is_reached() {
        let (_root, store) = store();
        let (capability, _) = store.create_enrollment_capability(10, 30).unwrap();
        let state = RegChallenge { challenge: "first".into(), user_id: "owner".into(), username: "owner".into() };
        let ticket = store.begin_registration(&state, Some(&capability), None, 11, 30).unwrap();
        store.finish_registration(&ticket.id, 12, |_| Ok(credential(1))).unwrap();
        let login = AuthChallenge { challenge: "login".into(), allowed_credential_ids: vec![vec![1]], owner_handle: vec![7, 8] };
        let login_ticket = store.begin_authentication(&login, 13, 30).unwrap();
        let session = store.finish_authentication(&login_ticket.id, 14, |_, credentials| {
            let credential = credentials.first().ok_or(AuthError::Unauthorized)?.clone();
            Ok(AuthenticationFinish { credential, counter: CounterResult::Unsupported })
        }).unwrap();
        let enroll = store.begin_registration(&state, None, Some(&session.cookie_value), 15, 30).unwrap();
        for id in 2..=MAX_CREDENTIALS as u8 {
            seed_credential(&store, &credential(id));
        }
        assert_eq!(
            store.finish_registration(&enroll.id, 16, |_| Ok(credential(MAX_CREDENTIALS as u8 + 1))),
            Err(AuthError::CredentialLimit),
        );
        assert_eq!(store.credentials().unwrap().len(), MAX_CREDENTIALS);
        assert_eq!(store.finish_registration(&enroll.id, 17, |_| unreachable!()), Err(AuthError::CeremonyUsed));
    }

    #[test]
    fn re_enrolling_an_existing_credential_at_the_limit_is_not_rejected() {
        let (_root, store) = store();
        let (capability, _) = store.create_enrollment_capability(10, 30).unwrap();
        let state = RegChallenge { challenge: "first".into(), user_id: "owner".into(), username: "owner".into() };
        let ticket = store.begin_registration(&state, Some(&capability), None, 11, 30).unwrap();
        store.finish_registration(&ticket.id, 12, |_| Ok(credential(1))).unwrap();
        let login = AuthChallenge { challenge: "login".into(), allowed_credential_ids: vec![vec![1]], owner_handle: vec![7, 8] };
        let login_ticket = store.begin_authentication(&login, 13, 30).unwrap();
        let session = store.finish_authentication(&login_ticket.id, 14, |_, credentials| {
            let credential = credentials.first().ok_or(AuthError::Unauthorized)?.clone();
            Ok(AuthenticationFinish { credential, counter: CounterResult::Unsupported })
        }).unwrap();
        let enroll = store.begin_registration(&state, None, Some(&session.cookie_value), 15, 30).unwrap();
        for id in 2..=MAX_CREDENTIALS as u8 {
            seed_credential(&store, &credential(id));
        }
        assert!(store.finish_registration(&enroll.id, 16, |_| Ok(credential(1))).is_ok());
        assert_eq!(store.credentials().unwrap().len(), MAX_CREDENTIALS);
    }

    #[test]
    fn authentication_ceremonies_expire_and_are_single_use() {
        let (_root, store) = store();
        let (capability, _) = store.create_enrollment_capability(10, 30).unwrap();
        let registration = RegChallenge { challenge: "first".into(), user_id: "owner".into(), username: "owner".into() };
        let registration_ticket = store.begin_registration(&registration, Some(&capability), None, 11, 30).unwrap();
        store.finish_registration(&registration_ticket.id, 12, |_| Ok(credential(1))).unwrap();
        let state = AuthChallenge {
            challenge: "login".into(),
            allowed_credential_ids: vec![vec![1]],
            owner_handle: vec![7, 8],
        };
        let ticket = store.begin_authentication(&state, 13, 30).unwrap();
        let session = store.finish_authentication(&ticket.id, 14, |challenge, credentials| {
            assert_eq!(challenge.challenge, "login");
            assert_eq!(challenge.owner_handle, vec![7, 8]);
            let credential = credentials.first().ok_or(AuthError::Unauthorized)?.clone();
            Ok(AuthenticationFinish {
                credential,
                counter: CounterResult::Unsupported,
            })
        }).unwrap();
        assert!(store.validate_request(request(
            "notes.example.com",
            Some("https://notes.example.com"),
            RequestAction::Read,
            Some(&session.cookie_value),
            None,
            SessionRequirement::Required,
            15,
        )).unwrap().is_some());
        assert_eq!(store.finish_authentication(&ticket.id, 15, |_, _| unreachable!()), Err(AuthError::CeremonyUsed));

        let expired = store.begin_authentication(&state, 16, 1).unwrap();
        assert_eq!(store.finish_authentication(&expired.id, 17, |_, _| unreachable!()), Err(AuthError::Expired));
        assert_eq!(store.finish_authentication(&expired.id, 18, |_, _| unreachable!()), Err(AuthError::CeremonyUsed));
    }

    #[test]
    fn concurrent_authentication_finishes_consume_the_ceremony_once() {
        let (_root, store) = store();
        let store = Arc::new(store);
        let (capability, _) = store.create_enrollment_capability(10, 30).unwrap();
        let registration = RegChallenge { challenge: "first".into(), user_id: "owner".into(), username: "owner".into() };
        let registration_ticket = store.begin_registration(&registration, Some(&capability), None, 11, 30).unwrap();
        store.finish_registration(&registration_ticket.id, 12, |_| Ok(credential(1))).unwrap();
        let state = AuthChallenge {
            challenge: "login".into(),
            allowed_credential_ids: vec![vec![1]],
            owner_handle: vec![7, 8],
        };
        let ticket = store.begin_authentication(&state, 13, 30).unwrap();
        let start = Arc::new(std::sync::Barrier::new(3));
        let finishes = (0..2).map(|_| {
            let store = store.clone();
            let start = start.clone();
            let ceremony_id = ticket.id.clone();
            std::thread::spawn(move || {
                start.wait();
                store.finish_authentication(&ceremony_id, 14, |_, credentials| {
                    let credential = credentials.first().ok_or(AuthError::Unauthorized)?.clone();
                    Ok(AuthenticationFinish {
                        credential,
                        counter: CounterResult::Unsupported,
                    })
                })
            })
        }).collect::<Vec<_>>();
        start.wait();
        let outcomes = finishes.into_iter().map(|finish| finish.join().unwrap()).collect::<Vec<_>>();
        assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
        assert_eq!(outcomes.iter().filter(|outcome| matches!(outcome, Err(AuthError::CeremonyUsed))).count(), 1);
    }

    #[test]
    fn later_credentials_require_recent_owner_verification() {
        let (_root, store) = store();
        let (capability, _) = store.create_enrollment_capability(10, 30).unwrap();
        let state = RegChallenge { challenge: "first".into(), user_id: "owner".into(), username: "owner".into() };
        let first = store.begin_registration(&state, Some(&capability), None, 11, 30).unwrap();
        let owner_session = store.finish_registration(&first.id, 12, |_| Ok(credential(1))).unwrap().unwrap();
        let later = RegChallenge { challenge: "later".into(), user_id: "owner".into(), username: "owner".into() };

        assert!(matches!(store.begin_registration(&later, None, None, 13, 30), Err(AuthError::Unauthorized)));
        assert!(matches!(store.begin_registration(&later, None, Some(&owner_session.cookie_value), 313, 30), Err(AuthError::Unauthorized)));

        let ticket = store.begin_registration(&later, None, Some(&owner_session.cookie_value), 312, 30).unwrap();
        assert!(store.finish_registration(&ticket.id, 312, |_| Ok(credential(2))).unwrap().is_none());
        assert_eq!(store.credentials().unwrap().len(), 2);
    }

    #[test]
    fn linked_sqlite_supports_quick_check_for_database_verification() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE probe (id INTEGER PRIMARY KEY);").unwrap();
        verify_database(&connection).expect("linked SQLite must support PRAGMA quick_check");
    }

    #[test]
    fn backup_includes_committed_wal_state_and_restore_discards_live_tokens() {
        let root = tempfile::tempdir().unwrap();
        let state_directory = root.path().join("auth");
        let backup_directory = root.path().join("backups");
        fs::create_dir(&backup_directory).unwrap();
        let backup_path = backup_directory.join("auth.db");
        let policy = AuthPolicy::authenticated("https://notes.example.com", "example.com", "Tansu").unwrap();
        let store = AuthStore::open(&state_directory, policy.clone(), 3600, 300).unwrap();
        let (capability, _) = store.create_enrollment_capability(10, 30).unwrap();
        let state = RegChallenge { challenge: "first".into(), user_id: "owner".into(), username: "owner".into() };
        let first = store.begin_registration(&state, Some(&capability), None, 11, 30).unwrap();
        let owner_session = store.finish_registration(&first.id, 12, |_| Ok(credential(1))).unwrap().unwrap();
        let pending = store.begin_registration(&state, None, Some(&owner_session.cookie_value), 13, 30).unwrap();
        assert!(AuthStore::backup_to(&state_directory, &backup_path).is_err());
        assert!(AuthStore::restore_from_backup(&state_directory, &backup_path).is_err());
        let wal_reader = Connection::open_with_flags(
            state_directory.join("auth.db"),
            OpenFlags::SQLITE_OPEN_READ_WRITE,
        ).unwrap();
        wal_reader.execute_batch("BEGIN;").unwrap();
        let _: i64 = wal_reader.query_row("SELECT COUNT(*) FROM credentials", [], |row| row.get(0)).unwrap();
        drop(store);
        let wal_path = state_directory.join("auth.db-wal");
        assert!(fs::metadata(&wal_path).unwrap().len() > 0);

        AuthStore::backup_to(&state_directory, &backup_path).unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&backup_path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        drop(wal_reader);
        assert!(AuthStore::backup_to(&state_directory, &backup_path).is_err());

        let live = AuthStore::open(&state_directory, policy.clone(), 3600, 300).unwrap();
        assert!(AuthStore::backup_to(&state_directory, root.path().join("busy.db")).is_err());
        assert!(AuthStore::restore_from_backup(&state_directory, &backup_path).is_err());
        live.finish_registration(&pending.id, 14, |_| Ok(credential(2))).unwrap();
        drop(live);

        AuthStore::restore_from_backup(&state_directory, &backup_path).unwrap();
        let restored = AuthStore::open(&state_directory, policy, 3600, 300).unwrap();
        let credentials = restored.credentials().unwrap();
        assert_eq!(credentials.len(), 1);
        assert_eq!(credentials[0].cred_id, vec![1]);
        assert!(restored.validate_request(request(
            "notes.example.com",
            Some("https://notes.example.com"),
            RequestAction::Read,
            Some(&owner_session.cookie_value),
            None,
            SessionRequirement::Required,
            15,
        )).is_err());
        let connection = restored.connection.lock().unwrap();
        for table in ["sessions", "enrollment_capabilities", "ceremonies"] {
            let count: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
                .unwrap();
            assert_eq!(count, 0);
        }
    }

    #[test]
    fn auth_process_lock_child() {
        let Some(state_directory) = std::env::var_os("TANSU_AUTH_LOCK_CHILD_STATE") else {
            return;
        };
        assert!(AuthStore::open(
            PathBuf::from(state_directory),
            AuthPolicy::loopback_development(),
            3600,
            300,
        ).is_err());
    }

    #[test]
    fn auth_process_lock_blocks_another_process() {
        let root = tempfile::tempdir().unwrap();
        let state_directory = root.path().join("auth");
        let _store = AuthStore::open(
            &state_directory,
            AuthPolicy::loopback_development(),
            3600,
            300,
        ).unwrap();

        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "auth::tests::auth_process_lock_child"])
            .env("TANSU_AUTH_LOCK_CHILD_STATE", &state_directory)
            .status()
            .unwrap();
        assert!(status.success());
    }

    #[test]
    fn authenticated_mode_rejects_non_https_and_unrelated_rp_ids() {
        assert!(AuthPolicy::authenticated("http://notes.example.com", "example.com", "Tansu").is_err());
        assert!(AuthPolicy::authenticated("https://notes.example.com", "elsewhere.test", "Tansu").is_err());
        let policy = AuthPolicy::authenticated("https://notes.example.com", "example.com", "Tansu").unwrap();
        assert_eq!(policy.rp(), Some(("example.com", "https://notes.example.com", "Tansu")));
    }

    #[test]
    fn authenticated_mode_rejects_public_suffix_rp_ids() {
        assert!(AuthPolicy::authenticated("https://notes.example.com", "com", "Tansu").is_err());
        assert!(AuthPolicy::authenticated("https://notes.example.co.uk", "co.uk", "Tansu").is_err());
        assert!(AuthPolicy::authenticated("https://notes.example.co.uk", "example.co.uk", "Tansu").is_ok());
        assert!(AuthPolicy::authenticated("https://login.dev.example.com", "dev.example.com", "Tansu").is_ok());
        assert!(AuthPolicy::authenticated("https://notes.example.com", "notes.example.com", "Tansu").is_ok());
    }

    #[test]
    fn authenticated_mode_rejects_public_suffix_rp_ids_equal_to_the_origin_host() {
        assert!(AuthPolicy::authenticated("https://com", "com", "Tansu").is_err());
        assert!(AuthPolicy::authenticated("https://co.uk", "co.uk", "Tansu").is_err());
        assert!(AuthPolicy::authenticated("https://co.uk:8443", "co.uk", "Tansu").is_err());
        assert!(AuthPolicy::authenticated("https://example.co.uk:8443", "example.co.uk", "Tansu").is_ok());
    }

    #[test]
    fn authenticated_mode_accepts_local_names_and_rejects_ip_addresses_as_rp_ids() {
        assert!(AuthPolicy::authenticated("https://localhost:8443", "localhost", "Tansu").is_ok());
        assert!(AuthPolicy::authenticated("https://devbox", "devbox", "Tansu").is_ok());
        assert!(AuthPolicy::authenticated("https://devbox:8443", "DEVBOX", "Tansu").is_ok());
        assert!(AuthPolicy::authenticated("https://127.0.0.1:8443", "127.0.0.1", "Tansu").is_err());
        assert!(AuthPolicy::authenticated("https://[::1]:8443", "::1", "Tansu").is_err());
        assert!(AuthPolicy::authenticated("https://[::1]:8443", "[::1]", "Tansu").is_err());
    }

    #[test]
    fn changing_origin_invalidates_credentials_sessions_and_pending_enrollment() {
        let root = tempfile::tempdir().unwrap();
        let state_path = root.path().join("auth");
        let policy = AuthPolicy::authenticated("https://notes.example.com", "example.com", "Tansu").unwrap();
        let store = AuthStore::open(&state_path, policy, 3600, 300).unwrap();
        let (capability, _) = store.create_enrollment_capability(10, 30).unwrap();
        let state = RegChallenge { challenge: "challenge".into(), user_id: "owner".into(), username: "owner".into() };
        let ticket = store.begin_registration(&state, Some(&capability), None, 11, 30).unwrap();
        let session = store.finish_registration(&ticket.id, 12, |_| Ok(credential(1))).unwrap().unwrap();
        let pending = store.begin_registration(&state, None, Some(&session.cookie_value), 13, 30).unwrap();
        drop(store);

        let policy = AuthPolicy::authenticated("https://app.notes.example.com", "example.com", "Tansu").unwrap();
        let store = AuthStore::open(&state_path, policy, 3600, 300).unwrap();
        assert!(store.credentials().unwrap().is_empty());
        assert!(store.validate_request(request(
            "app.notes.example.com",
            Some("https://app.notes.example.com"),
            RequestAction::Read,
            Some(&session.cookie_value),
            None,
            SessionRequirement::Required,
            13,
        )).is_err());
        assert_eq!(store.finish_registration(&pending.id, 14, |_| Ok(credential(2))), Err(AuthError::CeremonyUsed));
        assert!(store.create_enrollment_capability(13, 30).is_ok());
    }

    #[test]
    fn loopback_policy_accepts_only_loopback_origin_and_matching_host() {
        let policy = AuthPolicy::loopback_development();
        assert!(policy.validate_origin_host("127.0.0.1:3000", Some("http://127.0.0.1:3000"), false).is_ok());
        assert!(policy.validate_origin_host("example.com", Some("http://example.com"), false).is_err());
        assert!(policy.validate_origin_host("localhost:3000", Some("http://localhost:4000"), false).is_err());
    }

    #[test]
    fn rejects_symlink_auth_state_and_database_paths() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let external = root.path().join("external");
        fs::create_dir(&external).unwrap();
        let linked_directory = root.path().join("linked");
        symlink(&external, &linked_directory).unwrap();
        assert!(AuthStore::open(&linked_directory, AuthPolicy::loopback_development(), 60, 10).is_err());
        let real_directory = root.path().join("real");
        fs::create_dir(&real_directory).unwrap();
        let linked_database = real_directory.join("auth.db");
        symlink(external.join("outside.db"), &linked_database).unwrap();
        assert!(AuthStore::open(&real_directory, AuthPolicy::loopback_development(), 60, 10).is_err());
        assert!(!external.join("outside.db").exists());
    }

    #[test]
    fn restore_rejects_backup_path_replaced_with_symlink() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let state_directory = root.path().join("auth");
        let backup_directory = root.path().join("backups");
        fs::create_dir(&backup_directory).unwrap();
        let policy = AuthPolicy::authenticated("https://notes.example.com", "example.com", "Tansu").unwrap();
        let store = AuthStore::open(&state_directory, policy.clone(), 3600, 300).unwrap();
        store.create_enrollment_capability(1, 60).unwrap();
        drop(store);
        let valid_backup = backup_directory.join("valid.db");
        AuthStore::backup_to(&state_directory, &valid_backup).unwrap();
        let replaced_path = backup_directory.join("replaced.db");
        fs::write(&replaced_path, b"replaceable path").unwrap();
        fs::remove_file(&replaced_path).unwrap();
        symlink(&valid_backup, &replaced_path).unwrap();
        let original_backup = fs::read(&valid_backup).unwrap();

        assert!(AuthStore::restore_from_backup(&state_directory, &replaced_path).is_err());
        assert_eq!(fs::read(&valid_backup).unwrap(), original_backup);
    }

    #[test]
    fn backup_never_overwrites_existing_or_symlink_destination() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let state_directory = root.path().join("auth");
        let backup_directory = root.path().join("backups");
        fs::create_dir(&backup_directory).unwrap();
        let policy = AuthPolicy::authenticated("https://notes.example.com", "example.com", "Tansu").unwrap();
        let store = AuthStore::open(&state_directory, policy, 3600, 300).unwrap();
        store.create_enrollment_capability(1, 60).unwrap();
        drop(store);

        let existing = backup_directory.join("existing.db");
        fs::write(&existing, b"preserve").unwrap();
        assert!(AuthStore::backup_to(&state_directory, &existing).is_err());
        assert_eq!(fs::read(&existing).unwrap(), b"preserve");

        let target = backup_directory.join("target.db");
        fs::write(&target, b"preserve target").unwrap();
        let linked = backup_directory.join("linked.db");
        symlink(&target, &linked).unwrap();
        assert!(AuthStore::backup_to(&state_directory, &linked).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"preserve target");
    }

    #[test]
    fn auth_database_sidecars_reject_symlinks_before_sqlite_opens_them() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let state_directory = root.path().join("auth");
        fs::create_dir(&state_directory).unwrap();
        let target = root.path().join("outside");
        fs::write(&target, b"preserve sidecar target").unwrap();
        symlink(&target, state_directory.join("auth.db-wal")).unwrap();

        assert!(AuthStore::open(
            &state_directory,
            AuthPolicy::loopback_development(),
            3600,
            300,
        ).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"preserve sidecar target");
    }

    #[test]
    fn restore_rejects_sidecar_symlinks_and_clears_regular_sidecars() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let state_directory = root.path().join("auth");
        let backup_directory = root.path().join("backups");
        fs::create_dir(&backup_directory).unwrap();
        let policy = AuthPolicy::authenticated("https://notes.example.com", "example.com", "Tansu").unwrap();
        let store = AuthStore::open(&state_directory, policy, 3600, 300).unwrap();
        store.create_enrollment_capability(1, 60).unwrap();
        drop(store);
        let clear_sidecars = || {
            for suffix in ["-wal", "-shm"] {
                let mut sidecar = state_directory.join("auth.db").into_os_string();
                sidecar.push(suffix);
                match fs::remove_file(PathBuf::from(sidecar)) {
                    Ok(()) => {}
                    Err(error) if error.kind() == ErrorKind::NotFound => {}
                    Err(error) => panic!("{error}"),
                }
            }
        };
        clear_sidecars();
        let backup = backup_directory.join("auth.db");
        AuthStore::backup_to(&state_directory, &backup).unwrap();
        clear_sidecars();
        let target = root.path().join("outside");
        fs::write(&target, b"preserve sidecar target").unwrap();
        symlink(&target, state_directory.join("auth.db-wal")).unwrap();
        assert!(AuthStore::restore_from_backup(&state_directory, &backup).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"preserve sidecar target");

        fs::remove_file(state_directory.join("auth.db-wal")).unwrap();
        fs::write(state_directory.join("auth.db-wal"), []).unwrap();
        fs::write(state_directory.join("auth.db-shm"), []).unwrap();
        AuthStore::restore_from_backup(&state_directory, &backup).unwrap();
        assert!(!state_directory.join("auth.db-wal").exists());
        assert!(!state_directory.join("auth.db-shm").exists());
    }
}
