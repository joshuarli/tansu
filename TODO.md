Prefix: TNS
Next: 134

# Tansu TODO
### TNS-119 · P3 · Delta save applies edits in quadratic time before verifying the hash

- **Area:** HTTP endpoints · note save
- **Where:** crates/tansu-note-core/src/edit.rs apply_text_edits, text_position_to_byte_offset
- **Problem:** Each edit position rescans the document from line 0 and each edit does a separate replace_range, and apply runs before the candidate sourceHash check. A 2,000,000-line note with 250, 500 and 1,000 edits and a wrong sourceHash took 22.7, 46.3 and 89.6 seconds respectively in a debug build on the authenticated-owner path. The 32 MiB body cap allows about 300,000 edits, potentially occupying all eight blocking-request slots. Local mode accepts loopback origins.
- **Recommendation:** Build a line-start index once and apply edits in a single pass, cap the edit count, and reject early when the declared sourceHash cannot match the size bounds.
- **Fix with:** make-it-fast
- **Effort:** S

### TNS-120 · P3 · One unreadable Markdown file or folder makes the whole vault unavailable

- **Area:** file and path handling · reconcile
- **Where:** src/reconcile.rs walk_dir (read_visible_bytes and read_dir use ?)
- **Problem:** walk_dir aborts the vault scan on the first I/O error. A vault with a readable note and a mode-000 Markdown file or folder reported Permission denied and all vault routes returned 503 vault_unavailable; the message named no path. Invalid UTF-8 files are isolated as unresolved.
- **Recommendation:** Treat per-entry read errors as an unresolved file (or skipped folder) carrying the path and error, keep the rest of the vault usable, and name the path in the message.
- **Fix with:** error-model
- **Effort:** S

### TNS-121 · P3 · Idle half-open connections hold all 64 connection slots for up to 600 s

- **Area:** HTTP endpoints · resource bounds
- **Where:** src/http.rs handle_connection, drive_connection (MAX_CONNECTIONS 64, MAX_CONNECTION_DURATION 600 s, no header-read deadline)
- **Problem:** Only the body has a 10 s deadline; a client that sends an incomplete request head keeps its slot until the 600 s connection cap. In a debug build, 64 incomplete requests made later health requests return 503, including 30 seconds later. No credentials are needed, but only clients that reach the listener can do this; it binds loopback by default and a reverse proxy parses heads first.
- **Recommendation:** Add a header-read timeout (hyper header_read_timeout with a timer) and a short idle deadline before the first request byte, and test it with the existing transport-limit harness.
- **Fix with:** lifecycle-concurrency
- **Effort:** S

### TNS-122 · P3 · Loupe image scanner is quadratic on hostile page Markdown

- **Area:** Loupe extension · extension messaging
- **Where:** extension-loupe/src/loupe-image-scanner.ts findLoupeImageOccurrences (called from prepareTansuImport in the service worker)
- **Problem:** Repeated link-opening text rescans to the end for each occurrence. In node, a line of '![a](' repeated 20,000 times took 2.7 s and 40,000 times took 10.9 s. The input is page Markdown sent to Tansu and runs in the extension service worker; the packaged extension was not exercised.
- **Recommendation:** Make the scan linear (record failed openers, cap per-line work) and add a worst-case timing test next to loupe-image-scanner.test.ts.
- **Fix with:** make-it-fast
- **Effort:** S

### TNS-123 · P3 · Reconcile reads oversized notes whole to hash them

- **Area:** vault reconcile
- **Where:** src/vault.rs (reconcile walk)
- **Problem:** Oversized notes no longer disable search, but the reconcile walk still reads each file whole to hash it, so a 1.3 GB note spikes RSS by about the file size.
- **Recommendation:** Hash in bounded chunks (streaming) or skip content hashing above the indexing limit, with a regression test that bounds peak RSS or read size for an oversized note.
- **Fix with:** make-it-fast
- **Effort:** S

### TNS-124 · P3 · Show unindexed oversize notes in the web UI

- **Area:** search status
- **Where:** src/search.rs skipped_oversize(), web/ts/app
- **Problem:** Notes over MAX_INDEXED_NOTE_BYTES are skipped silently in the UI; only the vault-open log reports unindexedOversizeNotes, so a user cannot tell why a note is missing from search.
- **Recommendation:** Expose the skipped count or ids through the search status API and show it in the search UI, with a test.
- **Fix with:** none
- **Effort:** S

### TNS-125 · P3 · vitest.e2e.config.ts sets minWorkers, which Vitest InlineConfig does not declare

- **Area:** tooling · browser tests
- **Where:** vitest.e2e.config.ts:13
- **Problem:** Typechecking the root Vitest configs under the repo tsconfig fails because vitest.e2e.config.ts:13 sets minWorkers, which the installed Vitest InlineConfig does not have. If Vitest ignores the key, the browser suite runs with a worker floor other than the one this config intends.
- **Recommendation:** Check the installed Vitest release for the replacement setting, apply the intended worker limit through it, and include the root configs in a typecheck so a removed option fails CI.
- **Fix with:** none
- **Effort:** S

