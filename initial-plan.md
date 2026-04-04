# Tansu: Architecture Plan

## Context

Building a local-first Obsidian alternative. A Rust server watches a directory of `.md` files, maintains a tantivy search index, and serves a vanilla TypeScript SPA. Ruthlessly simple: minimal httparse-based server (modeled on ~/d/srv), no framework frontend, light mode only.

## Decisions

- **HTTP server**: httparse-based, single-threaded accept loop (srv pattern). No axum/actix.
- **Live reload**: SSE (`text/event-stream`), no WebSocket. Zero extra crates.
- **Image paste**: Client-side webp conversion (OffscreenCanvas, same as obsidian-webp-paste). Server just saves bytes.
- **Revisions**: Full copies in `.tansu/revisions/{path-stem}/{timestamp}.md`. No diffing, no DB.
- **Backlinks**: Tantivy `links_to` field. Backlink query = search that field.
- **Conflict detection**: mtime-based. PUT sends `expected_mtime`, server rejects on mismatch (409).
- **Edition**: 2024 (nightly)
- **Editor**: Vanilla contenteditable (no ProseMirror/Tiptap) with source mode toggle as escape hatch.
- **Syntax highlighting**: highlight.js vendored, v1 feature.
- **Rename**: App UI rename (right-click tab or command) with auto-update of all wiki-links referencing the renamed note.
- **New note**: Search modal creates empty file at root, opens in tab.
- **Startup indexing**: Background — server serves immediately, index builds on a separate thread. Search returns partial results until complete.
- **Search excerpts**: tantivy's built-in snippet/highlight API.
- **Logging**: stdout, method/path/status/timing per request. `-q` flag to suppress.
- **Paste handling**: all external pastes stripped to plain text.
- **Single client**: SSE endpoint enforces one connected client. Second connection gets 409.

## Disk Layout

```
~/notes/                     # CLI arg: the watched directory
  .tansu/
    index/                   # tantivy index
    revisions/
      subfolder/
        my-note/
          1712345678.md      # full copy, unix timestamp
  z-images/
    photo.webp
  some-note.md
```

## Rust Dependencies

```toml
[package]
name = "tansu"
version = "0.1.0"
edition = "2024"

[dependencies]
httparse = "1"
tantivy = "0.22"
notify = "7"
serde_json = "1"
pulldown-cmark = { version = "0.12", default-features = false }
```

Five dependencies. pulldown-cmark is used to strip markdown syntax before indexing content in tantivy (yields cleaner search tokens). All HTML rendering is still client-side via marked.js. No image crate, no sha1, no base64, no async runtime.

## Project Structure

```
src/
  main.rs          # server struct, accept loop, dispatch, CLI, static serving, SSE
  index.rs         # tantivy schema, indexing, search, backlinks
  watcher.rs       # notify file watcher, debounce, self-event filtering
  revisions.rs     # save/list/get/restore revisions
  scanner.rs       # single-pass extraction of headings, tags, [[links]] from raw markdown
  merge.rs         # line-based 3-way merge for conflict resolution
  strip.rs         # pulldown-cmark markdown stripping for clean content indexing
web/
  index.html       # SPA shell
  ts/
    main.ts        # entry, keyboard shortcuts, SSE connection
    editor.ts      # contenteditable WYSIWYG editor
    search.ts      # search modal (Cmd+K)
    tabs.ts        # tab bar management
    api.ts         # typed fetch wrappers
    wikilinks.ts   # marked.js extension for [[links]] and ![[images]]
    merge.ts       # line-based 3-way merge for external change resolution
    revisions.ts   # revision history UI
    util.ts        # debounce, escaping, formatting
  static/
    app.js         # bun build output
    vendor/
      marked.min.js
      highlight.min.js
      highlight.css       # single light theme
    style.css
tsconfig.json      # bun tsc config (from vitrine2 pattern)
Makefile
```

## Threading Model

