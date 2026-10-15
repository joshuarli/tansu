# Tansu2 TODO

Prefix: TNS
Next: 38

### TNS-024 · P1 · Serialize vault mutations across server processes

- **Area:** Concurrency
- **Where:** `src/vault.rs:72`, `src/vault.rs:1380`, `src/catalog.rs:373`
- **Problem:** Mutation serialization uses a `Mutex` owned by one `VaultRuntime`. Two server processes opening the same vault have separate mutexes, so both can validate the same base revision before either materializes its content. Both writes can be accepted and the later materialization can overwrite the earlier one without a conflict draft.
- **Recommendation:** Hold a per-vault process lock across mutation acceptance and file materialization, or use an equivalent cross-process compare-and-set.
- **Fix with:** durable-state
- **Effort:** M

### TNS-025 · P2 · Reject malformed persisted catalog values

- **Area:** Data
- **Where:** `src/catalog.rs:1025`, `src/catalog.rs:1082`, `src/catalog.rs:1144`, `src/catalog.rs:1212`
- **Problem:** Invalid session JSON becomes an empty session, invalid tag JSON becomes empty tags, and invalid sync versions become zero. The app silently discards persisted state or resets a sync version instead of surfacing catalog corruption.
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

### TNS-031 · P2 · Audit Rust dependencies in the audit target

- **Area:** Dependencies
- **Where:** `Makefile:46-48`
- **Problem:** `make audit` runs only `pnpm audit`; the Rust audit command is commented out and there is no active Rust dependency audit configuration. Vulnerable Rust dependencies can pass the repository’s named audit target unnoticed.
- **Recommendation:** Configure and run a Rust dependency audit from the target, or narrow the target name and remove the stale command.
- **Fix with:** none
- **Effort:** S

### TNS-032 · P2 · Remove the unreferenced handwritten editor stack

- **Area:** Dead code
- **Where:** `web/ts/editor/index.ts:1-40`
- **Problem:** The handwritten renderer and serializer are still exported from the editor entry point, but production uses the CodeMirror adapter and repository search found no non-test imports of this entry point. Keeping both editor stacks expands the code and tests maintainers must understand.
- **Recommendation:** Confirm there are no supported external consumers, then remove the legacy renderer, serializer, extensions, and tests that exist only for them.
- **Fix with:** dead-code-archaeology
- **Effort:** M

### TNS-033 · P2 · Verify packaged binaries before release upload

- **Area:** Build
- **Where:** `.github/workflows/build-server.yml:54-63`, `.github/workflows/build-server.yml:136-155`, `Makefile:97-101`
- **Problem:** The release workflow builds and uploads archives without running the existing packaged-binary smoke check. A binary can compile and still fail its packaged runtime checks after the release is published.
- **Recommendation:** Run the narrow package smoke check on release artifacts before uploading them.
- **Fix with:** none
- **Effort:** S

### TNS-037 · P2 · Use the search shortcut in the real-server e2e

- **Area:** Tests
- **Where:** `web/ts/e2e/server.test.ts:155-156`, `web/ts/app.ts:300`
- **Problem:** The real-server startup test presses `/` and waits for search results, while the app opens search only for Ctrl+/. The filtered Chromium test fails on this mismatch on both the current tree and the TNS-035 base, so the e2e suite cannot pass this case.
- **Recommendation:** Press `Control+/` or use a shared helper that matches the app shortcut.
- **Fix with:** renovate-tests
- **Effort:** S

