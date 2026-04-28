# AGENTS.md

## Project overview

Tansu is a local-first note-taking app (Obsidian alternative). Notes are plain markdown files on disk. The backend is a single-threaded Rust HTTP server; the frontend is a Solid app around a framework-agnostic markdown editor package. Notes use `[[wiki-links]]` for cross-referencing and `![[image.webp]]` for embedded images.

## Documentation

- [Frontend architecture](docs/frontend-architecture.md)
- [md-wysiwyg architecture](docs/md-wysiwyg-architecture.md)
- [Search model](docs/SEARCH.md)
- [Offline resilience](docs/offline-resilience.md)
- [Security and encryption design](docs/SECURITY.md)
- [Package editor architecture](packages/md-wysiwyg/docs/architecture.md)
- [Markdown extension API](packages/md-wysiwyg/docs/extensions.md)

## Architecture

**Rust server** (no async runtime): raw TCP accept loop using `httparse` for HTTP parsing, `tantivy` for full-text search, `notify` for filesystem watching, `pulldown-cmark` for markdown stripping. All request/response types use `serde` JSON serialization.

**Frontend**: Solid + TypeScript compiled and bundled with `esbuild`. WYSIWYG editing uses a `contenteditable` editor with a source-mode toggle. The `@joshuarli98/md-wysiwyg` internal package owns markdown rendering, DOM-to-markdown serialization, selection/cursor preservation, undo/redo, and block/inline transforms. No CSS framework.

**`packages/md-wysiwyg`** — internal package aliased as `@joshuarli98/md-wysiwyg` in both the app bundle and tests (via `vitest.config.ts` alias). Source in `packages/md-wysiwyg/src/`:

- **markdown.ts** — Markdown→HTML renderer. Block parsing (headings, paragraphs, fenced code, lists with task items, blockquotes, callouts, tables, HR) and inline rendering (bold, italic, strikethrough, code, highlights, wiki-links, wiki-images, standard links/images, escaped chars). Exports `renderMarkdown(src)`, `renderMarkdownWithCursor(src, offset)` (injects a sentinel character at the cursor position so the DOM render can place a marker span), and `renderMarkdownWithSelection(src, selStart, selEnd)` (injects two sentinels so the DOM render can restore a selection range after re-render via `[data-md-sel-start]` / `[data-md-sel-end]` spans).
- **serialize.ts** — `domToMarkdown`: DOM→markdown serializer for the WYSIWYG editor. `getCursorMarkdownOffset(contentEl, range)`: computes the markdown offset of a DOM cursor by temporarily inserting a sentinel span, serializing, and finding the sentinel.
- **editor.ts** — Imperative browser editor handle. Creates the contenteditable/source DOM, wires rendering, selection, undo/redo, keyboard handling, transforms, and image paste.
- **editor-renderer.ts** / **editor-selection.ts** / **editor-undo.ts** / **editor-transactions.ts** — Internal controllers for HTML writes, cursor/selection restoration, undo history, and markdown-level transactions.
- **transforms.ts** — Block-level DOM transforms fired on Enter: typing `## ` converts the block to H2, `- ` to UL, ` ``` ` to code block, `---` to HR, etc.
- **inline-transforms.ts** — Inline transforms fired on input: closing backticks trigger code span wrapping, etc.
- **highlight.ts** — `highlightCode`: wraps `highlight.js` for fenced code block syntax highlighting.
- **diff.ts** — `computeDiff`/`renderDiff` for the revisions diff view.
- **merge.ts** — Line-based 3-way merge (LCS diff). Returns merged string or null on conflict.
- **util.ts** — `escapeHtml`, `stemFromPath`, cursor sentinels, and DOM helpers.

**SSE live reload**: single EventSource connection at `/events`. Server holds one SSE client at a time. File watcher events trigger `changed`/`deleted` SSE messages to the browser, which reloads or merges content.

## Threading model

- **Main thread**: blocking TCP accept loop. Handles one request at a time. Drains watcher events at the start of each request.
- **Watcher thread**: `notify::RecommendedWatcher` runs its own thread, sends `WatchEvent` variants over `mpsc::channel`.
- **Indexer thread**: spawned once at startup to do `full_reindex` (walks all `.md` files, builds tantivy index, single commit at end). The `Index` is `Clone` (wraps `Arc<IndexInner>` with `RwLock<IndexWriter>`), shared between the indexer thread and the main thread.

## Disk layout

All paths are relative to the notes directory passed as a CLI argument.

```
<notes-dir>/
  *.md                     # markdown notes (possibly in subdirectories)
  z-images/                # uploaded images (served at /z-images/*)
  .tansu/
    index/                 # tantivy search index files
    revisions/<stem>/      # per-note revision history
      <timestamp_ms>.md    # snapshot of note content before each save
    settings.json          # search/index settings (weights, fuzzy distance, recency boost, excluded folders)
    state.json             # session state (open tabs, active tab index, closed-tab stack)