1. **Main thread**: TCP accept loop. Before each request, drains watcher channel (`try_recv`) to apply pending index updates. Handles all HTTP dispatch.
2. **Watcher thread**: `notify::RecommendedWatcher` sends `WatchEvent` over `mpsc::channel`. Filters to `.md` files only, ignores `.tansu/` and `z-images/`.
3. **Indexer thread**: On startup, spawns a thread that walks the entire directory and indexes all `.md` files. Sends progress over a channel. Server serves immediately; search results are partial until indexing completes. The main thread's `try_recv` loop also handles these initial index events.
4. **SSE**: Connected clients stored in `Arc<Mutex<Vec<TcpStream>>>`. Watcher thread writes events directly to all SSE clients after sending to main channel.

Self-event filtering: `Arc<Mutex<HashSet<PathBuf>>>` of recently-written paths, shared between server writes and watcher callback.

**Single client enforcement**: The SSE endpoint tracks whether a client is connected. If a second client tries to connect, the server returns 409. The frontend shows an error: "Tansu is open in another window."

## Tantivy Schema

| Field    | Type   | Stored           | Notes                                                |
| -------- | ------ | ---------------- | ---------------------------------------------------- |
| path     | STRING | yes              | unique key, relative path                            |
| title    | TEXT   | yes              | first H1 or filename stem                            |
| content  | TEXT   | yes (fieldnorms) | stripped via pulldown-cmark (plain text), for search |
| headings | TEXT   | yes              | all headings space-separated                         |
| tags     | TEXT   | yes              | extracted #tag tokens                                |
| mtime    | u64    | yes (fast)       | unix seconds                                         |
| links_to | TEXT   | yes              | space-separated normalized link targets              |

Backlinks: search `links_to:"target-name"` to find all notes linking to a given note.

### Search Strategy (two-phase, from ferrisearch)

1. **Phase 1**: exact + prefix matching across all fields. If >= 5 results, return immediately.
2. **Phase 2**: if < 5 results, retry with fuzzy matching on content field (distance ~0.2).
   Field boosts: title 10, headings 5, tags 2, content 1.

### Tag Recognition

Simple word-boundary rule: `#word` where `#` is preceded by whitespace or start-of-line, and the tag is `[a-zA-Z0-9_-]+`. No hierarchical tags (no `/`). Heading lines (`# `, `## `) are excluded by the scanner since those are parsed as headings first.

### Content Stripping

Use pulldown-cmark to walk the AST and emit only text events (stripping all markdown syntax: headings markers, emphasis, link URLs, code fences, etc.). The resulting plain text is indexed in the `content` field.

### Atomic Writes

Write `{path}.tmp` in the same directory as the target, then `fs::rename`. Same-filesystem guarantee.

## API

| Method | Path                      | Purpose                                                                                              |
| ------ | ------------------------- | ---------------------------------------------------------------------------------------------------- |
| GET    | `/`                       | Serve index.html                                                                                     |
| GET    | `/static/*`               | Static assets                                                                                        |
| GET    | `/z-images/*`             | Image files                                                                                          |
| GET    | `/api/search?q=`          | Full-text search                                                                                     |
| GET    | `/api/note?path=`         | Read note `{content, mtime}`                                                                         |
| PUT    | `/api/note?path=`         | Write note `{content, expected_mtime}` -> `{mtime}` or 409                                           |
| POST   | `/api/note?path=`         | Create new note                                                                                      |
| DELETE | `/api/note?path=`         | Delete note                                                                                          |
| POST   | `/api/rename`             | Rename note `{old_path, new_path}`. Renames file, updates all wiki-links in other notes, re-indexes. |
| GET    | `/api/notes`              | All notes `[{path, title}]` for autocomplete                                                         |
| GET    | `/api/backlinks?path=`    | Notes linking to this path                                                                           |
| POST   | `/api/image`              | Save webp bytes to z-images, return `{filename}`                                                     |
| GET    | `/api/revisions?path=`    | List revision timestamps                                                                             |
| GET    | `/api/revision?path=&ts=` | Get revision content                                                                                 |
| POST   | `/api/restore?path=&ts=`  | Restore revision                                                                                     |
| GET    | `/events`                 | SSE stream for file change notifications                                                             |

