# Tansu2 TODO

Prefix: TNS
Next: 44

### TNS-024 · P1 · Serialize vault mutations across server processes

- **Area:** Concurrency
- **Where:** `src/vault.rs:72`, `src/vault.rs:1380`, `src/catalog.rs:373`
- **Problem:** Mutation serialization uses a `Mutex` owned by one `VaultRuntime`. Two server processes opening the same vault have separate mutexes, so both can validate the same base revision before either materializes its content. Both writes can be accepted and the later materialization can overwrite the earlier one without a conflict draft.
- **Recommendation:** Hold a per-vault process lock across mutation acceptance and file materialization, or use an equivalent cross-process compare-and-set.
- **Fix with:** durable-state
- **Effort:** M

### TNS-038 · P1 · Keep auth database validation available in release builds

- **Area:** Data
- **Where:** `scripts/build-sqlite-static.sh:89`, `src/auth.rs:857-865`
- **Problem:** The release SQLite build defines `SQLITE_OMIT_INTEGRITY_CHECK`, which also removes `PRAGMA quick_check`. Auth backup and restore call `verify_database`, which expects that pragma to return a row. Against the release SQLite build, those operations fail even for a valid database.
- **Recommendation:** Keep the pragma enabled or validate the database using an operation supported by the release build, then cover backup and restore against that build.
- **Fix with:** error-model
- **Effort:** S

### TNS-025 · P2 · Reject malformed persisted catalog values

- **Area:** Data
- **Where:** `src/catalog.rs:1025`, `src/catalog.rs:1082`, `src/catalog.rs:1144`, `src/catalog.rs:1212`
- **Problem:** Invalid session JSON becomes an empty session, invalid tag JSON becomes empty tags, invalid sync versions become zero, and malformed persisted booleans become false. The app silently discards persisted state or resets values instead of surfacing catalog corruption.
- **Recommendation:** Return a corruption error for malformed persisted JSON and sync versions.
- **Fix with:** durable-state
- **Effort:** S

### TNS-026 · P2 · Enforce the login credential limit during enrollment

- **Area:** Security
- **Where:** `src/http.rs:901`, `src/auth.rs:478`, `src/auth.rs:1119`
- **Problem:** Login rejects stores with more than 32 credentials, but successful registration inserts credentials without enforcing the same limit. Enrolling a 33rd passkey therefore makes every passkey login fail as unauthorized.
- **Recommendation:** Enforce the shared credential cap inside the registration transaction, or remove the login cap while retaining a safe resource bound.
- **Fix with:** durable-state
- **Effort:** S

### TNS-027 · P2 · Give vault worker threads shutdown owners

- **Area:** Concurrency
- **Where:** `src/vault.rs:814`, `src/vault.rs:829`, `src/http.rs:301`
- **Problem:** Search and watcher workers are detached and each captures an `Arc<VaultRuntime>`. The search worker also owns a receiver while the runtime owns its sender, so dropping the app does not stop the worker or release its runtime, watcher, and channels.
- **Recommendation:** Retain worker handles, add cancellation, and join workers during server shutdown and partial startup failure.
- **Fix with:** lifecycle-concurrency
- **Effort:** M

### TNS-028 · P2 · Reject public-suffix RP IDs on exact host matches

- **Area:** Security
- **Where:** `src/auth.rs:73-77`, `docs/rfcs/0002-webauthn-rp-id-validation.md:7-20`
- **Problem:** The exact-host branch accepts an RP ID before checking the Public Suffix List. This contradicts the accepted RP ID decision and permits startup with a value such as `com`, which browsers reject for WebAuthn ceremonies.
- **Recommendation:** Apply the public-suffix validation to every domain RP ID, with explicit handling for local names and IP addresses.
- **Fix with:** os-boundaries
- **Effort:** S

### TNS-029 · P2 · Keep vault identity fields immutable to callers

