# Architecture

Tansu2 is a Rust server, a static TypeScript frontend, and an in-repo Markdown
editor. Markdown files remain ordinary files in each vault. The server stores
catalog and revision state in the XDG data path, keyed by stable vault ID. See
[Configuration](configuration.md).

## Data integrity

- `noteId` is durable identity. `path` is mutable metadata.
- `path_key` is the normalized live-path uniqueness key.
- Each accepted content-changing write has a full recoverable snapshot.
- A stale save preserves canonical content and creates a conflict draft.
- Mutations within one vault stay serialized by its operation mutex.
- One server process owns a vault root at a time. Startup takes an exclusive
  advisory lock on the root directory itself, so any path or config naming the
  same directory collides. The lock is held from startup reconciliation until
  the runtime drops or the process exits. A second owner fails startup with
  `vault root ... is already owned by another Tansu2 server`.
- Search is derived state. Indexing failure cannot fail an accepted write.
- Watcher events request reconciliation instead of making semantic edits.
- Bootstrap returns note metadata, not all note bodies.
- Inactive restored tabs do not fetch content until selected.
- Markdown files do not contain hidden Tansu IDs.
- V1 `z-images/` assets are vault-local opaque files.

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

## Ownership

| Area                    | Files                                                     |
| ----------------------- | --------------------------------------------------------- |
| Startup/config/runtime  | `src/main.rs`, `src/app.rs`, `src/config.rs`              |
| HTTP and route dispatch | `src/http.rs`, `src/api.rs`                               |
| Generated API contract  | `src/api_types.rs`, `web/ts/types.generated.ts`           |
| Paths and vault safety  | `src/paths.rs`, `src/config.rs`                           |
| SQLite catalog          | `src/catalog.rs`                                          |
| Snapshots and hashes    | `src/history.rs`                                          |
| Reconciliation          | `src/reconcile.rs`                                        |
| Search                  | `src/search.rs`                                           |
| Tags-only frontmatter   | `src/tags.rs`                                             |
| Vault orchestration     | `src/vault.rs`                                            |
| Frontend state/API      | `web/ts/app.ts`, `web/ts/app/v2-api.ts`, `web/ts/state.ts`, `web/ts/app/workspace-store.ts` |
| Frontend DOM/visuals    | `web/ts/view.ts`, `web/ts/dom.ts`, `web/static/app.css`   |
| Editor engine           | `web/ts/editor/`                                          |
| Dev/e2e fixtures        | `scripts/dev-fixture.mjs`, `scripts/test-fixture.mjs`, `tests/fixtures/` |

## Writes and recovery

The editor source uses LF line endings. Content writes maintain a compressed
snapshot, catalog state, and visible Markdown file. Delta saves reconstruct the
candidate from an exact base snapshot, verify the submitted final hash, and use
the same recoverable write path. Startup repair uses catalog and history state
to finish interrupted writes conservatively.

Create, save, import, restore, delete, rename, and conflict recovery all keep
history under `noteId`, not the current path.

The server rechecks the visible file against the saved disk hash before a
content-changing write. The vault mutex serializes Tansu2 operations, but the
recheck and file replacement are not an atomic compare-and-swap. A process that
writes the file between those steps, or through an open descriptor, can race
Tansu2. Use one writer per vault when that race matters.

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

- `notes` is a `Map<noteId, V2NoteMeta>`.
- The V2 API client validates network responses and scopes vault calls by stable
  server and vault identities.
- Workspace state stores tabs, closed tabs, selection, scroll position, mode,
  pins, and recents in browser IndexedDB. IndexedDB is browser-local and is not
  encrypted by Tansu2.
- Saved-note drafts and local-note drafts use separate journal records in
  browser IndexedDB. Recovery covers the latest successfully journaled
  checkpoint, not every keystroke. Browser storage can be cleared or evicted.
- The editor records its owning tab and session so a vault switch cannot sync
  old editor content into a new tab with the same `noteId`.

`web/ts/editor/` owns Markdown rendering, DOM serialization, selection, source
mode, undo/redo, formatting, paste handling, and extensions. The app owns note
lifecycle, persistence, assets, settings, tabs, and session state. See
[Editor](editor.md) for editor-specific behavior.