```

## Rust crate structure

Dual-target crate: `src/lib.rs` exports all modules, `src/main.rs` is the server binary.

- **lib.rs** -- Re-exports all modules as a library crate (enables criterion benchmarks and the bench binary to import directly).
- **main.rs** -- `Server` struct, CLI arg parsing, TCP accept loop, request dispatch, all API handler methods, session management, encryption lifecycle. Defines serde request/response types inline.
- **crypto.rs** -- AES-256-GCM encryption, key wrapping, recovery keys, vault I/O. See [docs/SECURITY.md](docs/SECURITY.md) for design doc.
- **http.rs** -- HTTP primitives: `percent_decode`, `query_param`, `mime`, `write_headers`/`write_error`/`write_body`/`write_json`/`respond_json`, `serve_file` (uses `sendfile(2)` on macOS/Linux), `read_body`/`parse_body`, `normalize_into` (path traversal prevention), `mtime_secs`.
- **index.rs** -- `Index` (tantivy wrapper). Schema: `path` (STRING), `title` (TEXT), `content` (TEXT), `headings` (TEXT), `tags` (TEXT), `mtime` (u64), `links_to` (TEXT). Methods: `index_note`, `remove_note`, `search` (two-phase: exact/prefix/phrase first, fuzzy fallback), `get_backlinks`, `get_all_notes`, `full_reindex`. Uses lazy commits (`ensure_committed` before reads) and a `notes_cache` (`Mutex<Option<Vec<...>>>`) invalidated on writes/commits.
- **scanner.rs** -- Single-pass extraction of `#headings` and `[[wiki-links]]` from raw markdown. Returns `ScanResult { title, headings, links }`. Normalizes link targets (lowercase, strip path/extension).
- **strip.rs** -- `strip_markdown`: uses `pulldown-cmark` to convert markdown to plain text for search indexing. Skips code blocks.
- **revisions.rs** -- `save_revision` (copies current file content to `.tansu/revisions/<stem>/<timestamp_ms>.md`), `list_revisions` (sorted descending), `get_revision`.
- **settings.rs** -- `Settings` struct for search configuration, persisted to `.tansu/settings.json`. Fields: weight_title/headings/tags/content (f32), fuzzy_distance (u8), recency_boost (u8: 0=off, 1=day, 2=week, 3=month), result_limit (usize), show_score_breakdown (bool), excluded_folders (Vec<String>). All fields have serde defaults. Changing `excluded_folders` triggers a full reindex.
- **watcher.rs** -- `start_watcher`: sets up `notify::RecommendedWatcher`, filters to `.md` files only, ignores `.tansu/` directory, checks `self_writes` set to filter out server's own writes.
- **util.rs** -- `StrExt` trait: `truncate_chars` (by Unicode scalar count), `truncate_bytes` (snaps to `floor_char_boundary`).
- **bin/bench.rs** -- Quick ad-hoc benchmark binary (avg/p50/p99/min/max). Run with `make bench-quick`.

## Frontend structure

All app source is in `web/ts/`, bundled to `web/static/app.js`:

