# Security

## Server identity

Authenticated mode requires an HTTPS external origin and an RP ID that matches that origin. The server checks `Host` and `Origin` on every request and requires the session CSRF token on state-changing requests. It does not enable cross-origin access.

WebAuthn credentials are bound to the configured origin and RP ID. Changing either value clears the stored credentials, sessions, enrollment capabilities, and pending ceremonies in one database transaction. The owner must enroll new credentials after that change.

## Enrollment and sessions

The first credential requires a random, expiring enrollment capability. Only its hash is stored, and finishing the first registration consumes it. Later registrations require a recently verified session. Ceremony state stays on the server, expires, and is consumed in the same transaction as a successful or failed finish.

Sessions use random opaque tokens stored as hashes. The browser cookie is host-scoped, `HttpOnly`, `Secure`, and `SameSite=Strict`; a separate session-bound token protects state-changing requests. Logout revokes the session and closes its open event streams. Sessions and streams also stop at expiry.

Auth data belongs in a private state directory outside search indexes and caches. The directory is restricted to its owner and the database file is owner-readable and writable. `AuthStore` does not choose that directory; server configuration must supply it.

## Local administration and recovery

Authenticated mode is opt-in through `[auth]`. The initial enrollment capability is created with `tansu2 auth enroll`; it is printed once and expires after ten minutes. Later credentials require a recently verified owner session.

The server and the local auth commands hold an exclusive OS file lock in the auth state directory on supported macOS and Linux targets. Stop the server before enrollment, backup, or restore. Backup uses SQLite's online backup API so committed WAL data is included, checks its integrity, copies it to a mode-0600 staging file in the destination directory, then renames it into place atomically without replacing an existing path. The backup path's parent directory is opened once and its final component is opened or published relative to that handle without following symlinks. An existing destination, including a symlink, is rejected.

Restore opens the supplied file relative to its opened parent directory, rejects a symlink or non-regular final component, and validates it before touching the live database. It atomically replaces the database only after it has checkpointed the current WAL. Restore also rejects symlinked database WAL/SHM sidecars before SQLite opens them, and removes regular sidecars before replacement. It preserves credentials and the origin/RP binding, but clears sessions, enrollment capabilities, and pending ceremonies. Auth backup files do not contain vault notes, app history, or search indexes. Protect backup files as private credentials.
