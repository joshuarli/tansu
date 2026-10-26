# Tansu TODO

Prefix: TNS
Next: 85

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

## Next
