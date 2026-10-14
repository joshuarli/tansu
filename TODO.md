# Tansu2 TODO

Prefix: TNS
Next: 21

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
