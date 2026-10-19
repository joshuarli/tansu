# API

Rust DTOs in `src/api_types.rs` are the source of truth. Generate TypeScript with
`make types`; never edit `web/ts/types.generated.ts` by hand.
The transport accepts HTTP/1 and cleartext HTTP/2 prior knowledge; it
does not support h2c upgrades.

Browser extension import uses no HTTP endpoint. See [extension import](extension-import.md).

## Version 2

Version 2 identifies a server installation and each configured vault with stable
opaque IDs. `vaultId` survives configuration reorder and vault rename;
`serverInstanceId` survives restart. `noteId` is durable note identity and paths
are mutable metadata. None of these IDs are stored in Markdown.

Every `/api/v2` response and SSE stream includes `X-Tansu-Api-Version: 2` and
`X-Tansu-Build-Id: <build-id>`. `GET /api/v2/bootstrap` is the entry point and
returns `serverInstanceId` and the configured `vaultId` values. Every later v2
vault request sends `X-Tansu-Server-Instance: <serverInstanceId>`; a mismatch
fails before a vault lookup or mutation. Health and authentication routes can
run before bootstrap and do not require that header. A client keys notes by
`(serverInstanceId, vaultId, noteId)` and private browser state by that tuple
plus its workspace ID.

All vault routes use `/api/v2/vaults/:vaultId`. There is no active-vault index
header. Authenticated deployments require a session for bootstrap and vault
routes. `GET /api/v2/health` is public, but still validates `Host` and rejects
a supplied `Origin` that differs from the configured origin.

App settings use a separate SQLite database from each vault's catalog settings.
The first-run server serves setup until app settings are saved.
`PUT /api/v2/app/settings` responds with `restartRequired: true`; restart the
server to apply changed vaults or auth policy. In authenticated mode, the write
requires a session and CSRF token.

The current route and method list is in [HTTP dispatch](../src/http.rs). Request
and response DTOs are in [API types](../src/api_types.rs).

`/api/v2/bootstrap` returns only server identity and vault IDs. Workspace
sessions, pins, and recents are stored in the browser's private workspace.

Legacy `/api/` routes return `api_version_unsupported` before dispatch. They do
not interpret `X-Tansu-Vault` or mutate a default vault.

### Rust API compatibility

The V1 Rust adapters `api::handle_api`, `api::api_error_response`,
`App::vault_entries`, `App::handle_events`, index-based `App::vault`,
`App::handle_log_stream`, `VaultRuntime::bootstrap`, `VaultRuntime::save_session`,
`VaultRuntime::set_pin`, and their session/bootstrap DTOs were removed. These
removals break downstream Rust callers. Other public `VaultRuntime` methods and
DTOs have not been audited for external use.

### Source and hashes

Editor source is the complete Markdown file, including frontmatter, represented
with LF line endings. It is distinct from exact disk bytes and parsed display
data. Reading and saving never trim, append a final newline, reorder frontmatter,
or serialize parsed data back over authored source. A leading UTF-8 BOM is part
of editor source. A line-ending-only external edit changes `diskHash` even when
it leaves `sourceHash` unchanged.

`sourceHash` is `blake3-v3:<64 lowercase hex characters>` over the UTF-8 editor
source with CRLF and CR normalized to LF. Its `sourceHashFormatVersion` is `3`.
`diskHash` is `blake3-v2:<64 lowercase hex characters>` over the exact visible
file bytes. Its `diskHashFormatVersion` is `2`. The server reads prior
`sha256:` source hashes (version 1), `sha256-v2:` source hashes (version 2),
and `sha256:` disk hashes (version 1); it upgrades catalog hashes during
reconciliation without adding a note revision. Client workspace journals
also accept those prior formats.

Existing-note mutations send `precondition` with the base revision,
`baseSourceHash`, and `baseDiskHash`. Full and delta saves include the candidate
`sourceHash`; the server verifies it before accepting. Delta ranges are
zero-based line and UTF-16 character offsets in the exact LF source named by
the precondition. Edits must be sorted, non-overlapping, and may not split a
surrogate pair. The server reconstructs the full candidate from that revision
before using the full-save path.

