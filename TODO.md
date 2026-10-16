# Tansu2 TODO

Prefix: TNS
Next: 69

### TNS-050 · P3 · Move document state into a per-document controller

- **Area:** Architecture
- **Where:** `web/ts/app.ts`
- **Problem:** Editor state, the dirty snapshot, the journal, and in-flight mutations live in the app and follow the active tab. Lifecycle bugs (tab close, tab switch, delayed responses) recur because nothing owns a document's state independent of tab activity.
- **Recommendation:** Write the RFC, then extract a document controller one boundary at a time while fixing lifecycle bugs. No sweeping file split.
- **Fix with:** api-surface-and-module-boundaries
- **Design:** `docs/rfcs/TNS-050-document-controller.md`
- **Effort:** L

### TNS-054 · P2 · Fail on unknown note event kinds and sources

- **Area:** Data
- **Where:** `src/catalog.rs`
- **Problem:** `note_event_kind` and `note_event_source` map unknown persisted strings to `Save` and `User`, the same silent-default class closed for tags and sync versions.
- **Recommendation:** Return a corruption error for unknown event kind or source strings, with a failing test per column.
- **Fix with:** durable-state
- **Effort:** S

### TNS-055 · P2 · Decide the fate of the inert search weight settings

- **Area:** Architecture
- **Where:** `src/api_types.rs`, `crates/tansu-search/src/search.rs`, `web/ts/view.ts`
- **Problem:** `searchTitleWeight`, `searchHeadingWeight`, `searchTagWeight`, `searchContentWeight`, and `recencyBoost` are stored and validated but no search code reads them; the search crate scores with fixed per-field weights (title 10, path 7, headings 5, tags 2, content 1).
- **Recommendation:** Either let the search crate take runtime field weights from the settings and test that a changed weight changes ranking, or remove the settings from the type, storage, and docs. The choice is the owner's.
- **Fix with:** single-source-of-truth
- **Effort:** M

### TNS-056 · P2 · Apply excluded-folder changes on save and document matching

- **Area:** Data
- **Where:** `src/vault.rs`, `docs/configuration.md`
- **Problem:** Saving `excludedFolders` has no visible effect until the next vault open or watcher reconcile, and entries match a folder's name at any depth rather than its path. Source-read only.
- **Recommendation:** Reconcile after a settings save that changes the list, test that excluded notes leave search and non-excluded ones return, and state the matching rule in the docs.
- **Fix with:** durable-state
- **Effort:** S

### TNS-057 · P2 · Run the static SQLite test and the release-binary recovery drill

- **Area:** Data
- **Where:** `Makefile`, `scripts/auth-recovery-drill.sh`, `docs/deployment.md`
- **Problem:** `make test-sqlite-static` and `make auth-recovery-drill` were written for TNS-038 but never run, because they need a SQLite source download and a Docker release build.
- **Recommendation:** Run both on a host that can, record the result in the release checklist, and fix what they reveal.
- **Fix with:** error-model
- **Effort:** S

### TNS-058 · P2 · Finish the permanent acceptance suite

- **Area:** Tests
- **Where:** `web/ts/e2e/server.test.ts`, `web/ts/app.test.ts`, `Makefile`
- **Problem:** The suite from the acceptance work skipped canonical light and dark UI baselines, long-session leak checks (workers, asset URLs, editor instances), a network-failure retry e2e, a replayed-event interleaving, and an auth expiry that lands during an upload. Releases are tied to the suite only by a printed revision, not the built artifact.
- **Recommendation:** Add the skipped scenarios, and record the artifact hash the suite ran against.
- **Fix with:** renovate-tests
- **Effort:** L

### TNS-059 · P3 · Add a real two-process vault lock test

- **Area:** Concurrency
- **Where:** `src/vault.rs`, `tests/`
- **Problem:** The vault root lock is tested only with two runtimes in one process.
- **Recommendation:** Spawn two server processes on one root, and on two configs naming it, and assert the second exits non-zero with the ownership error.
- **Fix with:** durable-state
- **Effort:** S

