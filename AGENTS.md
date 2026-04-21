# AGENTS.md

## Project overview

Tansu is a local-first note-taking app (Obsidian alternative). Notes are plain markdown files on disk. The backend is a single-threaded Rust HTTP server; the frontend is vanilla TypeScript with no framework. Notes use `[[wiki-links]]` for cross-referencing and `![[image.webp]]` for embedded images.

## Architecture

**Rust server** (no async runtime): raw TCP accept loop using `httparse` for HTTP parsing, `tantivy` for full-text search, `notify` for filesystem watching, `pulldown-cmark` for markdown stripping. All request/response types use `serde` JSON serialization.

**Frontend**: vanilla TypeScript compiled and bundled with `esbuild`. WYSIWYG editing via `contenteditable` with a source-mode toggle. Custom markdown renderer (`markdown.ts`) converts markdown to HTML — no external markdown library. `highlight.js` for code block syntax highlighting. No framework, no CSS framework.

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
- **crypto.rs** -- AES-256-GCM encryption, key wrapping, recovery keys, vault I/O. See `SECURITY.md` for design doc.
- **http.rs** -- HTTP primitives: `percent_decode`, `query_param`, `mime`, `write_headers`/`write_error`/`write_body`/`write_json`/`respond_json`, `serve_file` (uses `sendfile(2)` on macOS/Linux), `read_body`/`parse_body`, `normalize_into` (path traversal prevention), `mtime_secs`.
- **index.rs** -- `Index` (tantivy wrapper). Schema: `path` (STRING), `title` (TEXT), `content` (TEXT), `headings` (TEXT), `tags` (TEXT), `mtime` (u64), `links_to` (TEXT). Methods: `index_note`, `remove_note`, `search` (two-phase: exact/prefix/phrase first, fuzzy fallback), `get_backlinks`, `get_all_notes`, `full_reindex`. Uses lazy commits (`ensure_committed` before reads) and a `notes_cache` (`Mutex<Option<Vec<...>>>`) invalidated on writes/commits.
- **scanner.rs** -- Single-pass extraction of `#headings`, `#tags`, and `[[wiki-links]]` from raw markdown. Returns `ScanResult { title, headings, tags, links }`. Normalizes link targets (lowercase, strip path/extension).
- **strip.rs** -- `strip_markdown`: uses `pulldown-cmark` to convert markdown to plain text for search indexing. Skips code blocks.
- **revisions.rs** -- `save_revision` (copies current file content to `.tansu/revisions/<stem>/<timestamp_ms>.md`), `list_revisions` (sorted descending), `get_revision`.
- **settings.rs** -- `Settings` struct for search configuration, persisted to `.tansu/settings.json`. Fields: weight_title/headings/tags/content (f32), fuzzy_distance (u8), recency_boost (u8: 0=off, 1=day, 2=week, 3=month), result_limit (usize), show_score_breakdown (bool), excluded_folders (Vec<String>). All fields have serde defaults. Changing `excluded_folders` triggers a full reindex.
- **watcher.rs** -- `start_watcher`: sets up `notify::RecommendedWatcher`, filters to `.md` files only, ignores `.tansu/` directory, checks `self_writes` set to filter out server's own writes.
- **util.rs** -- `StrExt` trait: `truncate_chars` (by Unicode scalar count), `truncate_bytes` (snaps to `floor_char_boundary`).
- **bin/bench.rs** -- Quick ad-hoc benchmark binary (avg/p50/p99/min/max). Run with `make bench-quick`.

## Frontend structure

All source in `web/ts/`, bundled to `web/static/app.js`:

