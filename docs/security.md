# Security

## Server identity

Authenticated mode requires an HTTPS external origin and an RP ID that matches that origin. The server checks `Host` and `Origin` on every request and requires the session CSRF token on state-changing requests. It does not enable cross-origin access.

WebAuthn credentials are bound to the configured origin and RP ID. Changing either value clears the stored credentials, sessions, enrollment capabilities, and pending ceremonies in one database transaction. The owner must enroll new credentials after that change.

## Enrollment and sessions

The first credential requires a random, expiring enrollment capability. Only its hash is stored, and finishing the first registration consumes it. Later registrations require a recently verified session. Ceremony state stays on the server, expires, and is consumed in the same transaction as a successful or failed finish.

Sessions use random opaque tokens stored as hashes. The browser cookie is host-scoped, `HttpOnly`, `Secure`, and `SameSite=Strict`; a separate session-bound token protects state-changing requests. Logout revokes the session and closes its open event streams. Sessions and streams also stop at expiry.

Auth data belongs in a private state directory outside search indexes and caches. The directory is restricted to its owner and the database file is owner-readable and writable. `AuthStore` does not choose that directory; server configuration must supply it.

## Integration status

This lane provides the auth store and HTTP routes, but the top-level CLI and server configuration do not yet create the initial capability, select the auth state directory, or provide local recovery and backup. Keep authenticated mode unavailable until those local administration paths are wired. The `tansu2 auth enroll` command and recovery workflow remain integration requirements, not network endpoints.
