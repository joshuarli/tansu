# Tansu TODO

Prefix: TNS
Next: 83

### TNS-050 · P3 · Move document state into a per-document controller

- **Area:** Architecture
- **Where:** `web/ts/app.ts`
- **Problem:** The controller now owns load, autosave, dirty snapshot, session subscription, journal handle, and close-time save and restore. The editor session and asset loads still live on the tab and the app, and completions are matched to tabs by closures, not delivered to the issuing controller.
- **Recommendation:** Continue the RFC's Not done list one boundary at a time. No sweeping file split.
- **Fix with:** api-surface-and-module-boundaries
- **Design:** `docs/rfcs/TNS-050-document-controller.md`
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

### TNS-062 · P3 · Test relative roots on Linux and other Unix targets

- **Area:** Portability
- **Where:** `src/paths.rs`
- **Problem:** The `O_*` flags now come from `rustix` and unsupported unix targets fail to compile, but the relative-root test has run on macOS only.
- **Recommendation:** Run `paths::tests` on Linux x86_64 and aarch64 musl.
- **Fix with:** os-boundaries
- **Effort:** S

### TNS-064 · P3 · Cut per-cursor work in the vendored live-preview extension

- **Area:** Performance
- **Where:** `web/ts/editor/vendor/atomic/inline-preview.ts`
- **Problem:** The blank-line scan is cached per document and tree, but `buildInlineDecorations` still walks the syntax tree on every selection change. Unmeasured.
- **Recommendation:** Measure the walk with a work-counting test, then split a selection-independent node list from the selection-dependent decoration choice and cache the list.
- **Fix with:** make-it-fast
- **Effort:** M

### TNS-068 · P4 · Order asset prefetch by visibility and test cache stability

- **Area:** Performance
- **Where:** `web/ts/app.ts`
- **Problem:** Prefetch loads in document order because the editor cannot report visible images. Cache stability and eviction past 64 are now tested, and the broken-image-after-eviction report did not reproduce.
- **Recommendation:** Add an editor API that reports visible images and load those first, only if a measurement shows prefetch order matters.
- **Fix with:** make-it-fast
- **Effort:** S
### TNS-069 · P3 · Generate Linux acceptance baselines in a pinned container

- **Area:** Tests
- **Where:** `web/ts/e2e/`, `Makefile`, `docs/development.md`
- **Problem:** The light and dark baselines are committed for macOS Chromium and WebKit only, so the acceptance suite fails on Linux CI until baselines exist there.
- **Recommendation:** Generate the Linux baselines in a pinned container and commit them.
- **Fix with:** renovate-tests
- **Effort:** S

### TNS-071 · P3 · Drop legacy hash formats and one-time state migrations

- **Area:** Dead code
- **Where:** `src/history.rs:167-253`, `src/reconcile.rs:271-390`, `src/catalog.rs:196-240`, `src/catalog.rs:350-368`, `src/vault.rs:233-282`, `src/vault.rs` `.tansu` legacy state copy, `src/auth.rs:18,290-306`, `docs/api.md`, `docs/migration.md`
- **Problem:** Three source-hash generations and two disk-hash generations are stored and compared, and idempotent retry hashes each payload twice. The `.tansu/` state copy, the search-weights migration, and the token-hash `user_version` migration each serve one past layout. The repo is months old at 0.1.0. Removing them breaks or resets any catalog written before blake3-v3, so it needs the owner to confirm no installed state predates the current formats.
- **Recommendation:** After confirming, delete the legacy hash functions, `migrate_current_hashes`, the `.tansu` copy with its tests, and both migrations.
- **Blocked:** The owner must confirm that no installed state predates the current hash and catalog formats. Repository age and version do not establish that fact.
- **Fix with:** dead-code-archaeology
- **Effort:** M

### TNS-074 · P3 · Remove the search service thread and the crash-safe index swap

- **Area:** Architecture
- **Where:** `crates/tansu-search/src/service.rs`, `src/search.rs`, `docs/performance.md`
- **Problem:** The host mutex serializes every call, so at most one message is ever in flight and coalescing, queue-full overflow, and the 4 ms coalesce wait never help. The rebuild's rename, backup, and fsync recovery protects a derived index. The 743 ms to 45 ms result may depend on the thread, which is unproven.
- **Recommendation:** Measure with the idle-host `make bench` first. If the target holds, call the index directly under the host mutex and rebuild by discarding on a crash.
- **Fix with:** lifecycle-concurrency
- **Effort:** M

### TNS-075 · P3 · Remove the API version and build-id scheme

