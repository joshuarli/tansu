# Tansu TODO

Prefix: TNS
Next: 85

### TNS-074 · P3 · Remove the search service thread and the crash-safe index swap

- **Area:** Architecture
- **Where:** `crates/tansu-search/src/service.rs`, `src/search.rs`, `docs/performance.md`
- **Problem:** The host mutex serializes every call, so at most one message is ever in flight and coalescing, queue-full overflow, and the 4 ms coalesce wait never help. The rebuild's rename, backup, and fsync recovery protects a derived index. The 743 ms to 45 ms result may depend on the thread, which is unproven.
- **Recommendation:** Measure with the idle-host `make bench` first. If the target holds, call the index directly under the host mutex and rebuild by discarding on a crash.
- **Blocked:** Candidate `cb6e748` on `backlog-search-service` passes the search and host tests but is not integrated. The paired final-build comparison was rejected by `perf-gate-ready` because the host stayed busy. Resume with interleaved baseline/candidate runs and successful pre/post load gates; retain the current service until the performance target and observed spread support the change.
- **Fix with:** lifecycle-concurrency
- **Effort:** M

## Next
