# Tansu2 TODO

Prefix: TNS
Next: 71

### TNS-050 · P3 · Move document state into a per-document controller

- **Area:** Architecture
- **Where:** `web/ts/app.ts`
- **Problem:** The controller now owns load, autosave, dirty snapshot, session subscription, journal handle, and close-time save and restore. The editor session and asset loads still live on the tab and the app, and completions are matched to tabs by closures, not delivered to the issuing controller.
- **Recommendation:** Continue the RFC's Not done list one boundary at a time. No sweeping file split.
- **Fix with:** api-surface-and-module-boundaries
- **Design:** `docs/rfcs/TNS-050-document-controller.md`
- **Effort:** L

### TNS-057 · P2 · Run the static SQLite test and the release-binary recovery drill

- **Area:** Data
- **Where:** `Makefile`, `scripts/auth-recovery-drill.sh`, `docs/deployment.md`
- **Problem:** `make test-sqlite-static` and `make auth-recovery-drill` were written for TNS-038 but never run, because they need a SQLite source download and a Docker release build.
- **Recommendation:** Run both on a host that can, record the result in the release checklist, and fix what they reveal.
- **Fix with:** error-model
- **Effort:** S

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

### TNS-070 · P4 · Check tab currency before fetching in handleMutation

- **Area:** Concurrency
- **Where:** `web/ts/app.ts`
- **Problem:** `handleMutation` calls `client.openNote` before checking the tab is still open, so a restore for a closed tab makes one wasted fetch. An existing test relies on the call count.
- **Recommendation:** Check currency first, and update the test to assert no fetch.
- **Fix with:** lifecycle-concurrency
- **Effort:** S
