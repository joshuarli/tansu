# Tansu2 TODO

Prefix: TNS
Next: 21

### TNS-1 · P2 · Reject misspelled authentication settings

- **Area:** Security configuration
- **Where:** `src/config.rs:350-370`, `src/config.rs:416-443`, `src/main.rs:48-70`
- **Problem:** Unknown TOML fields are ignored. A typo such as `[auh]` leaves `auth` unset, and startup constructs the server without an `AuthStore`, silently disabling authentication when the listener is exposed through a proxy.
- **Recommendation:** Reject unknown fields in the top-level config and nested security tables, and test a misspelled auth table.
- **Fix with:** none
- **Effort:** S

### TNS-2 · P2 · Bound pending authentication ceremonies

- **Area:** Authentication storage
- **Where:** `src/http.rs:901-921`, `src/http.rs:1009-1016`, `src/auth.rs:475-487`
- **Problem:** The unauthenticated login-options route stores a ceremony row on every request. Rows expire after five minutes, but expiry is checked only when a ceremony is finished and no code prunes abandoned rows, so reachable callers can grow `auth.db` without bound.
- **Recommendation:** Prune expired rows during issuance and cap or rate-limit pending ceremonies.
- **Fix with:** durable-state, lifecycle-concurrency
- **Effort:** M

### TNS-3 · P2 · Validate RP IDs against public suffix rules

