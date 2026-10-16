# Tansu2 TODO

Prefix: TNS
Next: 54

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
