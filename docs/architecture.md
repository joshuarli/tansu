# Architecture

Tansu2 is a Rust server, a static TypeScript frontend, and an in-repo Markdown
editor. Markdown files remain ordinary files in each vault. App-managed state
uses the XDG data path. See [Configuration](configuration.md).

## Data integrity

- `noteId` is durable identity. `path` is mutable metadata.
- `path_key` is the normalized live-path uniqueness key.
- Each accepted content-changing write has a full recoverable snapshot.
- A stale save preserves canonical content and creates a conflict draft.
- Search is derived state. Indexing failure cannot fail an accepted write.
- Watcher events request reconciliation instead of making semantic edits.
- Bootstrap returns note metadata, not all note bodies.
- Inactive restored tabs do not fetch content until selected.
- Markdown files do not contain hidden Tansu IDs.
- V1 `z-images/` assets are vault-local opaque files.

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
| Frontend state/API      | `web/ts/app.ts`, `web/ts/api.ts`, `web/ts/state.ts`       |
| Frontend DOM/visuals    | `web/ts/view.ts`, `web/ts/dom.ts`, `web/static/app.css`   |
| Editor engine           | `web/ts/editor/`                                          |
| Dev/e2e fixture vaults  | `scripts/test-fixture.mjs`, `tests/fixtures/test-vaults/` |

## Writes and recovery

Content writes canonicalize Markdown and maintain a compressed snapshot,
catalog state, and visible Markdown file. Delta saves reconstruct the candidate
from an exact base snapshot, verify the submitted final hash, and use the same
recoverable write path. Startup repair uses catalog and history state to finish
interrupted writes conservatively.

Create, save, import, restore, delete, rename, and conflict recovery all keep
history under `noteId`, not the current path.

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

- `notes` is a `Map<noteId, NoteMeta>`.
- Tabs store `noteId`. Only the active tab mounts an editor.
- Inactive tabs may hold in-memory drafts. Session state does not persist them.
- Session state stores open tabs, the active note, closed tabs, cursor offsets,
  and source mode.
- The mounted editor records its owner note id so a tab switch cannot sync old
  editor content into the newly active note.

`web/ts/editor/` owns Markdown rendering, DOM serialization, selection, source
mode, undo/redo, formatting, paste handling, and extensions. The app owns note
lifecycle, persistence, assets, settings, tabs, and session state. See
[Editor](editor.md) for editor-specific behavior.
