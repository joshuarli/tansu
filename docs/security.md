# Security

## Server identity

Authenticated mode requires the configured HTTPS origin and RP ID. Tansu
checks `Host` on every request and requires an exact `Origin` match when the
header is present. State-changing requests require the configured origin, a
valid session, and its CSRF token, except for ticket-bound login and initial
enrollment. Health is public but still checks `Host` and any supplied
`Origin`. The server does not enable cross-origin access.

WebAuthn credentials bind to the configured origin and RP ID. Changing either
clears credentials, sessions, enrollment capabilities, and pending ceremonies
in one transaction. A non-increasing signature counter rejects single-device
credentials and consumes the ceremony. Backup-eligible passkeys may complete a
valid assertion; Tansu records the latest counter anomaly and never lowers the
stored counter.

App responses restrict scripts to same-origin files and permit WebAssembly
compilation with `wasm-unsafe-eval` for the pasted-image encoder. JavaScript
`eval` is not permitted.

## Extension import

The page-side import receiver adds no server endpoint and no CORS access. It
accepts only same-window, same-origin `postMessage` events. It treats their
payloads as hostile, validates and caps them, then creates notes through the
existing authenticated writes. See [extension import](extension-import.md).

## Enrollment and sessions

The first credential requires a random, expiring enrollment capability. The
server stores only its hash and consumes it after successful registration.
Later registrations require a recently verified owner session. Session tokens
are random opaque values stored as hashes. The `__Host-tansu_session` cookie is
HttpOnly, Secure, and SameSite=Strict. The session-bound CSRF cookie is Secure,
SameSite=Strict, scoped to `/`, and readable by same-origin JavaScript. Logout
revokes the session and closes its event streams; sessions and streams stop at
expiry.

## Auth data

Auth state is private, owner-only data outside search indexes and caches. On
supported macOS and Linux targets, the server and local auth commands hold an
exclusive OS file lock in the auth state directory. Stop the server before
enrollment, backup, or restore.

Backup uses SQLite's online backup API, verifies integrity, stages a mode-0600
file, and refuses to replace an existing path. Restore rejects symlinks and
non-regular files and validates the backup before changing the live database.
It checkpoints the WAL, rejects symlinked WAL and SHM sidecars, and removes
regular sidecars before replacement. Restore preserves credentials and their
origin/RP binding while clearing sessions, enrollment capabilities, and pending
ceremonies.

Auth backups contain public credential records, not authenticator private keys.
They do not contain vault notes, app history, or search indexes. Protect backup
files as private credentials. See [Deployment](deployment.md) for recovery.