- **main.tsx** -- Mounts the Solid app.
- **app.tsx** -- Composes the visible shell and top-level overlays.
- **app-boot.ts** / **bootstrap.ts** -- Browser capability checks, locked-vault unlock flow, local-store/session startup, and SSE lifecycle primitives.
- **app-runtime.ts** -- Runtime wiring between top-level services, including wiki-link navigation and `serverStore` configuration.
- **ui-store.ts**, **tab-state.ts**, **server-store.ts** -- App state owners for transient UI state, tab/session state, and server/SSE lifecycle. Prefer explicit factory functions and runtime wiring over hidden cross-store imports.
- **api.generated.ts** -- Generated Rust-owned DTOs. Do not edit manually.
- **api.ts** -- Handwritten API wrapper for request construction, response normalization, and errors.
- **editor-adapter.ts** -- Narrow app-facing wrapper around `@joshuarli98/md-wysiwyg`.
- **editor.ts** -- Integration layer connecting the editor engine to active tabs, save/autosave, reload/conflicts, tags/frontmatter, backlinks, revisions, autocomplete, image resize, and app-level prefs.
- **features/editor/** -- Solid/editor shell pieces that keep the app tree reactive while the editor engine remains imperative.
- **search.tsx**, **settings.tsx**, **palette.tsx**, **input-dialog.tsx**, **overlay.tsx** -- App-owned overlays under the main Solid tree.
- **context-menu.tsx**, **revisions.tsx**, **backlinks.tsx** -- Specialized imperative or host-bound UI surfaces; keep them small and move them into the app tree if they grow into broader workflows.
- **local-store.ts** / **tab-state-storage.ts** -- IndexedDB and session/offline persistence. See [docs/offline-resilience.md](docs/offline-resilience.md).

## Key conventions

- **Atomic writes**: all note saves go through `atomic_write` (write to `.tmp`, then `rename`).
- **mtime-based conflict detection**: PUT `/api/note` accepts `expected_mtime`. If the file's current mtime differs, returns 409 with the disk content. Frontend shows a conflict banner with "Keep mine" / "Take theirs" options.
- **Self-write filtering**: server tracks paths it writes to in a `HashSet<PathBuf>` behind `Arc<Mutex<_>>`. The watcher callback checks and removes from this set to avoid re-indexing server's own writes.
- **Serde for all JSON**: request/response types are `#[derive(Serialize)]` / `#[derive(Deserialize)]` structs in `main.rs`. No manual JSON construction.
- **No async runtime**: everything is synchronous std. The server handles one request at a time on the main thread.
- **Encryption is opt-in**: `tansu encrypt <dir>` to enable, `tansu decrypt <dir>` to revert. Plaintext mode (no crypto.json) = no auth, no sessions.
- **Offline resilience**: session state and note content are cached in IndexedDB via `local-store.ts`. All note fetches go through `fetchNote()` which tries server first, falls back to IDB cache. Session state is dual-written to IDB and server; on SSE reconnect, `syncToServer()` flushes cached state. See `docs/offline-resilience.md` for full architecture.
- **Minimal dependencies**: 6 runtime crates (httparse, tantivy, notify, serde, serde_json, pulldown-cmark). Dev-only: criterion for benchmarks.
- **Wiki-link resolution**: links are matched by filename stem (case-insensitive). Backlinks are indexed in tantivy via the `links_to` field. Rename updates all referencing notes.
- **Image handling**: paste triggers WebP conversion client-side, uploads raw blob to `/api/image`, server stores in `z-images/` with dedup naming.
- **Custom snippet generator**: tantivy's `SnippetGenerator` cannot highlight fuzzy-matched terms because `FuzzyTermQuery` doesn't implement `query_terms()` (the expanded terms exist inside `AutomatonWeight` but aren't publicly exposed). Our `make_snippet` in `index.rs` tokenizes stored content, prefers exact quoted-phrase anchors when present, highlights exact/prefix matches, and only highlights edit-distance-1 fuzzy matches for non-quoted searches. Do not replace this with tantivy's built-in snippet generator.
- **Source-text formatting**: all format operations (bold, italic, strikethrough, highlight, headings, code fence, indent/dedent, clear formatting) operate on markdown strings via pure functions in `packages/md-wysiwyg/src/format-ops.ts`. App code applies them through the editor handle rather than mutating DOM.
- **Markdown HTML boundary**: markdown rendering and contenteditable HTML writes belong in `packages/md-wysiwyg`. `web/ts` must not call render functions directly or assign markdown HTML into app-owned DOM. Enforced by `web/ts/renderer.test.ts`.
- **Custom undo/redo**: `packages/md-wysiwyg` maintains explicit markdown snapshots and restores selections through sentinel spans. Browser DOM undo is suppressed for editor-controlled operations.

## Coding style

- Keep complexity only when it protects concrete behavior: local-first saves, conflict handling, cursor restoration, offline resilience, or security. Do not add abstraction for shape alone.
- Keep ownership boundaries explicit. Solid owns ordinary app UI and reactive state; `packages/md-wysiwyg` owns imperative contenteditable behavior.
- Prefer props, narrow service interfaces, and factory functions over hidden cross-module imports. Avoid adding new module-level singletons unless ownership is obvious.
- Use imperative DOM only for browser integration that is inherently imperative: contenteditable, selection/range handling, clipboard/image paste, WebAuthn, SSE lifecycle, or host-bound positioned UI.
- Treat `web/ts/editor.ts` as a coordinator, not a second editor engine. If it grows, extract app-integration responsibilities without moving editor internals out of `packages/md-wysiwyg`.
- Preserve architecture guardrails and update docs/tests when changing boundaries.

## Search model

See [docs/SEARCH.md](docs/SEARCH.md) for the full search model.
Rich tag query syntax such as `tag:foo` is intentionally not supported.

## Save flow

```
User types in editor
  -> packages/md-wysiwyg onChange
  -> web/ts/editor.ts onEditorTabMutation()
  -> updateTabDraft(path, { content, tags })
  -> scheduleAutosave()

Autosave idle or Cmd+S
  -> saveController.saveCurrentNote()
  -> saveNote(path, content, tab.mtime)
  -> classifySaveResult()
       clean          -> markClean(); serverStore.notifyFilesChanged(path)
       false-conflict -> forceSaveNote(); markClean(); notifyFilesChanged(path)
       real-conflict  -> silent autosave skips banner; explicit save shows conflict banner

SSE live-reload path (external edit)
  -> server-store.ts receives "changed" / "deleted"
  -> notifyFilesChanged(path) invalidates file views
  -> if changed path is active, getNote(path)
  -> editor.reloadFromDisk(content, mtime)
       clean tab -> loadContent(); markClean()
       dirty tab -> handleReloadConflict()
```

## API surface

| Method | Path                      | Description                                                |
| ------ | ------------------------- | ---------------------------------------------------------- |
| GET    | `/api/notes`              | List all notes (path + title)                              |
| GET    | `/api/note?path=`         | Get note content + mtime                                   |
| PUT    | `/api/note?path=`         | Update note (with conflict detection via `expected_mtime`) |
| POST   | `/api/note?path=`         | Create new note                                            |
| DELETE | `/api/note?path=`         | Delete note (saves revision first)                         |
| POST   | `/api/rename`             | Rename note + update backlinks                             |
| GET    | `/api/search?q=&path=`    | Full-text search (optional path filter for in-note search) |
| GET    | `/api/backlinks?path=`    | Get notes that link to this note                           |
| POST   | `/api/image`              | Upload image (X-Filename header for suggested name)        |
| GET    | `/api/revisions?path=`    | List revision timestamps                                   |
| GET    | `/api/revision?path=&ts=` | Get revision content                                       |
| POST   | `/api/restore?path=&ts=`  | Restore a revision                                         |
| GET    | `/api/state`              | Get session state (open tabs, closed-tab stack)            |
| PUT    | `/api/state`              | Save session state                                         |
| GET    | `/api/settings`           | Get search/index settings                                  |
| PUT    | `/api/settings`           | Update settings (excluded_folders change triggers reindex) |
| GET    | `/events`                 | SSE stream (events: `connected`, `changed`, `deleted`)     |
| GET    | `/api/status`             | App status (locked state, PRF credentials)                 |
| POST   | `/api/unlock`             | Unlock with recovery key or PRF output                     |
| GET    | `/api/lock`               | Lock the app (clears session)                              |
| POST   | `/api/prf/register`       | Register a WebAuthn PRF credential                         |
| DELETE | `/api/prf`                | Remove a PRF credential                                    |

Static files are served from `/static/*` and images from `/z-images/*`. All other GET paths serve `index.html` (SPA-style). When encrypted and locked, non-API requests redirect to `/`.

## Build commands

```sh
# Type checking
tsgo --noEmit                                      # type-check web/ts/
tsgo -p packages/md-wysiwyg/tsconfig.json --noEmit # type-check the md-wysiwyg package
make check                                         # both of the above + cargo check

# Bundling
pnpm run bundle-dev   # dev bundle (no minify, NODE_ENV=development)
pnpm run bundle       # production bundle (minified, NODE_ENV=production)

# Testing
vitest run            # run web/ts/*.test.ts (or: make test-ts)
cd packages/md-wysiwyg && vitest run   # run package tests (or: make test-pkg)
cargo test            # run Rust tests (or: make test-rs)

# Development server
make dev              # lint + type-check + bundle-dev + cargo run

# Linting / formatting
oxlint --quiet web/ts/   # TS linter (or: make lint-ts)
oxfmt web/ts/            # TS formatter

# Benchmarks
make bench            # criterion benchmarks (baselines in target/criterion/)
make bench-quick      # ad-hoc bench binary against ~/notes
```

The server binary expects `web/index.html` and `web/static/` to be next to the executable or in the current directory.

## Testing

`cargo test` runs Rust unit tests:

- **http.rs**: percent decoding, query param parsing, path normalization, mtime, MIME types
- **scanner.rs**: heading/tag/wiki-link extraction, normalization, edge cases
- **strip.rs**: markdown-to-plaintext conversion
- **revisions.rs**: save/list/get revisions, subdirectory paths, rapid save dedup
- **index.rs**: edit distance, snippets (exact/fuzzy/multibyte/HTML escaping), dirty flag, lazy commit + cache
- **settings.rs**: defaults, partial deserialization, round-trip
- **util.rs**: truncate_bytes/truncate_chars with multibyte edge cases
- **crypto.rs**: encryption/decryption round-trip, key wrapping, recovery key parsing, PRF unlock, tampered ciphertext rejection

`vitest run` runs `web/ts/*.test.ts` and `web/ts/*.test.tsx` with `happy-dom` as the DOM environment. Coverage thresholds are configured in `vitest.config.ts`. Notable test files:

- **format-ops.test.ts** — pure unit tests for all markdown format operations (no DOM)
- **architecture.test.ts** — enforcement test for frontend/editor package boundaries and acyclic production imports
- **renderer.test.ts** — enforcement test for markdown-rendering, `innerHTML`, fixed-root query, and Solid listener guardrails
- **format-toolbar.test.ts** — floating toolbar visibility, button actions, positioning
- **editor.test.ts** — save flow, conflict classification, reload logic

`cd packages/md-wysiwyg && vitest run` runs the package's own test suite (cursor offset, rendering, serialization, transforms, diff, merge, highlight). Notable:

- **render-selection.test.ts** — tests for `renderMarkdownWithSelection` sentinel placement

Type checking: `tsgo` (strict mode). The md-wysiwyg package has its own `tsconfig.json`.

## Benchmarking

Criterion benchmarks in `benches/index.rs` with a counting global allocator that reports alloc count, total bytes, and net retained bytes per operation. Baselines stored in `target/criterion/`. Run `make bench` to compare against previous baselines.

Key operations benchmarked: `get_all_notes`, `index_note` (deferred write only), `index_note + search` (realistic write-read cycle including commit), exact/fuzzy/multi-term/miss search queries.

## Dev conventions

- Tests live alongside source: `foo.rs` has `#[cfg(test)] mod tests`, `foo.ts` has `foo.test.ts`
- Pre-commit hooks are not used; user verifies commits independently
- Never push to remote
- Never build release binaries (`cargo build --release`)

## Style

Light mode only. System font stack (`-apple-system, ...`). Max-width 800px editor. GitHub-flavored color palette (CSS custom properties in `:root`). No framework CSS. All styles in `web/static/style.css`.
