# Tansu TODO

Prefix: TNS
Next: 84

### TNS-068 · P4 · Order asset prefetch by visibility and test cache stability

- **Area:** Performance
- **Where:** `web/ts/app.ts`
- **Problem:** Prefetch loads in document order because the editor cannot report visible images. Cache stability and eviction past 64 are now tested, and the broken-image-after-eviction report did not reproduce.
- **Recommendation:** Add an editor API that reports visible images and load those first, only if a measurement shows prefetch order matters.
- **Blocked:** The restored-scroll browser probe did not establish visible-image request rounds: virtualization left the target images outside the rendered viewport. First make the probe reliably identify rendered visible images after restoring scroll, then compare cold request rounds before adding an editor API. No benefit has been demonstrated.
- **Fix with:** make-it-fast
- **Effort:** S
### TNS-074 · P3 · Remove the search service thread and the crash-safe index swap

- **Area:** Architecture
- **Where:** `crates/tansu-search/src/service.rs`, `src/search.rs`, `docs/performance.md`
- **Problem:** The host mutex serializes every call, so at most one message is ever in flight and coalescing, queue-full overflow, and the 4 ms coalesce wait never help. The rebuild's rename, backup, and fsync recovery protects a derived index. The 743 ms to 45 ms result may depend on the thread, which is unproven.
- **Recommendation:** Measure with the idle-host `make bench` first. If the target holds, call the index directly under the host mutex and rebuild by discarding on a crash.
- **Blocked:** Candidate `cb6e748` on `backlog-search-service` passes the search and host tests but is not integrated. The paired final-build comparison was rejected by `perf-gate-ready` because the host stayed busy. Resume with interleaved baseline/candidate runs and successful pre/post load gates; retain the current service until the performance target and observed spread support the change.
- **Fix with:** lifecycle-concurrency
- **Effort:** M

## Next

### TNS-083 · P3 · Investigate the intermittent app boot fixture failure

- **Area:** Tests
- **Where:** `web/ts/app.test.ts`, `web/ts/document-session.test.ts`, `web/ts/view.test.ts`
- **Problem:** One three-file run at seed `1792771486558` reached the closing-save/reopen test after `app.boot()` without creating the expected editor. A later broad Vitest run at seed `1792778081422` also failed `document controller outlives its tab > waits for a pending rename before reopening the note` with `editorMock.instances[0]` undefined; it was not isolated in a rerun. The isolated test, exact rerun, five app-only runs, and final 198-test group passed for the first occurrence. The cause remains unproven; passing retries do not establish a fix.
- **Recommendation:** Capture boot completion and pending fixture work when the editor is absent, then reproduce and remove the shared-state or lifecycle cause. Keep the closing-save assertions intact.
- **Fix with:** root-cause
- **Effort:** S
