# Search and shared crates deslop evidence

Scope: `crates/`, Darwin arm64, base `9a1aec70eb6095ea7f98588d6a384d54a8fe181b`; Rust nightly 1.102.0 (2026-11-08). No production or test code changed. Commands below use `export PATH="$HOME/.local/bin:$PATH" TMPDIR="$PWD/.work/tmp"` first.

## DSLP-6

`cargo clippy -p tansu-search -p tansu-search-policy -p tansu-note-core -p tansu-api-types -p tansu-webauthn -p gen-api-types --all-targets --message-format short -- -W unsafe-code -W clippy::wildcard_enum_match_arm -W clippy::match_wildcard_for_single_variants -W clippy::cast_possible_truncation -W clippy::cast_sign_loss -W clippy::unwrap_used -W clippy::expect_used -W clippy::redundant_clone -W clippy::needless_pass_by_value` exited 0. Counts are emitted diagnostic lines, including test targets and duplicate locations, not distinct defects. Three additional warnings were existing type complexity warnings.

| Candidate | Diagnostics | Disposition |
| --- | ---: | --- |
| unsafe code; single-variant wildcard | 0; 0 | Rejected: no defect or escape-hatch witness for adoption. |
| wildcard enum arm | 3 | Rejected: CBOR matching must reject all other and future variants (`crates/tansu-webauthn/src/lib.rs:451`). |
| possible truncation; sign loss | 11; 1 | Not adopted: includes bounded search limit (`crates/tansu-search/src/types.rs:185`) and slice cursor offsets; remaining casts need individual proof. |
| unwrap; expect | 285; 5 | Not adopted: mostly tests; production includes length-checked conversion (`crates/tansu-webauthn/src/lib.rs:573`) and infallible string formatting. Not all sites were individually audited. |
| redundant clone; needless pass by value | 8; 11 | Not adopted: no type witness; some suggestions change public signatures. |

`rg -n 'unsafe|#!?\[allow\(|\.unwrap\(\)|\.expect\(' crates | wc -l` counted 284 matching lines, including tests; no source changed, so the count is unchanged. The adopted strict settings count is zero; the existing project lint remains in force. The audit has not established that every cast or assertion is sound.

## DSLP-12

| Contract | Guarding test (file:line) | Disposition |
| --- | --- | --- |
| Search indexing and updates | `crates/tansu-search/src/service.rs:452`, `crates/tansu-search/src/service.rs:623`, `crates/tansu-search/src/service.rs:784` | Retain: stale revisions, visibility, rebuild. |
| Search query and matching | `crates/tansu-search/src/search.rs:709`, `crates/tansu-search/src/search.rs:1088`, `crates/tansu-search/src/search.rs:1156`; `crates/tansu-search/tests/reference_parity.rs` | Retain: terms, phrases, parser and reference outputs. |
| Note bytes and save preconditions | `crates/tansu-note-core/src/document.rs:158`, `crates/tansu-note-core/src/save.rs:118`, `crates/tansu-note-core/src/submitted.rs:114` | Retain: line endings, conflicts, source hash. |
| API wire types | `crates/tansu-api-types/src/lib.rs:822`, `crates/tansu-api-types/src/lib.rs:924`, `crates/tansu-api-types/src/lib.rs:936` | Retain: discriminator, round trip, rejected unknown fields. |
| WebAuthn | `crates/tansu-webauthn/src/lib.rs:999`, `crates/tansu-webauthn/src/lib.rs:1063`, `crates/tansu-webauthn/src/lib.rs:1096` | Retain: round trip, bad signature and required user verification. |

Test-pyramid audit: edit tier is a selected `cargo test -p ... <test>`; component tier is crate tests and reference parity; application integration includes `src/vault.rs` and `src/api.rs`; browser scenarios are separate. `make test` combines generated types, web build, Vitest and workspace Rust tests (Makefile:75); repository guidance records warm 71.71s on a busy host. Individual layer costs and flake rate were not measured. No test was deleted or weakened.

Fault injection: copy `crates/tansu-webauthn/src/lib.rs` to `.work/tmp/webauthn-original.rs`, replace the unique `if flags & 0x04 == 0 {` with `if false {`, then run `cpu-guard --cores 4 -- cargo test -p tansu-webauthn user_verification_is_required_at_both_ceremony_finishes`. Exit 101: `tests::user_verification_is_required_at_both_ceremony_finishes` failed at line 1103 because registration accepted missing user verification. Restore with `cp .work/tmp/webauthn-original.rs crates/tansu-webauthn/src/lib.rs`; `cmp .work/tmp/webauthn-original.rs crates/tansu-webauthn/src/lib.rs` exited 0. The same test command on restored source exited 0 (1 passed).

Needs environment: `make coverage` and `make mutants-diff` both exited 2, no such targets; `cargo llvm-cov --version` and `cargo mutants --version` exited 101, no such commands. Branch coverage, bounded automated mutation, survivor dispositions and the warm cost comparison are unverified. A hand injection is one sensitivity check, not a substitute. No CI lane is qualified by this run.

## DSLP-18

`cargo clippy` above exercised rustc dead-code diagnostics on all targets for these packages; no dead-code diagnostic was emitted. Needs environment: `cargo machete --version` exited 101 (not installed); `cargo-udeps` is also unavailable. Dependency dead-code analysis and a complete debloat sweep remain unverified; no allowlist or removal is claimed.

Workspace-wide caller searches: `rg -n 'tansu_(search|search_policy|note_core|api_types|webauthn)' src crates web --glob '!**/vendor/**'` and `rg -n 'SearchService|SearchIndex|rebuild\(|upsert\(|RelyingParty|SourceDocument|V2SearchRequest' src crates web/ts --glob '!**/vendor/**'`. Search service is used by `src/search.rs:6` and `src/search.rs:113`; note documents by `src/vault.rs:419`; WebAuthn by `src/http.rs:38` and `src/auth.rs:14`; API types are generated by `crates/gen-api-types/src/main.rs:50` and consumed by `web/ts/app/tag-suggestions.ts:1` and `web/ts/app/v2-api.test.ts:143`. Public entry points and generated wire types therefore cannot be classified dead from crate-local searches. The search index lifecycle helpers at `crates/tansu-search/src/index.rs:154` are explicitly test-only; their tests are callers. No proven-dead code was removed. Search's derived index and recovery machinery (`src/search.rs:90`) serves the vault and is not a justified structural cut. Other debloat lenses and Linux-specific behavior remain unreviewed.
