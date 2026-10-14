# API

Rust DTOs in `src/api_types.rs` are the source of truth. Generate TypeScript with
`make types`; never edit `web/ts/types.generated.ts` by hand.

## Version 2

Version 2 identifies a server installation and each configured vault with stable
opaque IDs. `vaultId` survives configuration reorder and vault rename;
`serverInstanceId` survives restart. `noteId` is durable note identity and paths
are mutable metadata. None of these IDs are stored in Markdown.

Every `/api/v2` response and SSE stream includes `X-Tansu-Api-Version: 2` and
`X-Tansu-Build-Id: <build-id>`. `GET /api/v2/bootstrap` is the entry point and
returns `serverInstanceId` and the configured `vaultId` values. Every later v2
request sends `X-Tansu-Server-Instance: <serverInstanceId>`; a mismatch fails
before a vault lookup or mutation. A client keys notes by
`(serverInstanceId, vaultId, noteId)` and private browser state by that tuple
plus its workspace ID.

All vault routes use `/api/v2/vaults/:vaultId`. There is no active-vault index
header. The v2 API is the contract for the campaign implementation; until its
handlers land, valid v2 routes return the typed `not_implemented` error.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v2/health` | Health |
| `GET` | `/api/v2/bootstrap` | Server identity and vault list |
| `GET` | `/api/v2/vaults/:vaultId/bootstrap` | Vault metadata, note metadata, settings and search status |
| `GET` | `/api/v2/vaults/:vaultId/notes` | List note metadata |
| `GET` | `/api/v2/vaults/:vaultId/notes/:noteId` | Read source and metadata |
| `POST` | `/api/v2/vaults/:vaultId/notes` | Create a note |
| `PUT` | `/api/v2/vaults/:vaultId/notes/:noteId` | Save full source |
| `PATCH` | `/api/v2/vaults/:vaultId/notes/:noteId` | Apply exact UTF-16 text edits |
| `DELETE` | `/api/v2/vaults/:vaultId/notes/:noteId` | Delete a note |
| `POST` | `/api/v2/vaults/:vaultId/notes/:noteId/rename` | Rename a path |
| `GET` | `/api/v2/vaults/:vaultId/notes/:noteId/revisions` | List revisions |
| `GET` | `/api/v2/vaults/:vaultId/notes/:noteId/revisions/:revision` | Read a revision |
| `POST` | `/api/v2/vaults/:vaultId/notes/:noteId/revisions/:revision/restore` | Restore a revision |
| `GET` | `/api/v2/vaults/:vaultId/notes/:noteId/conflicts/:draftId` | Read a conflict draft |
| `POST` | `/api/v2/vaults/:vaultId/notes/:noteId/conflicts/:draftId/restore` | Restore a conflict draft |
| `GET` | `/api/v2/vaults/:vaultId/settings` | Read vault settings |
| `PUT` | `/api/v2/vaults/:vaultId/settings` | Write vault settings |
| `POST` | `/api/v2/vaults/:vaultId/search` | Search canonical notes and supplied overlays |
| `POST` | `/api/v2/vaults/:vaultId/quick-open` | Match note title, filename and path |
| `POST` | `/api/v2/vaults/:vaultId/images` | Upload WebP bytes |
| `GET` | `/api/v2/vaults/:vaultId/assets?name=...` | Read one vault-local image |
| `GET` | `/api/v2/vaults/:vaultId/events?after=:eventVersion` | Subscribe to vault events |

Legacy index routes selected with `X-Tansu-Vault` return
`api_version_unsupported`; they never redirect an index to a v2 vault ID.
Browser session state, pins, and recents are client-local in v2. Clients keep
pins and recents in their private workspace state.
The browser stores workspace and draft data in IndexedDB without encryption.
Passkeys do not encrypt that data.

### Source and hashes

Editor source is the complete Markdown file, including frontmatter, represented
with LF line endings. It is distinct from exact disk bytes and parsed display
data. Reading and saving never trim, append a final newline, reorder frontmatter,
or serialize parsed data back over authored source. A leading UTF-8 BOM is part
of editor source. A line-ending-only external edit changes `diskHash` even when
it leaves `sourceHash` unchanged.

`sourceHash` is `sha256-v2:<64 lowercase hex characters>` over the UTF-8 editor
source with CRLF and CR normalized to LF. Its `sourceHashFormatVersion` is `2`.
`diskHash` is `sha256:<64 lowercase hex characters>` over the exact visible
file bytes. Its `diskHashFormatVersion` is `1`. Legacy `sha256:` content hashes
are not reinterpreted as v2 source hashes.

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
bytes.

An accepted content change has a complete recoverable snapshot before its
revision commits. `accepted` means both catalog and visible-file steps finished.
`pendingMaterialization` identifies a durable accepted operation whose visible
file step still needs completion; clients must show it as pending. `conflict`
preserves the submitted draft and canonical content. Before accepting a write,
the server rechecks the visible file against `baseDiskHash`; an external change
creates a conflict draft instead of being overwritten. These checks do not
provide compare-and-swap against a non-cooperating writer between the final
check and replace.

Example full save:

```http
PUT /api/v2/vaults/vault-id/notes/note-id
X-Tansu-Server-Instance: server-id
Content-Type: application/json

