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
- **Blocked:** Candidate `cb6e748` on `backlog-search-service` passes the search and host tests but is not integrated. The paired final-build comparison was rejected by `perf-gate-ready` because the host stayed busy. Resume with interleaved baseline/candidate runs and successful pre/post load gates; retain the current service until the performance target and observed spread support the change.
- **Fix with:** lifecycle-concurrency
- **Effort:** M

### TNS-082 · P3 · Add vault-local ambient intelligence

- **Area:** Architecture
- **Where:** `src/search.rs`, `src/tags.rs`, `web/ts/app.ts`
- **Problem:** No tag suggestions, related notes, long-note summaries, or ask-your-vault chat. Any of them sends note content to a model, which needs a privacy design before code: what leaves the machine, opt-in, and per-vault scope. Indexing and model failures must not affect accepted writes.
- **Recommendation:** Write an RFC for the privacy and model-hosting boundary, then ship in order: related notes (derived from the search index, no model), tag suggestions, catch-me-up summary, vault chat with notes cited as clickable chips.
- **Design:** `docs/rfcs/TNS-082-vault-intelligence.md`
- **Blocked:** The privacy RFC is draft. Model requests require an owner decision on hosting, disclosure, and credential storage. Resume implementation after that design is accepted.
- **Fix with:** none
- **Effort:** L

## Next

### TNS-083 · P3 · Investigate the intermittent app boot fixture failure

- **Area:** Tests
- **Where:** `web/ts/app.test.ts`, `web/ts/document-session.test.ts`, `web/ts/view.test.ts`
- **Problem:** One three-file run at seed `1792771486558` reached the closing-save/reopen test after `app.boot()` without creating the expected editor. The isolated test, exact rerun, five app-only runs, and final 198-test group passed. The cause remains unproven; passing retries do not establish a fix.
- **Recommendation:** Capture boot completion and pending fixture work when the editor is absent, then reproduce and remove the shared-state or lifecycle cause. Keep the closing-save assertions intact.
- **Fix with:** root-cause
- **Effort:** S