### TNS-060 · P3 · Cover multi-vault partial startup failure and watcher error handling

- **Area:** Concurrency
- **Where:** `src/app.rs`, `src/vault.rs`
- **Problem:** `App::from_config` failing on a later vault is not tested for releasing earlier vaults' workers and locks, and the watcher worker discards `reconcile_from_watcher()` errors with `let _ =`.
- **Recommendation:** Test the partial-startup unwind and log or surface watcher reconcile errors.
- **Fix with:** lifecycle-concurrency
- **Effort:** S

### TNS-061 · P3 · Check the credential cap when registration begins

- **Area:** Security
- **Where:** `src/auth.rs`, `src/http.rs`
- **Problem:** A user at the 32-credential cap can create the passkey on their device before the server refuses it at finish.
- **Recommendation:** Reject at begin-registration with the same error.
- **Fix with:** durable-state
- **Effort:** S

### TNS-062 · P3 · Test relative roots on Linux and other Unix targets

- **Area:** Portability
- **Where:** `src/paths.rs`
- **Problem:** The current-directory fix is verified on macOS only, and the hand-written `O_*` constants cover only Linux and macOS.
- **Recommendation:** Run the relative-root test on Linux musl and gate unsupported targets at compile time.
- **Fix with:** os-boundaries
- **Effort:** S

### TNS-063 · P3 · Reject unfingerprinted immutable assets at build time

- **Area:** Build
- **Where:** `build.rs`
- **Problem:** `build.rs` only checks that immutable assets live under `/assets/`, not that their names carry a content hash, which is how the stable encoder URLs shipped.
- **Recommendation:** Fail the build when an immutable asset path has no hash segment.
- **Fix with:** single-source-of-truth
- **Effort:** S

### TNS-064 · P3 · Cut per-cursor work in the vendored live-preview extension

- **Area:** Performance
- **Where:** `web/ts/editor/vendor/atomic/inline-preview.ts`
- **Problem:** The live-preview decorations re-iterate the syntax tree and scan every blank line on each selection change, the next-largest per-cursor cost after the layout cache. Unmeasured.
- **Recommendation:** Measure with a work-counting test, then cache per document and tree as done for outline and margin notes.
- **Fix with:** make-it-fast
- **Effort:** M

### TNS-065 · P3 · Give feedback when a wiki link cannot be opened

- **Area:** UI
- **Where:** `web/ts/app.ts`
- **Problem:** Clicking an ambiguous or missing wiki link does nothing, and the failed-open handler is untested.
- **Recommendation:** Show a notice for ambiguous and missing targets and test the failure path.
- **Fix with:** none
- **Effort:** S

### TNS-066 · P3 · Render tags that normalize to empty without throwing

- **Area:** Editor
- **Where:** `web/ts/tag-pill.ts`, `web/ts/editor/tag-source.ts`, `web/ts/markdown-tags.ts`
- **Problem:** A frontmatter tag of just `#` normalizes to empty, so `createTagPill` throws and the note header fails to render. `tag-source.ts` also keeps its own copy of `normalizeTag`.
- **Recommendation:** Skip or flag an invalid tag in the header, and import the single `normalizeTag`.
- **Fix with:** single-source-of-truth
- **Effort:** S

### TNS-067 · P3 · Let the HTML import file picker not block vault switching

- **Area:** Concurrency
- **Where:** `web/ts/app.ts`
- **Problem:** `pickHtmlImport` runs as a tracked action, so switching vaults while the picker is open waits until the user answers.
- **Recommendation:** Run the picker outside the drained action set and guard its result by captured identity.
- **Fix with:** lifecycle-concurrency
- **Effort:** S

### TNS-068 · P4 · Order asset prefetch by visibility and test cache stability

- **Area:** Performance
- **Where:** `web/ts/app.ts`
- **Problem:** Prefetch loads in document order, and no test covers the URL cache staying stable across tab switches or evicting past 64 entries. A background tab can show a broken image after eviction.
- **Recommendation:** Load visible images first if the editor can report them, and add cache stability and eviction tests.
- **Fix with:** make-it-fast
- **Effort:** S