### TNS-126 · P3 · Review unquoted SSH option expansion in deploy-state.sh

- **Area:** tooling · deployment
- **Where:** deploy/deploy-state.sh:91
- **Problem:** shellcheck reports SC2086 at deploy/deploy-state.sh:91, where SSH options expand unquoted. If the word splitting is intentional it is undocumented; otherwise an option value containing whitespace or glob characters changes the ssh command line.
- **Recommendation:** Build the SSH options as an array (or prove the splitting is required), then make shellcheck clean for deploy/ apart from reasoned directives.
- **Fix with:** none
- **Effort:** S

### TNS-127 · P3 · A continuing login flood evicts an owner’s pending ceremony

- **Area:** HTTP and auth · login availability
- **Where:** src/auth.rs begin_authentication and src/http.rs POST /api/v2/auth/login/options
- **Problem:** At 005101c08935c6243b8909863ef04617f4d87ffc, begin_authentication evicts the oldest authentication ceremony when 256 are pending. An unauthenticated caller can issue 256 login/options requests after the owner starts login and before the owner finishes, evicting the owner’s ceremony; login/finish then rejects it as CeremonyUsed. Reproduce with cargo test -p tansu anonymous_login_flood_cannot_lock_the_owner_out: the test creates an oldest ticket, creates 511 more, and asserts finishing the oldest returns CeremonyUsed. It checks the owner ticket only after the flood stops. Eviction is the deliberate trade-off documented at src/auth.rs:503–505: refusing new ceremonies lets a caller fill the table and lock the owner out. Under either policy a continuous anonymous flood can deny owner login; per-client rate limiting of login/options addresses the flood, not a different eviction order.
- **Recommendation:** Add per-client rate limiting to login/options and test an owner login amid a continuing anonymous flood.
- **Fix with:** security
- **Effort:** M

### TNS-128 · P3 · Cover CLI runtime error exit paths

- **Area:** CLI testing
- **Where:** tests/cli_help.rs; src/main.rs
- **Problem:** The subprocess tests cover help and an unknown command, but do not check exit status and diagnostics for runtime failures such as configuration and auth errors.
- **Recommendation:** Add focused subprocess tests for representative runtime failure paths and their exit status and diagnostics.
- **Fix with:** none
- **Effort:** S

### TNS-129 · P3 · Test Loupe options page persistence

- **Area:** Loupe settings
- **Where:** extension-loupe/src/options.ts; extension-loupe/test/tansu-extension-calls.test.ts
- **Problem:** Settings storage and validation have tests, but the actual options page save, reload and error handling are not isolated by a test.
- **Recommendation:** Exercise the options page with storage, including persistence and a failed save.
- **Fix with:** none
- **Effort:** S

### TNS-130 · P3 · Assess critical test coverage and mutation sensitivity

- **Area:** testing
- **Where:** docs/testing.md; src/; crates/; web/ts/; extension-loupe/
- **Problem:** Branch coverage and automated mutation sensitivity for critical Rust and TypeScript behavior remain unmeasured; single manual fault injections do not establish coverage or identify surviving mutations.
- **Recommendation:** Run bounded coverage and mutation analysis for critical invariants, investigate survivors, and add behavior tests where a concrete gap is found.
- **Fix with:** test-audit
- **Effort:** L

### TNS-131 · P3 · Compare benchmark changes against a baseline

- **Area:** performance measurement
- **Where:** bench/integrated-bench.mjs; docs/performance.md
- **Problem:** The benchmark checks fixed budgets but does not interleave baseline and candidate runs or select a focused change workload, so regressions below the thresholds can go unnoticed.
- **Recommendation:** Support representative interleaved baseline comparisons and a focused workload selection.
- **Fix with:** refactor-benchmarks
- **Effort:** M

### TNS-132 · P4 · Improve benchmark resource attribution and run context

- **Area:** performance measurement
- **Where:** bench/integrated-bench.mjs; docs/performance.md
- **Problem:** The benchmark reports server process-tree RSS but does not attribute CPU, allocations or I/O, measure browser process memory, or fully report prerequisites and input identity.
- **Recommendation:** Identify the resource attribution and run context needed for comparisons, then report them or document a separate profiling procedure.
- **Fix with:** refactor-benchmarks
- **Effort:** M

### TNS-133 · P4 · Review unused exports and dependencies across the workspace

- **Area:** maintenance
- **Where:** src/; crates/; web/ts/; extension-loupe/; scripts/; bench/; deploy/
- **Problem:** Existing unused-local checks and bounded caller searches do not establish whether exported code and dependencies are used; workspace dependency analysis and external callers remain unverified.
- **Recommendation:** Inspect candidate exports and dependencies with their real callers, preserving public contracts unless removal is authorized.
- **Fix with:** dead-code-archaeology
- **Effort:** L