## Frontend

### Navigation

- **No sidebar**. Search modal (Cmd+K) is the sole entry point.
- **Tabs**: horizontal tab bar at top. Multiple notes open simultaneously.
  - Cmd+W close, Cmd+Shift+]/[ switch tabs
  - Dirty indicator, close button per tab
- **Search modal**: debounced input, keyboard nav (arrows + Enter), shows title/path/excerpt. Type a non-existent name + Enter = create empty note at root + open.
- **Empty state**: blank page with centered hint "Press Cmd+K to search".

### Editor

Two modes with a toggle button:

**WYSIWYG mode** (default) — contenteditable, adapted from vitrine2:

- **Canonical format**: markdown string. Load: `marked.parse()` -> innerHTML. Save: DOM walk -> markdown.
- **Block transforms**: `## ` -> H2, `- ` -> UL, `> ` -> blockquote, ```-> code block,`---` -> HR
- **Inline**: Cmd+B bold, Cmd+I italic, backtick for code
- **Wiki-links**: typing `[[` shows autocomplete dropdown from `/api/notes`. Rendered as `<a class="wiki-link">`. Click opens in tab.
- **Images**: `![[file.webp]]` rendered as `<img src="/z-images/file.webp">`. Paste handler: OffscreenCanvas -> webp blob -> POST /api/image -> insert markup.
- **Tables**: render-only in WYSIWYG (displayed from markdown, not editable). Edit tables in source mode.
- **Code blocks**: rendered as `<pre><code>` with highlight.js syntax highlighting. Serialize back to fenced blocks.
- **No toolbar**: all formatting via keyboard shortcuts and markdown block transforms. Minimalist.
- **Paste**: all external pastes stripped to plain text (same as vitrine2).

**Source mode** — plain textarea showing raw markdown. Escape hatch for complex formatting. Switching back to WYSIWYG re-parses the markdown.

**Common to both modes:**

- **Save**: Cmd+S, PUT with expected_mtime. On 409: warn, offer reload or force-save.
- **Rename**: right-click tab -> rename. POST /api/rename updates file + all wiki-links.

### SSE + External Changes

When a file changes on disk while the note is open:

- **Clean tab**: reload content silently.
- **Dirty tab**: attempt line-based 3-way merge. Base = most recent revision from `.tansu/revisions/` (fetched via `/api/revision`), theirs = new disk content (fetched via `/api/note`), ours = current editor content. If merge succeeds, update editor silently with merged result. If conflicts, show banner: "File changed externally — conflicts detected" with options to keep local, take remote, or view both.

### Delete

Right-click tab -> Delete (with confirmation). Server saves a final revision before removing the file. Recoverable from `.tansu/revisions/`.

### Wiki-link Resolution

`[[my note]]` resolves to a `.md` file by normalizing (lowercase, spaces to hyphens) and searching:

1. Same directory as the linking note
2. Walk up parent directories
3. Search entire vault
   First match wins. If no match, render as a red "create note" link.

### Image Upload

Client converts clipboard to webp via OffscreenCanvas (same as obsidian-webp-paste). Suggests filename: `{NoteName} {YYYYMMDDHHMMSS}.webp`. Server saves to `z-images/`, appending `-1`, `-2` etc. on collision.

### Backlinks

Below editor: collapsible "Backlinks" section listing notes that link to the current note.

### Revision History

Button in toolbar opens revision list (timestamps with relative dates). Click to view content. "Restore" button creates a new revision of current state, then overwrites.

### Styling

- Light mode only, subdued minimalist
- White/near-white bg, `#24292f` text, `#d0d7de` borders
- System font stack, monospace for code
- Editor: max-width ~800px, centered
- Wiki-links: `#0969da`

## Implementation Order

1. **Skeleton server** — main.rs with CLI arg parsing, TCP accept, httparse dispatch, static file serving. Port srv's `write_headers`, `write_body`, `write_error`, `send_file`, `mime`, `normalize_into`, `query_param`.
2. **Markdown scanner** — scanner.rs: single-pass extractor for headings, #tags, and [[wiki-links]] from raw markdown text. No pulldown-cmark.
3. **Tantivy index** — index.rs: schema, create/open, index_note, remove_note, search, get_backlinks, get_all_notes. Background full-index on startup.
4. **File watcher** — watcher.rs: notify watcher on separate thread, mpsc channel, debounce, self-event filtering. Main thread drains before each request.
5. **Note CRUD API** — GET/PUT/POST/DELETE note endpoints with mtime conflict detection and atomic writes.
6. **Revision history** — revisions.rs: save/list/get/restore. Integrated into PUT handler.
7. **Rename API** — POST /api/rename: rename file, search index for referencing notes, update all [[links]], re-index.
8. **Image upload** — POST /api/image accepts webp bytes + suggested filename, saves to z-images/.
9. **SSE live reload** — GET /events endpoint, watcher broadcasts to connected clients.
10. **Frontend shell** — index.html, tsconfig.json, Makefile, main.ts, api.ts, style.css base.
11. **Search modal** — search.ts: overlay, debounced plain-text search, keyboard nav, create-new-note.
12. **Tab management** — tabs.ts: tab bar, open/close/switch, dirty tracking, rename via context menu.
13. **WYSIWYG editor** — editor.ts: contenteditable, block transforms, inline formatting (Cmd+B/I, backtick), DOM<->markdown, source mode toggle. No toolbar — keyboard shortcuts only. wikilinks.ts: marked.js extension for [[links]] and ![[images]]. Tables render read-only; edit in source mode.
14. **Syntax highlighting** — integrate vendored highlight.js for code blocks in the editor.
15. **Wiki-link autocomplete** — inline `[[` autocomplete dropdown, resolution by proximity to current note.
16. **Image paste** — client-side webp conversion (OffscreenCanvas), upload with suggested filename, insert markup.
17. **3-way merge** — merge.ts: line-based 3-way merge for handling SSE external-change events on dirty tabs. Base = last revision from server.
18. **Backlinks + revisions UI** — backlinks section below editor, revision history panel.
19. **Polish** — styling, edge cases.

## Rename Flow (Server-Side)

`POST /api/rename` with `{old_path, new_path}`:

1. Rename the file on disk
2. Save a revision of the old path
3. Search tantivy `links_to` field for the old note's stem
4. For each referencing note: read content, replace `[[old-name]]` with `[[new-name]]`, atomic write, save revision, re-index
5. Remove old path from index, index new path
6. Return list of updated files so the client can refresh any open tabs

## Deferred (v2)

- Diff view for revisions
- Dark mode
- Revision auto-cleanup
- Link graph visualization
- Mobile/responsive
- WYSIWYG table editing (v1: render-only, edit in source mode)
- Footnotes
- Floating toolbar (v1: keyboard shortcuts only)

## Dev Workflow

```makefile
build: build-ts build-rs

build-ts:
	bun build web/ts/main.ts --outfile web/static/app.js --minify

build-rs:
	cargo build

check:
	bun tsc
	cargo check

dev:
	bun build web/ts/main.ts --outfile web/static/app.js --watch &
	cargo run -- ~/notes --port 3000
```

`make dev` runs bun in watch mode (auto-rebuilds on TS changes) alongside the Rust server.

## Verification

1. `cargo build` — server compiles
2. `bun tsc && bun build web/ts/main.ts --outfile web/static/app.js` — frontend compiles
3. `cargo run -- /tmp/test-notes --port 3000` — server starts, serves SPA
4. Create/edit/search/delete notes through the UI
5. Modify a .md file externally, confirm SSE triggers reload in browser
6. Paste an image, confirm webp saved to z-images/ and displayed inline
7. Save a note, check `.tansu/revisions/` has a copy, restore it
8. Open a note via `[[wiki-link]]`, confirm backlinks appear
9. Simulate iCloud conflict (modify file externally between read and save), confirm 409 handling