Every server mutation carries a unique opaque `mutationId` of at most 128 UTF-8
bytes, including note, settings, and image mutations. Raw WebP upload carries it
in `X-Tansu-Mutation-Id`. Idempotency is scoped to a vault and retained for the
life of that vault's durable state: the same ID, method, path, and decoded
request payload returns the original outcome; reuse with a different method,
path, or payload returns `mutation_id_reuse`. Image retries compare exact WebP
bytes. Existing durable mutation records retain their SHA-256 payload hash for
same-request replay; new records use BLAKE3.

An accepted content change has a complete recoverable snapshot before its
revision commits. `accepted` means both catalog and visible-file steps finished.
`pendingMaterialization` identifies a durable accepted operation whose visible
file step still needs completion; clients must show it as pending. `conflict`
preserves the submitted draft and canonical content. Before accepting a write,
the server rechecks the visible file against `baseDiskHash`; an external change
creates a conflict draft instead of being overwritten. These checks do not
provide compare-and-swap against a non-cooperating writer between the final
check and replace.
The server serializes mutations within each vault. It does not coordinate with
other processes that write the same files.

Example full save:

```http
PUT /api/v2/vaults/vault-id/notes/note-id
X-Tansu-Server-Instance: server-id
Content-Type: application/json

{
  "mutationId": "01J...",
  "precondition": {
    "baseRevision": 3,
    "baseSourceHash": "blake3-v3:...",
    "baseDiskHash": "blake3-v2:..."
  },
  "content": "# Title\n\nbody\n",
  "sourceHash": "blake3-v3:..."
}
```