- **Area:** Architecture
- **Where:** `src/vault.rs:64-68`
- **Problem:** `VaultRuntime` exposes writable `root`, `vault_id`, `name`, and `index` fields while keeping `state_root` private. A caller can change the visible root while operations continue using the original state directory, splitting one runtime’s identity across paths.
- **Recommendation:** Make identity fields private and expose read-only accessors for consumers.
- **Fix with:** api-surface-and-module-boundaries
- **Effort:** S

### TNS-030 · P2 · Synchronize watcher e2e on stream readiness

- **Area:** Tests
- **Where:** `web/ts/e2e/server.test.ts:525-570`
- **Problem:** The external-edit e2e starts reading the event stream and then waits a fixed 900 ms before changing a file. The delay does not prove the server subscribed before the write, so a slow or loaded runner can miss the event and fail intermittently.
- **Recommendation:** Expose and await a deterministic stream-ready signal before writing the external file.
- **Fix with:** renovate-tests
- **Effort:** S

### TNS-039 · P2 · Version immutable WebP encoder asset URLs

- **Area:** Build
- **Where:** `scripts/build-web.mjs:44-49`, `scripts/build-web.mjs:76-81`, `src/http.rs:1447-1455`
- **Problem:** WebP encoder JS and WASM files use stable URLs but are marked immutable, so the server may let browsers cache old encoder bytes for a year after those files change.
- **Recommendation:** Add content fingerprints to encoder asset URLs or serve those stable URLs with revalidation headers.
- **Fix with:** single-source-of-truth
- **Effort:** S

### TNS-040 · P2 · Guard benchmark runs against host load

- **Area:** Performance
- **Where:** `Makefile:103-117`, `docs/performance.md:15-17`
- **Problem:** The documented benchmark targets collect and record timing results without checking host readiness before and after measurement. Results can be recorded while unrelated load distorts them.
- **Recommendation:** Gate benchmark runs with `perf-gate-ready` before and after measurement, and discard results when either check reports host load.
- **Fix with:** benchmark-checklist
- **Effort:** S

### TNS-041 · P2 · Bound filesystem watcher trigger backlog

- **Area:** Concurrency
- **Where:** `src/vault.rs:832-842`
- **Problem:** Filesystem notifications are sent into an unbounded channel while the watcher worker may be busy reconciling. A burst of events during a slow reconciliation can accumulate without limit even though each notification only requests another full reconciliation.
- **Recommendation:** Use a bounded coalescing trigger and a nonblocking full-queue policy so pending notifications cannot grow with the event burst.
- **Fix with:** lifecycle-concurrency
- **Effort:** S

### TNS-042 · P2 · Validate settings at the backend boundary

- **Area:** Data
- **Where:** `src/vault.rs:1012-1041`, `src/vault.rs:2717-2723`, `src/api_types.rs:102-114`
- **Problem:** V2 and Rust callers can persist settings outside the ranges enforced by the browser form. Extreme autosave delays, undo depths, image qualities, or non-finite search weights can then reach application consumers and persist across restarts.
- **Recommendation:** Define valid settings once and reject invalid values before persisting them, while keeping the existing serialized representation.
- **Fix with:** make-invalid-states-unrepresentable
- **Effort:** S

### TNS-043 · P2 · Use the platform current-directory value for relative roots

- **Area:** Portability
- **Where:** `src/paths.rs:266-270`, `src/paths.rs:396-400`, `src/paths.rs:488-493`
- **Problem:** Unix path operations pass `-100` as the `openat` directory descriptor for root paths. That is Linux's `AT_FDCWD`; Darwin uses `-2`. Absolute roots work because `openat` ignores the descriptor for absolute paths, but direct path API calls or `VaultRuntime::open` with a relative root fail on macOS.
- **Recommendation:** Use the platform's `AT_FDCWD` value through a platform abstraction and cover relative-root operations on each supported Unix target.
- **Fix with:** os-boundaries
- **Effort:** S

