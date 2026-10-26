# Architecture

Tansu is a Rust server, a static TypeScript frontend, and an in-repo Markdown
editor. Markdown files remain ordinary files in each vault. The server stores
catalog and revision state in the XDG data path, keyed by stable vault ID. See
[Configuration](configuration.md).

Cloudflare-native/serverless deployment is not implemented. The proposed
native-preserving portable-core architecture is in
[Serverless architecture](serverless-architecture.md).

The [product scope](product-backlog.md) rejects in-app AI and automatic
related-note recommendations. Tag suggestions reuse vault-local search and
require explicit selection before changing note content.
Suggestion code loads on request so the feature stays out of the initial bundle.

## Data integrity

`noteId` is durable identity; `path` is mutable metadata. Accepted writes,
conflicts, reconciliation, and derived search state follow the contracts in
[API](api.md). Markdown files contain no Tansu IDs, and V1 `z-images/` assets
are vault-local opaque files.

One server process owns a vault root at a time. Startup locks the root directory
through reconciliation and runtime shutdown, so configs naming the same
directory collide. Backlinks, outgoing links, and previews are derived from
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
the same recoverable write path. Startup repair uses catalog and history state
to finish interrupted writes conservatively.

Create, save, import, restore, delete, rename, and conflict recovery all keep
history under `noteId`, not the current path.

The server rechecks the visible file against the saved disk hash before a
content-changing write. The vault mutex serializes Tansu operations, but the
recheck and file replacement are not an atomic compare-and-swap. A process that
writes the file between those steps, or through an open descriptor, can race
Tansu. Use one writer per vault when that race matters.

## Reconciliation

Reconciliation applies these rules:

- A same-path hash change is an external edit unless the file still matches the
  last visible hash, in which case reconciliation restores the accepted snapshot.
- An exact-hash move preserves identity only when the match is unambiguous.
- A missing visible file with a valid snapshot becomes a tombstone.
- A moved-and-edited file becomes a delete plus a new note.
- Invalid UTF-8, case collisions, corrupt or missing snapshots, and catalog/file
  mismatches become unresolved state.

Title, mtime, filename similarity, and fuzzy content matching do not preserve
identity.

## Frontend state

The frontend scopes API calls by server and vault identity. Workspace state,
tabs, and draft checkpoints live in browser IndexedDB, which is not encrypted
and may be cleared or evicted. Recovery covers the latest journaled checkpoint,
not every keystroke.

`web/ts/editor/` owns Markdown editing behavior. The app owns tabs, each tab's
editor session and view, settings, and the shared asset URL cache. A per-note
`DocumentController` accepts saved-note load, retry, reconciliation, rename, and
image-fetch completions only for the session and server/vault identity that
issued them. It cancels cancellable tasks when that session is detached and
tracks mutations through close and vault changes; a reopened note waits for
prior mutations before loading. Asset requests for unsaved local drafts remain
app-scoped because those drafts do not yet have a durable note identity. See
[Editor](editor.md).