Note create, save, delta, rename, delete, and restore responses use
`V2MutationResponse`. Its `outcome` is a discriminated union:
`accepted` includes the resulting note metadata when applicable;
`pendingMaterialization` includes an operation ID; `conflict` includes the
canonical document and the preserved draft metadata.
Settings writes return `V2SettingsResponse`. Invalid values fail with
`400 bad_request` before persistence or mutation ID consumption. See
[Configuration](configuration.md#settings) for validation ownership.
Image uploads send raw WebP bytes
with `Content-Type: image/webp` and `X-Tansu-Mutation-Id`. The server stores the
asset under `z-images/`; `V2ImageUploadResponse` returns its vault-relative name
and wiki-image Markdown after the asset write completes. Asset reads pass that
name as the `name` query parameter and resolve only within the selected vault's
`z-images/` directory.

### Links and previews

`GET .../notes/:noteId/links` returns `V2NoteLinksResponse`:
`{ backlinks: [{ note: { noteId, path, title }, mentions: [string] }], outgoing: [{ noteId, path, title }] }`.
A backlink is a live note whose Markdown contains a wiki link (`[[target]]`,
`[[target|label]]`) or a Markdown link to a `.md` path that resolves to this
note. Each `mentions` entry is the trimmed line holding the link, windowed to at
most 200 characters around the link. `outgoing` lists the distinct notes this
note's links resolve to, in first-mention order. Links in fenced code, inline
code, frontmatter, and images are ignored, as are self-links in `backlinks`.

Wiki targets resolve by the rules in [editor](editor.md): a leading `/` is a
vault-root path, `./` and `../` resolve from the linking note's directory, a bare
name matches a note basename only when exactly one note has it, and ambiguous or
missing targets are unresolved and omitted. Markdown link destinations resolve
as paths relative to the linking note, or from the vault root with a leading `/`.
Results are keyed by `noteId`, so renaming a note updates `path` without losing
its links.

`GET .../notes/:noteId/preview` returns `{ noteId, preview }`: the note body
with frontmatter stripped and whitespace collapsed, truncated to 280 characters.

Both routes are read-only derived state computed from the catalog's live notes and
their current files on each request; nothing is persisted. They hold the vault
operation lock only while reading the note list, never while reading files, so
they do not delay writes. A note whose file cannot be read is skipped. An unknown,
deleted, or unresolved `noteId` returns `note_not_found`.

### Search and quick-open

Search is `POST` so dirty source stays out of URLs. A request has a query, mode
(`default` or `typo_only`), result limit, and optional overlay snapshots.
Request bounds and matching are enforced in `crates/tansu-search/`. Each
saved-note overlay carries note identity, base revision and source hash, local
revision, title, path, and whole-file source. A new-note overlay carries a
client-local ID and the same local fields without a canonical base. The server
considers overlays in request order and includes a prefix of whole notes. If
the limits exclude overlays, it reports
`overlayCoverage: { "status": "partial", "skippedNoteCount": n }`; canonical
search still runs. Overlay source is request-scoped and is never written to an
index, log, or URL. When a saved-note overlay matches, the stale canonical hit
for that note is suppressed.

All unquoted whitespace-separated terms are required. Quoted multiword phrases
match ordered adjacency and keep repeated words. Exact and prefix matches rank
ahead of fuzzy matches; `typo_only` returns fuzzy matches only. Phrases are not
fuzzy. Terms can match titles, paths, headings, tags, or content. Configured
field weights are read at query time, so settings changes apply without
reindexing. Recency only reorders hits already selected by field score. Search
matching and scoring are implemented in `src/search.rs` and
`crates/tansu-search/`.
Search results do not include note bodies. Each hit includes identity,
revision/hash, title, path, score, an excerpt, excerpt-local half-open UTF-16
highlight ranges, and an optional half-open UTF-16 source range into the
declared revision. Filename-only matches have no source range. These ranges are
distinct types and coordinate spaces.

Hits carry no tags, and the client does not display tag metadata from hits or
notes.

Quick-open matches title, filename, and path. For an empty query it returns
pinned and recent notes in the supplied order, followed by remaining notes.
Pinned and recent IDs are client-provided and are not stored by the server.

### Events

SSE IDs are monotonically increasing `eventVersion` values scoped to a vault
and do not decrease across restarts with the same server identity. Reconnect
with `after` set to the last event ID. The URL's `after` value takes precedence
over `Last-Event-ID`. The server replays retained events or sends
`resyncRequired: true`; clients then fetch the vault bootstrap
and notes again. Each event also has a typed update. Resync status is derived
from the update variant, so a normal event cannot serialize with
`resyncRequired: true`.
`vaultChanged` carries metadata only for notes added or changed by watcher
reconciliation; removed notes arrive as `noteDeleted`. Clients merge the
changed metadata and remove only the IDs named by `noteDeleted`. If an event
cannot fit the bounded stream payload, the server sends `resyncRequired`.

### Authentication

In authenticated mode, Host is required for every request and any supplied
Origin must exactly match the configured HTTPS origin. State-changing requests
also require that Origin. Bootstrap, note, settings, search, quick-open, asset,
and event routes require a session. `GET /api/v2/health` is public. Login
ceremonies and ticket-bound finishes are available before a session; initial
enrollment also requires its one-time capability.

Enrollment after the first credential requires a recently verified owner
session and its CSRF token. A store holds at most 32 credentials; finishing a
registration that would add a 33rd returns `bad_request` and consumes the
ceremony. State-changing requests send `X-Tansu-CSRF` with the
value readable from the session-bound `__Host-tansu_csrf` cookie. The cookie is
Secure, SameSite=Strict, and scoped to `/`; logout clears it with the HttpOnly
session cookie.

`GET /api/v2/auth/session` returns `authenticated`, `verifiedAt`, and
`expiresAt` for the current session. It is available before bootstrap so the
app can determine whether to show login.

### Errors

Errors use `V2ApiErrorResponse` and a `code` discriminator. Error kinds and
status mapping are defined in `src/api_types.rs` and `src/http.rs`; the client
switches on the generated `V2ApiErrorKind`. `internal` contains a request ID,
not an implementation error string.
