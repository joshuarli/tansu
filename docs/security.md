# Security

## Server identity

Authenticated mode requires an HTTPS external origin and a matching RP ID.
Tansu2 checks `Host` on every request. If a request supplies `Origin`, Tansu2
requires an exact match with the configured origin. State-changing requests
must include that origin, a valid session, and its CSRF token. Login ceremonies
and initial enrollment use server-side one-time tickets or the enrollment
capability instead. `GET /api/v2/health` is public, but still checks `Host` and
any supplied `Origin`. The server does not enable cross-origin access.

WebAuthn credentials bind to the configured origin and RP ID. Changing either
value clears credentials, sessions, enrollment capabilities, and pending
ceremonies in one database transaction. Enroll credentials again after changing
either value.

The verifier reports non-increasing signature counters, but the auth store
currently does not act on that result. The policy proposal is in
[RFC 0001](rfcs/0001-webauthn-counter-policy.md).

## Enrollment and sessions

The first credential requires a random, expiring enrollment capability. The
server stores only its hash. Successful first registration consumes it. Later
registrations require a recently verified owner session. Ceremony state expires
and the server consumes it when a finish attempt succeeds or fails.

Sessions use random opaque tokens stored as hashes. The session cookie is
`__Host-tansu_session`, `HttpOnly`, `Secure`, and `SameSite=Strict`. The
session-bound `__Host-tansu_csrf` cookie is also Secure and SameSite=Strict. It
is scoped to `/` and readable by same-origin JavaScript so another tab or a
reload can send its value as `X-Tansu-CSRF`. Tansu2 checks the header against the
session's stored token hash. Logout revokes the session, clears both cookies,
and closes its open event streams. Sessions and streams stop at expiry.

`POST /api/v2/auth/login/options` and `/login/finish` perform passkey login.
They check Host and Origin but ignore a stale session cookie so an expired
session can log in again. `POST /api/v2/auth/enrollment/options` starts initial
enrollment with the one-time capability or later registration with a recently
verified owner session and CSRF token. Both enrollment finish routes require a
single-use ceremony ID. `GET /api/v2/auth/session` returns the current session's
verification and expiry times. `POST /api/v2/auth/logout` requires a valid
session, configured Origin, and CSRF token.

Auth data belongs in a private state directory outside search indexes and
caches. The directory is restricted to its owner. The database is
owner-readable and writable. Server configuration selects the directory.

## Local administration and recovery

Authenticated mode is opt-in through `[auth]`. Run `tansu2 auth enroll` to
create the first enrollment capability. The command prints it once. It expires
after ten minutes. Later credentials require a recently verified owner session.

On supported macOS and Linux targets, the server and local auth commands hold
an exclusive OS file lock in the auth state directory. Stop the server before
enrollment, backup, or restore. The lock rejects local auth commands while the
server is running.

Backup uses SQLite's online backup API, which includes committed WAL data.
Tansu2 checks the backup integrity and stages a mode-0600 file in the target
directory. It publishes the file by rename and refuses to replace an existing
path. The command opens the target parent directory once. It opens or publishes
the final component relative to that directory without following symlinks.

Restore opens the supplied file relative to its opened parent directory. It
rejects symlinks and non-regular files, then validates the backup before
touching the live database. It checkpoints the current WAL before replacing the
database. It rejects symlinked WAL and SHM sidecars before SQLite opens them and
removes regular sidecars before replacement. Restore preserves credential
records and the origin/RP binding. It clears sessions, enrollment capabilities,
and pending ceremonies.

Auth backups contain public credential records, not authenticator private
keys. They do not contain vault notes, app history, or search indexes. Protect
backup files as private credentials. See [Deployment](deployment.md) for
backup and recovery steps.

Tailscale Serve can provide private HTTPS for remote tailnet devices while the
Tansu2 listener stays on loopback. Tailscale identity headers do not authorize
Tansu2 requests. Use passkey authentication and the configured origin checks.
Do not expose the server with Tailscale Funnel. See [Deployment](deployment.md)
for setup.
