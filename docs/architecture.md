# Architecture

Tansu is a Rust server, a static TypeScript frontend, and an in-repo Markdown
editor. Markdown files remain ordinary files in each vault. The server stores
catalog and revision state in the XDG data path, keyed by stable vault ID. See
[Configuration](configuration.md).

The [product scope](product-backlog.md) rejects in-app AI and automatic
related-note recommendations. Tag suggestions reuse vault-local search and
require explicit selection before changing note content.
Suggestion code loads on request so the feature stays out of the initial bundle.

## Data integrity

`noteId` is durable identity; `path` is mutable metadata. Accepted writes,
conflicts, reconciliation, and derived search state follow the contracts in
[API](api.md). Markdown files contain no Tansu IDs, and V1 `z-images/` assets
are vault-local opaque files.

One server process owns a vault root at a time. Startup locks each opened root
through reconciliation and runtime shutdown. A vault that fails to open remains
listed as degraded while other vaults stay available. Previews are derived from
live notes and files in `src/links.rs`.

## Server runtime

The transport accepts HTTP/1 and HTTP/2 prior-knowledge connections. It uses
pinned runtime-neutral Hyper and H2 forks with async-executor, async-io, and
futures-lite I/O, and has no Tokio dependency. `serve_listener_with_shutdown`
owns the executor and blocks the calling thread until its `CancellationToken`
is canceled. The CLI maps process termination signals into the same token.

Each `VaultRuntime` owns its search and watcher worker threads. Workers hold a
`Weak` runtime reference, so dropping the last runtime handle or calling
`App::shutdown` stops and joins them; `serve_listener_with_shutdown` calls
`App::shutdown` after the server stops. Shutdown aborts queued search jobs, and
the next start rebuilds search from canonical content.

## Writes and recovery

The editor source uses LF line endings. Content writes maintain a compressed
snapshot, catalog state, and visible Markdown file. Delta saves reconstruct the
candidate from an exact base snapshot, verify the submitted final hash, and use
the same recoverable write path.

### Pending materialization

A mutation commits its catalog row and snapshot before the visible file step.
If that step fails, the mutation stays `pending_materialization` and the pending
repair owns the note until it ends the mutation. Startup, watcher
reconciliation, mutation replay, and every per-note read or write run the repair
before anything else touches the note. A per-note request whose repair still
fails with an I/O error returns `409 pending_materialization` and leaves the
note unchanged.

The repair resolves each kind against the visible bytes:

| Kind | Visible state | Result |
| --- | --- | --- |
| any | accepted snapshot missing or corrupt | note unresolved |
| save, save delta, restore | candidate, pre-image, or missing | candidate written; `accepted` |
| save, save delta, restore | other valid UTF-8 | external edit recorded; candidate kept as a conflict draft; `conflict` |
| save, save delta, restore | invalid UTF-8 | note unresolved |
| create | candidate or missing | candidate written; `accepted` |
| create | other bytes | note unresolved; reconciliation imports the file as a separate note |
| rename | destination free or candidate | move finished; an externally edited source file stays; `accepted` |
| rename | destination occupied and source intact, or source edited and destination free | catalog path reverted to the source |
| rename | destination occupied and source not intact | note unresolved |
| delete | expected bytes or missing | file removed; `accepted` |
| delete | other bytes | file kept; `accepted`; reconciliation imports it as a new note |

The conflict outcome commits the external-edit revision, the draft, the mutation
state, and the vault event in one catalog transaction, and its draft is based on
the content revision before the accepted save. The unresolved and
reverted-rename outcomes delete the mutation record with the note change, so a
replay runs as a new request and fails with `unresolved_note` or
`path_collision`. Pending recovery writes a missing visible file from its snapshot.

Create, save, import, restore, delete, rename, and conflict recovery all keep
history under `noteId`, not the current path.

The server rechecks the visible file against the saved disk hash before a
content-changing write. The vault mutex serializes Tansu operations, but the
recheck and file replacement are not an atomic compare-and-swap. A process that
writes the file between those steps, or through an open descriptor, can race
Tansu. Use one writer per vault when that race matters.

## Reconciliation

Reconciliation skips notes owned by pending mutations and applies these rules
to the remaining notes:

- A same-path hash change is an external edit unless the file still matches the
  last visible hash, in which case reconciliation restores the accepted snapshot.
- An exact-hash move preserves identity only when the match is unambiguous.
- A path whose case changes, while its path key stays the same, is an external
  rename of that note. Content reconciliation then uses the observed path.
- A file that is physically missing, or omitted because its folder is excluded,
  becomes a tombstone when its snapshot is valid. The snapshot stays. A
  completed create, save, rename, or import does not recreate the file.
  Unfinished materialization is recovered from pending mutation state before
  reconciliation.
- A moved-and-edited file becomes a delete plus a new note.
- Invalid UTF-8, case collisions, corrupt or missing snapshots, and catalog/file
  mismatches become unresolved state.

Title, mtime, filename similarity, and fuzzy content matching do not preserve
identity.

## Frontend state

The frontend scopes API calls by server and vault identity. Workspace state,
tabs, and draft checkpoints live in browser IndexedDB, which is not encrypted
and may be cleared or evicted. Recovery covers the latest journaled checkpoint,
not every keystroke. A pending local create replays the path, content, and
source hash stored with its mutation id. A pending checkpoint written before
that request was stored keeps its source and is not resubmitted.

`web/ts/editor/` owns Markdown editing behavior. The app owns tabs, each tab's
editor session and view, settings, and the shared asset URL cache. A per-note
`DocumentController` accepts saved-note load, retry, reconciliation, rename, and
image-fetch completions only for the session and server/vault identity that
issued them. It cancels cancellable tasks when that session is detached and
tracks mutations through close and vault changes; a reopened note waits for
prior mutations before loading. Asset requests for unsaved local drafts remain
app-scoped because those drafts do not yet have a durable note identity. See
[Editor](editor.md).