- **main.ts** -- Entry point. Wires up editor, tabs, search, SSE, keyboard shortcuts, wiki-link click handler, rename handler.
- **editor.ts** -- WYSIWYG editor. `contenteditable` div + hidden textarea for source mode. Autosaves 1.5 s after last keystroke (silent: skips conflict banner); ^S saves immediately. Handles conflict detection (mtime-based), reload-from-disk (3-way merge for dirty tabs), image paste (converts to WebP via OffscreenCanvas, uploads), inline formatting (bold/italic), backlinks display.
- **tab-state.ts** -- Pure tab state logic (no DOM). Open/close/switch tabs, closed-tab stack (bounded LIFO, max 20), session persistence (dual-write to IDB + server), offline note fetching via `fetchNote()` (try server → cache to IDB → fall back to IDB). Exports `reopenClosedTab()`, `syncToServer()`, `clearClosedTabs()`.
- **tabs.ts** -- Tab bar DOM rendering. Re-exports all tab-state functions. Context menu (right-click) for rename/delete/close.
- **local-store.ts** -- IndexedDB wrapper for offline resilience. Database `"tansu"` with three stores: `kv` (session state), `notes` (cached content), `queue` (reserved for future write queue). All ops gracefully no-op when store isn't opened. See `docs/offline-resilience.md`.
- **search.ts** -- Search modal (Cmd+K). Arrow key navigation, fires on every keystroke. Supports scoped search (Cmd+F searches within current note). "Create note" option at bottom of results.
- **api.ts** -- Typed fetch wrappers for all API endpoints.
- **serialize.ts** -- `domToMarkdown`: DOM-to-markdown serializer for the WYSIWYG editor. Handles headings, lists, blockquotes, code blocks, tables, inline formatting, wiki-links, image embeds.
- **transforms.ts** -- Block-level transforms on Enter: typing `## ` converts to H2, `- ` to UL, ` ``` ` to code block, `---` to HR, etc.
- **autocomplete.ts** -- Wiki-link autocomplete dropdown. Triggered by `[[` in the editor. Caches note list, filters as you type, completes on Enter/Tab.
- **markdown.ts** -- Custom markdown-to-HTML renderer. Block parsing (headings, paragraphs, fenced code, lists with task items, blockquotes, callouts, tables, HR) and inline rendering (bold, italic, strikethrough, code, highlights, wiki-links, wiki-images, standard links/images, escaped chars).
- **wikilinks.ts** -- Click handler delegate for `[[wiki-links]]` rendered by markdown.ts.
- **merge.ts** -- Line-based 3-way merge (LCS diff). Returns merged string or null on conflict.
- **revisions.ts** -- Revisions side panel. Lists timestamps, preview on click, restore with confirmation.
- **palette.ts** -- Command palette modal (Cmd+P). Filterable list of all commands with shortcut hints. `registerCommands()` called from main.ts.
- **settings.ts** -- Settings modal (Cmd+Shift+S). Sliders for search weights, dropdowns for fuzzy distance and recency boost, checkbox for score breakdown, text input for excluded folders. Security section for PRF credential management and lock. Saves to server via PUT `/api/settings`.
- **webauthn.ts** -- WebAuthn PRF extension for biometric unlock (Face ID / Touch ID).
- **util.ts** -- `escapeHtml`, `relativeTime`, `stemFromPath`.

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

## Search model

- **Indexed fields**: search operates on `title`, `headings`, `tags`, and stripped `content`. `path` is not part of full-text scoring; it is only used as an exact filter for scoped in-note search.
- **Field weights**: `weight_title`, `weight_headings`, `weight_tags`, and `weight_content` are multiplicative boosts applied at query-build time. Defaults are title `10.0`, headings `5.0`, tags `2.0`, content `1.0`.
- **Tokenization**: query text is split on non-alphanumeric characters to mirror Tantivy's default tokenizer. That means `jpeg-xl` searches as `jpeg` + `xl`, and `some_function` searches as `some` + `function`.
- **Quoted queries**: double-quoted text adds a literal phrase constraint. Example: `"oat groats"` still contributes `oat` and `groats` as normal terms, but also requires those tokens to appear adjacent and in order via `PhraseQuery`.
- **Phase 1 query strategy**: each non-quoted term becomes a MUST clause. Within each term, all search fields are OR'd together with:
  exact term match at `1.0x` the field weight
  prefix match via `PhrasePrefixQuery` at `0.8x` the field weight
- **Phrase strategy**: each quoted phrase becomes an additional MUST clause. Within that clause, the phrase can match any of the four search fields, boosted by that field's full weight.
- **Phase 2 fuzzy fallback**: if phase 1 returns fewer than 5 results and `fuzzy_distance > 0`, the search is re-run with the same exact/prefix/phrase clauses plus fuzzy matching on `content` only, boosted at `0.6x` content weight. `fuzzy_distance` is a raw Tantivy edit distance (`0`, `1`, or `2` in the UI).
- **Recency boost**: after Tantivy returns scored hits, Tansu applies a ferrisearch-style post-hoc multiplier based on indexed file `mtime`. Setting values are `0=disabled`, `1=24 hours`, `2=7 days`, `3=30 days`; default is `2` (week). The multiplier is `1 + exp(decay * days / 1000)`, with decay constants `-3.0`, `-0.3`, and `-0.1` respectively. This boosts newer files without changing which textual clauses matched.
- **Result ordering**: when recency boost is enabled, final ordering is by the boosted score after the post-hoc multiplier. When disabled, results stay in Tantivy's native score order.
- **Score breakdown**: the UI's per-field breakdown uses Tantivy `Query::explain()` on each individual sub-query, mirroring ferrisearch's strategy. For each field, Tansu separately explains the exact term query, prefix query, fuzzy query (content only, fuzzy phase only), and phrase query, then sums those explanation values. The breakdown excludes the post-hoc recency multiplier, so it explains textual relevance only.
- **Snippet behavior**: snippets are built from stored stripped content, not raw markdown. For quoted searches, snippet anchoring prefers the first exact phrase occurrence; for normal searches, it anchors on the first exact/prefix/fuzzy-matching token.

## Save flow

```
User types in editor
       │
       ├─► markDirty(path) ──► emit("tab:render") ──► dirty dot appears in tab
       │
       └─► scheduleAutosave()  [resets 1.5 s debounce timer]
                │
                │ 1.5 s idle          ^S pressed
                ▼                         │
        autosave fires            clearTimer (if pending)
                │                         │
                └──────────┬──────────────┘
                           ▼
                   saveCurrentNote()
                    silent=true          silent=false (^S)
                           │
                           ▼
                       _doSave()
                           │
                  GET getCurrentContent()
                  PUT /api/note  { expected_mtime }
                           │
                           ▼
                  classifySaveResult()
                           │
             ┌─────────────┼──────────────────┐
             ▼             ▼                  ▼
          "clean"   "false-conflict"    "real-conflict"
             │             │                  │
        markClean()   PUT mtime=0        silent? skip
        emit(            markClean()     : showConflictBanner()
         "files:changed") emit(
             │            "files:changed")
             ▼
    filenav re-renders
    server reindexes note


SSE live-reload path (external edit):

  Disk change ──► watcher thread ──► SSE "changed" / "deleted"
                                              │
                                    frontend SSE handler
                                              │
                                   tab dirty? ─────────────┐
                                      │ no                 │ yes
                                      ▼                    ▼
                               loadContent()     showConflictBanner()
                               markClean()       "Keep mine" / "Take theirs"
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

| GET | `/api/status` | App status (locked state, PRF credentials) |
| POST | `/api/unlock` | Unlock with recovery key or PRF output |
| POST | `/api/lock` | Lock the app (clears session) |
| POST | `/api/prf/register` | Register a WebAuthn PRF credential |
| DELETE | `/api/prf` | Remove a PRF credential |

Static files are served from `/static/*` and images from `/z-images/*`. All other GET paths serve `index.html` (SPA-style). When encrypted and locked, non-API requests redirect to `/`.

## Build commands

```sh
tsgo --noEmit    # type-check TypeScript (TS7 native, no emit)
pnpm run bundle   # bundle frontend
vitest run        # run all TypeScript tests
cargo build       # build Rust server (never use --release)
cargo test        # run Rust tests
make build        # all of the above
make dev          # TS build + run server
make bench        # criterion benchmarks (baselines in target/criterion/)
make bench-quick  # ad-hoc bench binary against ~/notes
```

The server binary expects `web/index.html` and `web/static/` to be next to the executable or in the current directory.

## Testing

`cargo test` runs 98 unit tests:

- **http.rs**: percent decoding, query param parsing, path normalization, mtime, MIME types
- **scanner.rs**: heading/tag/wiki-link extraction, normalization, edge cases
- **strip.rs**: markdown-to-plaintext conversion
- **revisions.rs**: save/list/get revisions, subdirectory paths, rapid save dedup
- **index.rs**: edit distance, snippets (exact/fuzzy/multibyte/HTML escaping), dirty flag, lazy commit + cache
- **settings.rs**: defaults, partial deserialization, round-trip
- **util.rs**: truncate_bytes/truncate_chars with multibyte edge cases

- **crypto.rs**: encryption/decryption round-trip, key wrapping, recovery key parsing, PRF unlock, tampered ciphertext rejection

TypeScript tests: `vitest run` runs 25 test files with coverage enforcement (79% line/function threshold). `fake-indexeddb` provides in-memory IDB for testing offline resilience paths.

Type checking: `tsgo` (strict mode, `noEmit`).

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