{
  "mutationId": "01J...",
  "precondition": {
    "baseRevision": 3,
    "baseSourceHash": "sha256-v2:...",
    "baseDiskHash": "sha256:..."
  },
  "content": "# Title\n\nbody\n",
  "sourceHash": "sha256-v2:..."
}
```

Note create, save, delta, rename, delete, and restore responses use
`V2MutationResponse`. Its `outcome` is a discriminated union:
`accepted` includes the resulting note metadata when applicable;
`pendingMaterialization` includes an operation ID; `conflict` includes the
canonical document and the preserved draft metadata.
Settings writes return `V2SettingsResponse`. Image uploads send raw WebP bytes
with `Content-Type: image/webp` and `X-Tansu-Mutation-Id`. The server stores the
asset under `z-images/`; `V2ImageUploadResponse` returns its vault-relative name
and wiki-image Markdown after the asset write completes. Asset reads pass that
name as the `name` query parameter and resolve only within the selected vault's
`z-images/` directory.

### Search and quick-open

Search is `POST` so dirty source stays out of URLs. A search request has a UTF-8
query of at most 1,024 bytes, mode (`default` or `typo_only`), result limit from
1 through 100, and optional overlay snapshots. Each saved-note overlay carries
note identity, base revision and source hash, local revision, title, path, and
whole-file source. A new-note overlay carries a client-local ID and the same
local fields without a canonical base. The server considers overlays in request
order, includes a prefix of at most 20 notes and 2 MiB of UTF-8 source, and
skips that entry and all following entries when either limit would be exceeded;
it does not split a note. If the limits exclude overlays, it reports
`overlayCoverage: { "status": "partial", "skippedNoteCount": n }`; canonical
search still runs. Overlay source is request-scoped and is never written to an
index, log, or URL. When a saved-note overlay matches, the stale canonical hit
for that note is suppressed.

All unquoted whitespace-separated terms are required. Quoted multiword phrases
are ordered adjacency and keep repeated words; a single-word quote is a term,
empty quotes are ignored, and an unclosed quote is treated as terms. Exact and
prefix matches are tried first. Fuzzy expansion is used only when fewer than
five results match exactly or by prefix; terms of three or fewer UTF-8 bytes
are never expanded. Fuzzy matches rank below exact and prefix matches. Phrases
are never fuzzy. `typo_only` returns fuzzy matches only. Search results do not
include note bodies: each hit includes identity, revision/hash, title, path,
score, a maximum 512-byte excerpt, excerpt-local half-open UTF-16 highlight
ranges, and an optional half-open UTF-16 source range into the declared
revision. Filename-only matches have no source range. These ranges are distinct
types and coordinate spaces.

Quick-open accepts a query of at most 1,024 UTF-8 bytes and a limit from 1
through 100. It matches title, filename, and path with exact, then prefix, then
subsequence priority. Ties use match score, path, then `noteId`. For an empty
query it returns pinned notes then recent notes in the supplied order, followed
by remaining notes; duplicate and missing IDs are ignored. It does not query
Tantivy. Pinned and recent IDs are client-provided and are not stored by the
server.

### Events

SSE IDs are monotonically increasing `eventVersion` values scoped to a vault
and do not decrease across restarts with the same server identity. Reconnect
with `after` set to the last event ID. The server replays retained
events or sends `resyncRequired: true`; clients then fetch the vault bootstrap
and notes again. Each event also has a typed update. Resync status is derived
from the update variant, so a normal event cannot serialize with
`resyncRequired: true`.

### Errors

Errors use `V2ApiErrorResponse` and a `code` discriminator. Error fields use
camel case. `api_version_unsupported` is returned for retired index routes;
`not_implemented` marks v2 handlers that have not landed yet.

| HTTP status | Codes |
| --- | --- |
| `400` | `bad_request`, `path_invalid`, `source_hash_mismatch`, `disk_hash_mismatch` |
| `401` | `auth_required` |
| `403` | `forbidden`, `csrf_rejected`, `origin_rejected` |
| `404` | `vault_not_found`, `note_not_found`, `unresolved_note` |
| `409` | `api_version_unsupported`, `path_collision`, `save_conflict`, `mutation_id_reuse`, `server_instance_mismatch` |
| `413` | `request_too_large` |
| `429` | `rate_limited` |
| `501` | `not_implemented` |
| `500` | `internal` |

`internal` contains a request ID, not an implementation error string. The client
switches on the generated `V2ApiErrorKind` code.
