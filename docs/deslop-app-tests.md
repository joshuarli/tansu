# Application and integration tests deslop evidence

Scope: `src/` and `tests/`, Darwin arm64, base `9a1aec70eb6095ea7f98588d6a384d54a8fe181b`; Rust nightly 1.102.0. No production or test code changed. Commands below first use `export PATH="$HOME/.local/bin:$PATH" TMPDIR="$PWD/.work/tmp"`.

## DSLP-3

`CARGO_BUILD_JOBS=4 cpu-guard --cores 8 -- cargo clippy -p tansu --all-targets --message-format short -- -W unsafe-code -W unreachable-pub -W clippy::wildcard_enum_match_arm -W clippy::match_wildcard_for_single_variants -W clippy::cast_possible_truncation -W clippy::cast_sign_loss -W clippy::unwrap_used -W clippy::expect_used -W clippy::redundant_clone -W clippy::needless_pass_by_value` exited 0. Counts below are diagnostic lines in `src/` and `tests/`, including duplicate target diagnostics, not distinct defects; dependency diagnostics are excluded.

| Candidate | Diagnostics | Disposition |
| --- | ---: | --- |
| unsafe code | 13 | Rejected: path operations use OS primitives (`src/paths.rs:243`); no safe replacement was proved. |
| wildcard enum arm; single variant | 24; 1 | Rejected: generic error handling and future variants are intentional in examples such as `src/api.rs:286`; no defect witness. |
| possible truncation; sign loss | 12; 16 | Not adopted: includes time conversions and persisted integers; all sites need individual proof before asserting a defect. |
| unwrap; expect | 1147; 55 | Not adopted: mostly test assertions; the profile would generate many false positives. |
| redundant clone; needless pass by value | 18; 28 | Not adopted: no type defect witness and some suggestions affect signatures. |

Zero settings adopted; all nine candidates rejected or deferred. This does not establish that every cast or assertion is sound.

`rg -n 'unsafe|#!?\[allow\(|\.unwrap\(\)|\.expect\(' src tests | wc -l` returned 1190 matching lines including tests. No source changed, so this count is unchanged. Existing project lint remains in force.

## DSLP-4

| Contract | Guarding test (file:line) | Disposition |
| --- | --- | --- |
| Durable identity through external rename | `src/reconcile.rs:686`, `src/reconcile.rs:751` | Retain: case-only and exact-hash moves preserve note ID. |
| Accepted snapshots and stale saves | `src/vault.rs:3345`, `src/vault.rs:4602`, `src/vault.rs:4623` | Retain: mutation identity, snapshot bytes and conflict draft. |
| Restart and snapshot recovery | `src/vault.rs:3781`, `src/reconcile.rs:618`, `src/reconcile.rs:820` | Retain: durable boundaries, corrupt snapshots and interrupted saves. |
| HTTP API and auth | `src/api.rs:465`, `src/api.rs:922`, `src/http.rs:2039`, `src/auth.rs:1434` | Retain: identity checks, mutation routes, session and origin checks. |
| CLI and paths | `tests/cli_help.rs:4`, `src/main.rs:395`, `src/paths.rs:567`, `src/paths.rs:604` | Retain: help, parsing, traversal and symlinks. Other CLI exit paths lack dedicated tests. |

Test-pyramid audit: edit tier is a filtered `cargo test -p tansu <name>`; change tier is application unit and integration tests; scenario tier includes HTTP and real server process tests; browser tests are separate. `make test` runs generated types, build, Vitest and the Rust workspace. Ground records warm 71.71s on a busy host; individual Rust tier and flake costs are unmeasured. No test was weakened or removed. Vitest baseline ran 50 files and 512 tests in 5.42s, according to the runner. The CLI exit gap remains unverified rather than claiming a false pass.

Fault injection: `cp src/paths.rs .work/tmp/paths-original.rs`; replace the unique `Component::ParentDir => return Err(PathValidationReason::Traversal),` with `Component::ParentDir => parts.push("..".to_string()),`; `CARGO_BUILD_JOBS=4 cpu-guard --cores 8 -- cargo test -p tansu rejects_path_traversal` exited 101. `paths::tests::rejects_path_traversal` failed at `src/paths.rs:569`: `unwrap_err()` received `Ok("../x.md")`. `cp .work/tmp/paths-original.rs src/paths.rs` restored it; `cmp .work/tmp/paths-original.rs src/paths.rs` exited 0. The same test command on restored source exited 0 (one selected test passed).

Needs environment: `make coverage` and `make mutants-diff` each exited 2 (no target); `cargo llvm-cov --version` and `cargo mutants --version` each exited 101 (no such command). Branch coverage, automated critical-scope survivors, before/after mutation and warm cost comparison are unverified. The single injected fault is not an automated mutation sweep. Target and CI changes are outside this slice.

## DSLP-5

The strict clippy command above also enabled rustc `unreachable_pub`; it emitted zero unreachable-public or dead-code diagnostics in `src/` and `tests/`. It exercised all targets on Darwin; it did not assess Linux-only code. `cargo machete --version` and `cargo udeps --version` were unavailable as recorded below.

Workspace caller searches: `rg -n 'checked_visible_path|create_visible_parent|visible_path\(|write_snapshot\(|read_snapshot\(|serve_listener_with_shutdown|normalize_note_path' src tests crates web extension-loupe --glob '!**/vendor/**' --glob '!web/dist/**'` and `rg -n 'write_visible_atomic|create_visible_parent' src tests crates web extension-loupe README.md docs --glob '!**/vendor/**' --glob '!web/dist/**'`. `normalize_note_path` serves vault create and rename (`src/vault.rs:1819`, `src/vault.rs:1916`) and reconciliation (`src/reconcile.rs:326`); snapshot reads serve open and restore (`src/vault.rs:1287`, `src/vault.rs:1610`). Web clients exercise the route contract (`web/ts/app/v2-api.test.ts:148`). `write_visible_atomic` (`src/history.rs:175`) has no in-tree caller; `create_visible_parent` (`src/paths.rs:519`) has only a test caller. Both are exported through public modules (`src/lib.rs:24`, `src/lib.rs:29`); deletion changes a public API and is outside scope. No proven-dead code was removed and no allowlist is claimed. Search covers workspace consumers, not external Rust callers or dynamic references.

The snapshot/catalog/reconciliation machinery preserves the documented accepted-write and recovery guarantees (`docs/architecture.md:42`); stripping it would be a walk-back for local vaults. This bounded review did not establish a safe structural cut. Linux-specific behavior and the full structural debloat lenses were not exercised.

Needs environment: `cargo machete --version` and `cargo udeps --version` each exited 101 (no such command); dependency dead-code analysis remains unverified. No dependency was removed.
