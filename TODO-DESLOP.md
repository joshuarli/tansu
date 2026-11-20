Prefix: DSLP
Next: 36

Deslop campaign backlog ([plan](https://github.com/laputa-systems/stuff/blob/main/docs/campaigns/deslop.md), tier D). One agent works this file with the `deslop` skill: take the lowest-numbered open ticket whose area does not start with `Needs owner ·`. After DSLP-5, work the open P1 and P2 findings, then fill in `## Report` below.

## Report

Not started.

## Tickets

### DSLP-3 · P2 · Types: application and integration tests

- **Area:** deslop · types · application and integration tests
- **Where:** src/, tests/
- **Problem:** Strict profile and typing findings have not been assessed for this component. Contracts: vault identity, snapshots, recovery, HTTP/auth, CLI and file paths. Consumers: web app, extension and local vaults.
- **Recommendation:** Run the deslop Types step for this bounded component. Accept: clean at the adopted profile, escape hatches not increased, and witnesses recorded; run make test.
- **Fix with:** deslop
- **Effort:** M

### DSLP-4 · P2 · Tests: application and integration tests

- **Area:** deslop · tests · application and integration tests
- **Where:** src/, tests/
- **Problem:** Coverage, boundary gaps and mutation have not been assessed for this component. Contracts: vault identity, snapshots, recovery, HTTP/auth, CLI and file paths. Consumers: web app, extension and local vaults.
- **Recommendation:** Run the deslop Tests step for this bounded component. Accept: critical survivors dispositioned, test cost budget holds, and any qualified lane is green; run make test.
- **Fix with:** deslop
- **Effort:** M

### DSLP-5 · P2 · Dead code: application and integration tests

- **Area:** deslop · dead code · application and integration tests
- **Where:** src/, tests/
- **Problem:** Tools and debloat have not been assessed for this component. Contracts: vault identity, snapshots, recovery, HTTP/auth, CLI and file paths. Consumers: web app, extension and local vaults.
- **Recommendation:** Run the deslop Dead code step for this bounded component. Accept: tools clean or at most five reasoned allowlist entries, and walk-backs filed; run make test.
- **Fix with:** deslop
- **Effort:** M

### DSLP-9 · P2 · Types: web UI and browser tests

- **Area:** deslop · types · web UI and browser tests
- **Where:** web/ except app and editor, including web/ts/e2e/
- **Problem:** Strict profile and typing findings have not been assessed for this component. Contracts: rendering, routing, browser interactions and API integration. Consumers: browser users and HTTP API.
- **Recommendation:** Run the deslop Types step for this bounded component. Accept: clean at the adopted profile, escape hatches not increased, and witnesses recorded; run make test.
- **Fix with:** deslop
- **Effort:** M

### DSLP-15 · P2 · Tests: web UI and browser tests

- **Area:** deslop · tests · web UI and browser tests
- **Where:** web/ except app and editor, including web/ts/e2e/
- **Problem:** Coverage, boundary gaps and mutation have not been assessed for this component. Contracts: rendering, routing, browser interactions and API integration. Consumers: browser users and HTTP API.
- **Recommendation:** Run the deslop Tests step for this bounded component. Accept: critical survivors dispositioned, test cost budget holds, and any qualified lane is green; run make test.
- **Fix with:** deslop
- **Effort:** M

### DSLP-21 · P2 · Dead code: web UI and browser tests

- **Area:** deslop · dead code · web UI and browser tests
- **Where:** web/ except app and editor, including web/ts/e2e/
- **Problem:** Tools and debloat have not been assessed for this component. Contracts: rendering, routing, browser interactions and API integration. Consumers: browser users and HTTP API.
- **Recommendation:** Run the deslop Dead code step for this bounded component. Accept: tools clean or at most five reasoned allowlist entries, and walk-backs filed; run make test.
- **Fix with:** deslop
- **Effort:** M

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