- **Area:** Authentication configuration
- **Where:** `src/auth.rs:63-78`, `docs/configuration.md:46-53`
- **Problem:** Validation accepts any host suffix, including `com`; WebAuthn clients reject a public suffix as an RP ID, so configuration succeeds but passkey ceremonies fail in the browser. The [WebAuthn RP ID rules](https://www.w3.org/TR/webauthn-3/#rp-id) require the ID to equal the origin's effective domain or be a registrable domain suffix.
- **Recommendation:** Reject invalid RP IDs during configuration and select a maintained public-suffix source or a narrower supported RP ID rule.
- **Fix with:** none
- **Effort:** M
- **Design:** `docs/rfcs/0002-webauthn-rp-id-validation.md`

### TNS-4 · P2 · Apply a policy to non-increasing passkey counters

- **Area:** Authentication
- **Where:** `crates/tansu-webauthn/src/lib.rs:375-377`, `src/auth.rs:517-524`
- **Problem:** The verifier returns `CounterResult::NonIncreasing`, but authentication ignores it, stores the credential, and issues a session. A non-increasing nonzero counter can indicate a cloned authenticator, while a passkey may be synced or assertions may race.
- **Recommendation:** Decide how single-device and backup-eligible credentials handle this signal, then reject, require additional verification, or record the anomaly before issuing a session.
- **Fix with:** durable-state
- **Effort:** M
- **Design:** `docs/rfcs/0001-webauthn-counter-policy.md`

### TNS-5 · P2 · Recover prepared image uploads after restart

- **Area:** Data recovery
- **Where:** `src/vault.rs:758-760`, `src/vault.rs:1075-1097`, `src/vault.rs:1113-1127`, `src/paths.rs:433-450`
- **Problem:** Startup deletes prepared mutations even though image upload writes its asset before accepting the mutation. A crash in that interval loses the recovery record; retrying the same ID then hits the existing filename. Interrupted writes can also leave partial bytes at the final path.
- **Recommendation:** Preserve and recover prepared image mutations, and publish each asset atomically so interruption cannot leave a partial destination.
- **Fix with:** durable-state, os-boundaries, lifecycle-concurrency
- **Effort:** M

### TNS-6 · P2 · Reconcile case-fold collisions by exact path

- **Area:** Vault reconciliation
- **Where:** `src/reconcile.rs:30-42`, `src/reconcile.rs:55-61`, `src/reconcile.rs:417-445`, `src/catalog.rs:771-775`
- **Problem:** Collision insertion checks for any live note with the shared path key. If a collision is added beside an existing note, the live note suppresses the unresolved record and reconciliation can apply the lexically first file's bytes to that note. Unresolved-only paths are also inserted again on each reconciliation.
- **Recommendation:** Match unresolved records by exact path and reason, preserving the live note and making repeated reconciliation idempotent.
- **Fix with:** durable-state
- **Effort:** M

### TNS-7 · P2 · Recover baseline snapshots after interrupted imports

- **Area:** Data recovery
- **Where:** `src/reconcile.rs:155-172`, `src/reconcile.rs:460-472`
- **Problem:** First scan commits a note row before writing its baseline snapshot. If snapshot creation fails or the process stops between those operations, the next scan sees matching visible bytes but marks the note unresolved because the snapshot is missing.
- **Recommendation:** Write and sync the snapshot before inserting the row, or rebuild a missing snapshot from visible bytes when their source hash matches.
- **Fix with:** durable-state
- **Effort:** S

### TNS-8 · P2 · Persist watcher events with reconciled changes

- **Area:** Event freshness
- **Where:** `src/vault.rs:3110-3145`, `src/vault.rs:2049-2054`, `web/ts/app/v2-api.ts:986-998`
- **Problem:** Watcher reconciliation commits catalog changes before appending replay events in separate transactions. A crash in between leaves an updated catalog with no event; restart reconciliation sees no change to publish, so connected clients can remain stale until another refresh.
- **Recommendation:** Commit the event with reconciliation changes or persist a resync signal before reconciliation returns.
- **Fix with:** durable-state
- **Effort:** M

### TNS-9 · P2 · Reject symlinks during legacy state migration

- **Area:** Filesystem security
- **Where:** `src/vault.rs:3359-3390`
- **Problem:** Legacy `.tansu` migration uses path APIs that follow symlinks. A symlinked directory or child can make startup copy files from outside the vault or recurse through a symlink loop.
- **Recommendation:** Reject symlinks in the legacy tree and copy through handle-relative operations that do not follow replaced path components.
- **Fix with:** os-boundaries
- **Effort:** M

### TNS-10 · P2 · Resolve HTML import when the file picker is canceled

- **Area:** Browser import lifecycle
- **Where:** `web/ts/html-import.ts:33-40`, `web/ts/app.ts:206`
- **Problem:** The picker promise resolves only on `change`. Native cancellation does not dispatch that event, leaving the import action pending; vault changes and logout drain in-flight actions and can then wait indefinitely.
- **Recommendation:** Resolve on the input's `cancel` event and remove both listeners after completion.
- **Fix with:** lifecycle-concurrency
- **Effort:** S

### TNS-11 · P2 · Reload a note reopened during an in-flight load

- **Area:** Tab loading state
- **Where:** `web/ts/app.ts:591-605`, `web/ts/app.ts:609-650`
- **Problem:** Loads are shared by note identity but hydrate the original tab object. If that tab closes during loading and the note is reopened before the promise settles, the new tab reuses the old promise and stays unhydrated.
- **Recommendation:** Make the shared result hydrate the current tab or discard the in-flight entry when its tab closes.
- **Fix with:** lifecycle-concurrency
- **Effort:** S

### TNS-12 · P2 · Show partial draft-search coverage

- **Area:** Search correctness
- **Where:** `web/ts/app/v2-api.ts:846-853`, `web/ts/app.ts:944-975`, `web/ts/view.ts:608-616`
- **Problem:** The API decodes `overlayCoverage`, including skipped draft counts, but both search handlers discard it. The UI can present incomplete draft-overlay results as complete.
- **Recommendation:** Carry coverage state with results and show when the overlay skipped drafts.
- **Fix with:** none
- **Effort:** S

### TNS-13 · P2 · Bind revision actions to the note that loaded them

- **Area:** Revision UI state
- **Where:** `web/ts/app.ts:1304-1325`
- **Problem:** Revision list and document state are shared across tabs. If the active note changes while a list request is pending, the UI can show one note's list while preview and restore actions use the new active note.
- **Recommendation:** Store the originating note identity with revision state and ignore stale responses after a note switch.
- **Fix with:** lifecycle-concurrency
- **Effort:** S

### TNS-14 · P2 · Isolate release write permission from build jobs

- **Area:** Release security
- **Where:** `.github/workflows/build-server.yml:8-9`, release asset upload steps
- **Problem:** Workflow-wide `contents: write` applies while dependency installation and compilation run. The checkout persists credentials, so build-time code runs in jobs with permission to write repository contents.
- **Recommendation:** Keep build jobs read-only, disable persisted checkout credentials there, and grant write permission only to a separate release-upload job.
- **Fix with:** lifecycle-concurrency
- **Effort:** M

### TNS-15 · P3 · Run CI on code changes

- **Area:** CI
- **Where:** `.github/workflows/ci.yml:3-5`
- **Problem:** CI has only a manual `workflow_dispatch` trigger, so pushes and pull requests do not automatically run `make ci`.
- **Recommendation:** Add the intended push and pull-request triggers while retaining manual dispatch if useful.
- **Fix with:** none
- **Effort:** S

### TNS-16 · P3 · Run workspace Rust tests from `make test`

- **Area:** Test workflow
- **Where:** `Makefile:53,67-68`, `Cargo.toml:6-7`
- **Problem:** `test-rs` runs `cargo test -q` without `--workspace`, so local `make test` skips unit tests in `tansu-search` and `tansu-webauthn` even though CI coverage runs workspace tests.
- **Recommendation:** Make the documented Rust test target run all workspace members.
- **Fix with:** none
- **Effort:** S

### TNS-17 · P3 · Make Rust lint check-only

- **Area:** Developer workflow
- **Where:** `Makefile:22-23`
- **Problem:** `lint-rs` runs `cargo clippy --fix --allow-dirty`, and `make ci` invokes it. Lint can mutate source before the rest of CI validates the checkout.
- **Recommendation:** Run Clippy without auto-fix and make the warning policy explicit.
- **Fix with:** none
- **Effort:** S

### TNS-18 · P3 · Stage SQLite downloads before caching them

- **Area:** Build operability
- **Where:** `scripts/build-sqlite-static.sh:18-20,27-31`
- **Problem:** `curl` writes directly to the cached archive path. An interrupted download leaves a partial file that later runs skip downloading and repeatedly reject by checksum.
- **Recommendation:** Download to a temporary path, verify it, then rename it into the cache.
- **Fix with:** os-boundaries
- **Effort:** S

### TNS-19 · P3 · Compute find-result line offsets once

- **Area:** Find performance
- **Where:** `web/ts/view.ts:634-635`
- **Problem:** Each find result splits a source prefix and the full document to derive its line and context. With up to 100 matches, rendering repeats work across the entire note for every result.
- **Recommendation:** Build line-start offsets once and use them for all result rows.
- **Fix with:** make-it-fast
- **Effort:** S

### TNS-20 · P3 · Reconfigure the editor only when its inputs change

- **Area:** Editor performance
- **Where:** `web/ts/app.ts:401,445,539`, `web/ts/editor/codemirror-adapter.ts:771`
- **Problem:** App renders build a fresh extension array, and the adapter reconfigures when array identity changes. This creates repeated editor reconfiguration during unrelated renders; impact has not been measured.
- **Recommendation:** Keep extension identity stable or compare configuration inputs, then profile representative large notes before claiming a speedup.
- **Fix with:** make-it-fast
- **Effort:** M
