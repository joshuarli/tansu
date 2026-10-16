# Tansu2 TODO

Prefix: TNS
Next: 54

### TNS-041 · P2 · Bound filesystem watcher trigger backlog

- **Area:** Concurrency
- **Where:** `src/vault.rs:832-842`
- **Problem:** Filesystem notifications are sent into an unbounded channel while the watcher worker may be busy reconciling. A burst of events during a slow reconciliation can accumulate without limit even though each notification only requests another full reconciliation.
- **Recommendation:** Use a bounded coalescing trigger and a nonblocking full-queue policy so pending notifications cannot grow with the event burst. The worker that drains it is owned per TNS-027.
- **Fix with:** lifecycle-concurrency
- **Effort:** S

### TNS-042 · P2 · Validate settings at the backend boundary

- **Area:** Data
- **Where:** `src/vault.rs:1012-1041`, `src/vault.rs:2717-2723`, `src/api_types.rs:102-114`
- **Problem:** V2 and Rust callers can persist settings outside the ranges enforced by the browser form. Extreme autosave delays, undo depths, image qualities, or non-finite search weights can then reach application consumers and persist across restarts.
- **Recommendation:** Define valid settings once and reject invalid values before persisting them, while keeping the existing serialized representation. Whether `undoStackMax` and `imageWebpQuality` reach consumers is TNS-047.
- **Fix with:** make-invalid-states-unrepresentable
- **Effort:** S

### TNS-043 · P2 · Use the platform current-directory value for relative roots

- **Area:** Portability
- **Where:** `src/paths.rs:266-270`, `src/paths.rs:396-400`, `src/paths.rs:488-493`
- **Problem:** Unix path operations pass `-100` as the `openat` directory descriptor for root paths. That is Linux's `AT_FDCWD`; Darwin uses `-2`. Absolute roots work because `openat` ignores the descriptor for absolute paths, but direct path API calls or `VaultRuntime::open` with a relative root fail on macOS.
- **Recommendation:** Use the platform's `AT_FDCWD` value through a platform abstraction and cover relative-root operations on each supported Unix target.
- **Fix with:** os-boundaries
- **Effort:** S

### TNS-044 · P2 · Cache editor layout metadata between document changes

- **Area:** Performance
- **Where:** `web/ts/editor/tufte-notes.ts:219`, `web/ts/editor/source-navigation.ts:35`, `web/ts/editor/codemirror-adapter.ts:998`
- **Problem:** `tufteNotes()` rebuilds the full layout, including a full-document `ensureSyntaxTree` and a line scan, on document, selection, and viewport changes. `outlineFromSyntaxTree()` walks the whole document on scroll. Cost grows with note length during cursor movement and scrolling. Unmeasured.
- **Recommendation:** Cache heading and footnote metadata keyed to document changes, so selection and viewport changes reuse it. Measure sustained cursor movement and scroll on long prose, many headings, many footnotes, and image-heavy notes before and after, following `benchmark-checklist`.
- **Fix with:** make-it-fast
- **Effort:** M

### TNS-046 · P2 · Wire wiki-link navigation into the app editor

- **Area:** Tests
- **Where:** `web/ts/app.ts:11`, `web/ts/editor/tansu-extensions.ts:102`, `web/ts/editor/codemirror-adapter.ts:463`
- **Problem:** `app.ts` imports `createCalloutExtension` and `createWikiImageExtension` but not `createWikiLinkExtension`, and the adapter installs `wikiLinks` only when that extension is configured. Wiki-link navigation therefore appears unwired in production. Source-read only; not yet confirmed in the running app.
- **Recommendation:** Confirm in the running app, then wire the extension and add app-boundary tests for a resolved link, an ambiguous basename, a relative path, a missing target, and a rename. If links are intentionally off, delete the extension and its docs.
- **Fix with:** none
- **Effort:** M

### TNS-047 · P2 · Propagate or remove settings that have no effect

- **Area:** Architecture
- **Where:** `web/ts/view.ts:827`, `web/ts/app.ts:1476`, `web/ts/app/v2-api.ts:768`
- **Problem:** `undoStackMax` and `imageWebpQuality` are editable and persisted, but the editor uses bare `history()` and the WebP encoder takes only `ImageData`. The controls appear to do nothing. Source-read only.
- **Recommendation:** Wire each setting to its consumer or remove it from the form, type, and storage. Then audit every visible control for an observable effect, a failure state, and an app-boundary test.
- **Fix with:** single-source-of-truth
- **Effort:** M

### TNS-048 · P2 · Replace campaign verification with a permanent acceptance suite