- **Area:** Architecture
- **Where:** `src/api.rs:12`, `src/http.rs:598-647`, `src/http.rs:1414-1422`, `web/ts/app/v2-api.ts`, `docs/api.md`
- **Problem:** No V1 client exists, yet three places still return `api_version_unsupported`, the version is stated four times, and the build id is checked only for being non-empty. Server and client ship as one embedded build.
- **Recommendation:** Delete the dead `API_VERSION`, the unreachable branch at `http.rs:1414`, and then the headers, the typed error, and the client check.
- **Fix with:** api-surface-and-module-boundaries
- **Effort:** S

### TNS-076 · P3 · Remove tooling nothing names

- **Area:** Build
- **Where:** `scripts/test-package.py`, `Makefile` `test-package` and `coverage*`, `deno.json` coverage tasks, `package.json` `@vitest/coverage-v8`, `vitest.config.ts` coverage block, `scripts/artifact-hash.mjs`, `Makefile` `test-acceptance`, `web/ts/e2e/server.test.ts`, `docs/development.md`
- **Problem:** A 242-line Python smoke script, three coverage targets with thresholds nothing enforces, and a recorded artifact hash with no release workflow to consume it. The empty-PATH release run is the only behavior lost.
- **Recommendation:** Delete them and the doc lines. Keep `ACCEPTANCE_SERVER_BINARY`.
- **Fix with:** dead-code-archaeology
- **Effort:** S

### TNS-077 · P3 · Fix or remove the stale visual review script

- **Area:** Tests
- **Where:** `bench/visual-review.mjs`
- **Problem:** The script waits on `.quick-open-panel` and `.sidebar .note-row`, which the current app does not emit. Its layout assertions and screenshots are not covered by a named test target.
- **Recommendation:** Update its selectors and add a focused target, or delete it.
- **Fix with:** dead-code-archaeology
- **Effort:** S

### TNS-079 · P4 · Collapse speculative editor seams

- **Area:** Architecture
- **Where:** `web/ts/editor/tansu-extensions.ts`, `web/ts/editor/codemirror-adapter.ts:411-525`, `web/ts/editor/harness/`, `web/ts/editor/tests/large-note-bench.test.ts`
- **Problem:** The `EditorExtension` union represents three extension variants, but the app supplies one fixed set. The adapter filters and diffs that set on every render. The standalone harness has a build script but no named target. The happy-dom large-note timing runs in `make bench` and `make bench-full`, but it does not measure browser layout.
- **Recommendation:** Replace the union with plain config fields and delete the harness and the bench test.
- **Fix with:** api-surface-and-module-boundaries
- **Effort:** S

### TNS-080 · P3 · Remove the test-only service seam and the hand-written store fake

- **Area:** Tests
- **Where:** `web/ts/app/services.ts`, `web/ts/app/workspace-store.ts:331-390`, `web/ts/app.test.ts:2363-2465`
- **Problem:** Three type declarations and four curried factories carry one decision, and only tests pass non-default values. `app.test.ts` keeps a 100-line copy of store semantics although `fake-indexeddb` is already a dev dependency.
- **Recommendation:** Run the app tests against `fake-indexeddb` and delete the seam and the fake.
- **Fix with:** renovate-tests
- **Effort:** M

### TNS-081 · P3 · Add a history scrubber and visual conflict-draft merge

- **Area:** Architecture
- **Where:** `src/history.rs`, `web/ts/app/document-session.ts`, `web/ts/editor/`
- **Problem:** The revisions panel already lists snapshots, shows a text diff, and restores them through the existing revision API. It has no timeline scrubber or branch-from-here action. The conflict panel previews and restores a draft but has no editable two-pane merge.
- **Recommendation:** Extend the existing history UI with a timeline slider, a live diff (inserted text green, removed text fading), and branch-from-here. Add an editable two-pane conflict merge while preserving canonical revision preconditions and unsaved edits. Reuse the existing snapshot-list and restore APIs; document any new contracts in `docs/api.md`.
- **Fix with:** none
- **Effort:** L

### TNS-082 · P3 · Add vault-local ambient intelligence

- **Area:** Architecture
- **Where:** `src/search.rs`, `src/tags.rs`, `web/ts/app.ts`
- **Problem:** No tag suggestions, related notes, long-note summaries, or ask-your-vault chat. Any of them sends note content to a model, which needs a privacy design before code: what leaves the machine, opt-in, and per-vault scope. Indexing and model failures must not affect accepted writes.
- **Recommendation:** Write an RFC for the privacy and model-hosting boundary, then ship in order: related notes (derived from the search index, no model), tag suggestions, catch-me-up summary, vault chat with notes cited as clickable chips.
- **Design:** `docs/rfcs/TNS-082-vault-intelligence.md`
- **Blocked:** The privacy RFC is draft. Model requests require an owner decision on hosting, disclosure, and credential storage. Resume implementation after that design is accepted.
- **Fix with:** none
- **Effort:** L
