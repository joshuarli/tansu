Prefix: DSLP
Next: 37

Deslop campaign backlog ([plan](https://github.com/laputa-systems/stuff/blob/main/docs/campaigns/deslop.md), tier D). One agent works this file with the `deslop` skill: take the lowest-numbered open ticket whose area does not start with `Needs owner ·`. After DSLP-5, work the open P1 and P2 findings, then fill in `## Report` below.

## Report

**Scorecard**

- First-party physical lines, base `6af00da` → `005101c`: source files 45,721 → 46,093; separately named test files 16,099 → 16,188. These include blanks and comments; Rust inline tests count as source. The same command was used for both revisions:

  ```sh
  for rev in 6af00da HEAD; do for kind in source test; do
    git ls-tree -r --name-only "$rev" | rg '^(src/|crates/|tests/|web/ts/|extension-loupe/|scripts/|bench/|deploy/|build\.rs$)' | rg '\.(rs|ts|mjs|js|py|sh)$' | rg -v '(^vendor/|/vendor/|/dist/)' | { if [ "$kind" = test ]; then rg '(^tests/|/tests?/|\.test\.|_test\.|/e2e/)'; else rg -v '(^tests/|/tests?/|\.test\.|_test\.|/e2e/)'; fi; } | while IFS= read -r f; do git show "$rev:$f"; done | wc -l
  done; done
  ```

- Warm `make test`: 71.71s → 51.07s, both busy-host single runs, not a performance comparison. Ground also recorded cold test 701.79s and cold lint 718.42s (`AGENTS.md`). Report measurement: `export PATH="$HOME/.local/bin:$PATH" TMPDIR="$PWD/.work/tmp"; make test; /usr/bin/time -p make test`, both exited 0 while other builds ran.
- Line and branch coverage: unmeasured before and after; the Makefile has no coverage goal and Rust `cargo-llvm-cov` and TS coverage-v8 were unavailable. Mutants caught/missed/timeout/unviable: unmeasured before and after; a mutants-diff goal, cargo-mutants and Stryker were unavailable. Manual fault injections are sensitivity checks, not mutation totals (see component evidence).
- Escape hatches: raw matching lines, Rust 1,445 → 1,474; TypeScript 282 → 285. Includes tests and lexical false positives; it does not prove soundness. Count each revision's tracked first-party `.rs` or `.ts` files under the directories in the line-count command, excluding vendor and dist, concatenate with `git show "$rev:$f"`, then respectively `rg '(^|[^[:alnum:]_])unsafe([^[:alnum:]_]|$)|#!?\[allow\(|\.unwrap\(\)|\.expect\(' | wc -l` and `rg -P '\bas (?!const\b)|\bany\b|@ts-(ignore|expect-error)|(oxlint|eslint)-disable' | wc -l`. Component counts and their narrower baselines are in the seven component documents.
- Dead code removed: 0 proven lines and 0 dependencies; analysis was incomplete because dependency and debloat tools were unavailable. Findings filed during the campaign: P1 0, P2 3 (DSLP-25–27), P3 10 (DSLP-24, 28–36), P4 0. Fixed: P2 3, P3 1 (DSLP-24 by hand); P3 9 remain. Step tickets are excluded from these counts. DSLP-36 records a residual flood risk after DSLP-26.
- Performance verdict: unmeasured; the bench-pyramid audit did not run timings on the busy host (`docs/deslop-tooling.md`). Escaped regressions: none demonstrated by the completion review (not proof of absence). DSLP-36 is a pre-existing eviction trade-off, not a campaign regression.

**Per step**

- **Ground:** recorded test and lint costs, public boundaries and components, vendor provenance, and `make test-ci`. Costs: cold test 701.79s, warm 71.71s, cold lint 718.42s; CI minutes not recorded (`AGENTS.md`).
- **Diagnose:** reproduced three P2 and four P3 findings at `8a20a7b` (`docs/deslop-diagnose.md`); total wall time and CI minutes not recorded.
- **Types:** seven component audits adopted no additional strict setting; candidates lacked a defect witness or had substantial false positives. Tooling uncovered DSLP-34. Costs and CI minutes per audit not recorded; candidate counts and limits are in `docs/deslop-{app-tests,search-crates,web-editor,web-app,web-ui,loupe,tooling}.md`.
- **Tests:** mapped boundary tests and used manual injected faults; no automated coverage or mutation result. Recorded focused runner times: editor 0.526s, web app 5.72s, web UI 0.459s, Loupe 0.533s and Loupe browser 1.99s; application Vitest baseline 5.42s. These busy-host figures are runner times, not total campaign cost; CI minutes unrecorded. Other CLI exit paths remain unguarded (`docs/deslop-app-tests.md`).
- **Dead code:** caller searches and compiler diagnostics found no safe removal; public exports and registered entrypoints retained. Complete dependency analysis and debloat remain unverified; wall time and CI minutes unrecorded (component documents).
- **Bench:** `docs/deslop-tooling.md` audits the existing `make bench` scenario and edit-tier tests; it identifies missing interleaved comparisons, a change selector, resource attribution and prerequisite reporting. No timing or CI minutes measured.
- **Findings:** PR #33 addressed DSLP-25–27; DSLP-32–33 capture remaining oversize concerns, DSLP-34–35 tooling issues, DSLP-36 continued login flooding. Completion review covered `git diff 6af00da..005101c`: DSLP-36 filed, none further demonstrated. The search revision filter rejects stale index hits. Wall time and CI minutes for fixes and review were not recorded.

**Method feedback**

Require a continuing-flood test around login completion, not just a login started after a flood stops; it would expose DSLP-36's remaining trade-off. Component workers repeatedly reported the coverage/mutation recipe requirement as unmet acceptance when tools were absent on Darwin; distinguish unavailable tooling from a measured clean result. `cpu-guard --cores 4` killed rustc during `make test` and `make lint`, resembling a test failure. Parallel component PRs conflicted on ticket closures in `TODO-DESLOP.md` and needed serial rebases. Dead-code audits found no safe cut, with tool gaps noted above.

**Shared-file gaps**

STUF-97: `@pnpm/exe` was not mirrored for packageManager pins; pnpm 12.21.0 was fixed by hand for DSLP-24. The shared registry needs to mirror the pinned executable.

## Tickets

### DSLP-28 · P3 · Delta save applies edits in quadratic time before verifying the hash

- **Area:** HTTP endpoints · note save
- **Where:** crates/tansu-note-core/src/edit.rs apply_text_edits, text_position_to_byte_offset
- **Problem:** Each edit position rescans the document from line 0 and each edit does a separate replace_range, and apply runs before the candidate sourceHash check. Reproduced on target/debug/tansu at 8a20a7b (debug build, authenticated-owner path; local mode accepts loopback origins) with a 2,000,000-line note: PATCH with 250 edits (25 KB) took 22.7 s, 500 edits 46.3 s, 1,000 edits (101 KB) 89.6 s, each answered 400 source_hash_mismatch. The 32 MiB body cap allows about 300,000 edits, hours of CPU on one of the 8 blocking-request slots; eight such requests make every API call return 429. Needs a session, so it is not reachable by an unauthenticated client. Evidence: docs/deslop-diagnose.md F4.
- **Recommendation:** Build a line-start index once and apply edits in a single pass, cap the edit count, and reject early when the declared sourceHash cannot match the size bounds.
- **Fix with:** make-it-fast
- **Effort:** S

### DSLP-29 · P3 · One unreadable Markdown file or folder makes the whole vault unavailable

- **Area:** file and path handling · reconcile
- **Where:** src/reconcile.rs walk_dir (read_visible_bytes and read_dir use ?)
- **Problem:** walk_dir aborts the vault scan on the first I/O error. Reproduced on target/debug/tansu at 8a20a7b: a vault with good.md and a mode-000 bad.md, then a vault with good.md and a mode-000 folder locked/, each reported bootstrap vaults[0].error 'Permission denied (os error 13)' and every vault route answered 503 vault_unavailable, hiding the readable note; the message names no path. Invalid UTF-8 files are already isolated as unresolved, so unreadable files are an inconsistent exception. Evidence: docs/deslop-diagnose.md F5.
- **Recommendation:** Treat per-entry read errors as an unresolved file (or skipped folder) carrying the path and error, keep the rest of the vault usable, and name the path in the message.
- **Fix with:** error-model
- **Effort:** S

### DSLP-30 · P3 · Idle half-open connections hold all 64 connection slots for up to 600 s

- **Area:** HTTP endpoints · resource bounds
- **Where:** src/http.rs handle_connection, drive_connection (MAX_CONNECTIONS 64, MAX_CONNECTION_DURATION 600 s, no header-read deadline)
- **Problem:** Only the body has a 10 s deadline; a client that sends an incomplete request head keeps its slot until the 600 s connection cap. Reproduced on target/debug/tansu at 8a20a7b: 64 sockets that sent 'GET /api/v2/health' headers without the final blank line made GET /api/v2/health return 503 for every later caller, including 30 s later. No credentials needed, but only clients that reach the listener can do it (loopback by default; a reverse proxy parses heads first). Evidence: docs/deslop-diagnose.md F6.
- **Recommendation:** Add a header-read timeout (hyper header_read_timeout with a timer) and a short idle deadline before the first request byte, and test it with the existing transport-limit harness.
- **Fix with:** lifecycle-concurrency
- **Effort:** S

### DSLP-31 · P3 · Loupe image scanner is quadratic on hostile page Markdown

- **Area:** Loupe extension · extension messaging
- **Where:** extension-loupe/src/loupe-image-scanner.ts findLoupeImageOccurrences (called from prepareTansuImport in the service worker)
- **Problem:** Repeated link-opening text rescans to the end for each occurrence. Reproduced by importing the product module in node: a line of '![a](' repeated 20,000 times (100 KB) took 2.7 s and 40,000 times (200 KB) 10.9 s; 800 distinct backtick run lengths (321 KB) took 0.3 s and are not the worst case. The input is the Markdown of whatever page the user sends to Tansu, and runs in the extension service worker. Not exercised in a packaged extension. Evidence: docs/deslop-diagnose.md F7.
- **Recommendation:** Make the scan linear (record failed openers, cap per-line work) and add a worst-case timing test next to loupe-image-scanner.test.ts.
- **Fix with:** make-it-fast
- **Effort:** S

### DSLP-32 · P3 · Reconcile reads oversized notes whole to hash them

- **Area:** deslop · findings · vault reconcile
- **Where:** src/vault.rs (reconcile walk)
- **Problem:** DSLP-25 stopped oversized notes from disabling search, but the reconcile walk still reads each file whole to hash it, so a 1.3 GB note spikes RSS by about the file size.
- **Recommendation:** Hash in bounded chunks (streaming) or skip content hashing above the indexing limit, with a regression test that bounds peak RSS or read size for an oversized note.
- **Fix with:** deslop
- **Effort:** S

### DSLP-33 · P3 · Show unindexed oversize notes in the web UI

- **Area:** deslop · findings · search status
- **Where:** src/search.rs skipped_oversize(), web/ts/app
- **Problem:** Notes over MAX_INDEXED_NOTE_BYTES are skipped silently in the UI; only the vault-open log reports unindexedOversizeNotes, so a user cannot tell why a note is missing from search.
- **Recommendation:** Expose the skipped count or ids through the search status API and show it in the search UI, with a test.
- **Fix with:** deslop
- **Effort:** S

### DSLP-34 · P3 · vitest.e2e.config.ts sets minWorkers, which Vitest InlineConfig does not declare

- **Area:** tooling · browser tests
- **Where:** vitest.e2e.config.ts:13
- **Problem:** Typechecking the root Vitest configs under the repo tsconfig (docs/deslop-tooling.md, DSLP-11) fails because vitest.e2e.config.ts:13 sets minWorkers, which the installed Vitest InlineConfig does not have. If Vitest ignores the key, the browser suite runs with a worker floor other than the one this config intends.
- **Recommendation:** Check the installed Vitest release for the replacement setting, apply the intended worker limit through it, and include the root configs in a typecheck so a removed option fails CI.
- **Fix with:** none
- **Effort:** S

### DSLP-35 · P3 · Review unquoted SSH option expansion in deploy-state.sh

- **Area:** tooling · deployment
- **Where:** deploy/deploy-state.sh:91
- **Problem:** shellcheck reports SC2086 at deploy/deploy-state.sh:91, where SSH options expand unquoted. If the word splitting is intentional it is undocumented; otherwise an option value containing whitespace or glob characters changes the ssh command line.
- **Recommendation:** Build the SSH options as an array (or prove the splitting is required), then make shellcheck clean for deploy/ apart from reasoned directives.
- **Fix with:** none
- **Effort:** S

### DSLP-36 · P3 · A continuing login flood evicts an owner’s pending ceremony

- **Area:** HTTP and auth · login availability
- **Where:** src/auth.rs begin_authentication and src/http.rs POST /api/v2/auth/login/options
- **Problem:** At 005101c08935c6243b8909863ef04617f4d87ffc, begin_authentication evicts the oldest authentication ceremony when 256 are pending. An unauthenticated caller can issue 256 login/options requests after the owner starts login and before the owner finishes, evicting the owner’s ceremony; login/finish then rejects it as CeremonyUsed. Reproduce with cargo test -p tansu anonymous_login_flood_cannot_lock_the_owner_out: the test creates an oldest ticket, creates 511 more, and asserts finishing the oldest returns CeremonyUsed. It checks the owner ticket only after the flood stops. Eviction is the deliberate trade-off documented at src/auth.rs:503–505: refusing new ceremonies lets a caller fill the table and lock the owner out. Under either policy a continuous anonymous flood can deny owner login; per-client rate limiting of login/options addresses the flood, not a different eviction order.
- **Recommendation:** Add per-client rate limiting to login/options and test an owner login amid a continuing anonymous flood.
- **Fix with:** security
- **Effort:** M