- **Area:** Tests
- **Where:** `web/ts/e2e/server.test.ts`, `Makefile`, `docs/development.md`
- **Problem:** Verification of save and recovery behavior has come from one-off campaign runs, so regressions in persistence and lifecycle do not fail a standing check. Releases are not tied to the exact revision and artifact that was tested.
- **Recommendation:** Add a small suite covering persistence (immediate close, delayed saves, retries, two browser contexts, server restart), conflict recovery, editor continuity, canonical light and dark UI baselines, and long-session leak checks (workers, asset URLs, editor instances). Add a deterministic interleaving suite on the existing service injection: delay a response, switch tabs, expire auth, complete an upload, close a document, replay an event. Tie the release process to the exact revision and artifact the suite ran against.
- **Fix with:** renovate-tests
- **Effort:** L

### TNS-049 · P2 · Bind async mutations to captured identity, not current selection

- **Area:** Concurrency
- **Where:** `web/ts/app.ts:1411`, `web/ts/app.ts:1450`, `web/ts/app.ts:1857`
- **Problem:** `restoreSelectedRevision()` captures the client and identity, but `handleMutation()` reads the mutable `this.vaultClient` and runs before any current-vault check. Restore, import, rename, asset loading, and delayed API responses can apply to a different vault or tab than the one that issued them. Source-level race, not reproduced.
- **Recommendation:** Apply one rule: an async operation captures the vault identity, client, and tab identity at start, passes them to its completion, and discards or reroutes the result when they no longer match. Cover each operation with an interleaving test from TNS-048.
- **Fix with:** lifecycle-concurrency
- **Effort:** M

### TNS-045 · P3 · Bound and stabilize asset prefetch

- **Area:** Performance
- **Where:** `web/ts/app.ts:1857`
- **Problem:** `prefetchAssets()` loads assets one at a time and reconfigures the editor after each, and the cache is cleared on every tab switch. Image-heavy notes load slowly and reconfigure the editor repeatedly. Unmeasured.
- **Recommendation:** Load with bounded concurrency, visible images first, batch the editor reconfiguration, and keep a cache stable across tab switches. Keep the abort and object-URL cleanup discipline, with a leak check from TNS-048.
- **Fix with:** make-it-fast
- **Effort:** M

### TNS-050 · P3 · Move document state into a per-document controller

- **Area:** Architecture
- **Where:** `web/ts/app.ts`
- **Problem:** Editor state, the dirty snapshot, the journal, and in-flight mutations live in the app and follow the active tab. Lifecycle bugs (tab close, tab switch, delayed responses) recur because nothing owns a document's state independent of tab activity.
- **Recommendation:** Write the RFC, then extract a document controller one boundary at a time while fixing lifecycle bugs. No sweeping file split.
- **Fix with:** api-surface-and-module-boundaries
- **Design:** `docs/rfcs/TNS-050-document-controller.md`
- **Effort:** L

### TNS-051 · P2 · Show tags as colored pills and clean up the add-tag modal

- **Area:** UI
- **Where:** `web/ts/view.ts:907`, `web/ts/view.ts:971`, `web/static/app.css`, `web/ts/view.test.ts`
- **Problem:** Tags render as plain text and the "Add Tag" dialog does not match the visual polish of the other note dialogs.
- **Recommendation:** Render every tag as a pill whose color derives deterministically from the normalized tag text (stable across sessions, readable in light and dark). Share one tag-pill renderer across the note header, search results, and recent notes (TNS-052). Rebuild the add-tag dialog on the same structure and styles as the existing rename/create dialogs. Cover the pill color stability and the dialog markup in `view.test.ts`.
- **Fix with:** single-source-of-truth
- **Effort:** M

### TNS-052 · P2 · Show tags on search and recent-note entries and weigh them in search

- **Area:** Search
- **Where:** `web/ts/view.ts`, `src/search.rs:349`, `src/api_types.rs:366`, `web/ts/app/v2-api.ts`
- **Problem:** Search results and recent-note rows do not show a note's tags, and it is unconfirmed that a tag match raises a note's rank.
- **Recommendation:** Show the tag pills from TNS-051 on search result rows and recent-note rows (add tags to the response or preview data if missing). Confirm with a failing test whether an exact tag match outranks a body-only match; make tags a weighted search field with a tested default if not. Keep search derived state: indexing never rejects writes.
- **Fix with:** none
- **Effort:** M

### TNS-053 · P2 · Exercise tags in the fixture vault

- **Area:** Fixtures
- **Where:** `scripts/dev-fixture.mjs`, `scripts/test-fixture.mjs`, `docs/fixtures.md`
- **Problem:** The fixture notes do not cover tags, so pills, tag-bearing search and recent rows, and tag weighting are not exercised by `make dev` or the e2e suite.
- **Recommendation:** Add fixture notes with varied tags (shared, unique, long, similar names, frontmatter-only and inline forms the V1 parser supports), use them in e2e coverage for pills, search rows, recent rows, and tag-weighted ranking, and update `docs/fixtures.md`.
- **Fix with:** none
- **Effort:** S
