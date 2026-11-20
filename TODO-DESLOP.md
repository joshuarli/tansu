Prefix: DSLP
Next: 32

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

### DSLP-6 · P2 · Types: search and shared crates

- **Area:** deslop · types · search and shared crates
- **Where:** crates/
- **Problem:** Strict profile and typing findings have not been assessed for this component. Contracts: search indexing and queries, note formats, API types and WebAuthn. Consumers: application and web API clients.
- **Recommendation:** Run the deslop Types step for this bounded component. Accept: clean at the adopted profile, escape hatches not increased, and witnesses recorded; run make test.
- **Fix with:** deslop
- **Effort:** M

### DSLP-7 · P2 · Types: web editor

- **Area:** deslop · types · web editor
- **Where:** web/ts/editor/ excluding vendor
- **Problem:** Strict profile and typing findings have not been assessed for this component. Contracts: Markdown editing, assets and document transactions. Consumers: web application and stored Markdown.
- **Recommendation:** Run the deslop Types step for this bounded component. Accept: clean at the adopted profile, escape hatches not increased, and witnesses recorded; run make test.
- **Fix with:** deslop
- **Effort:** M

### DSLP-8 · P2 · Types: web application

- **Area:** deslop · types · web application
- **Where:** web/ts/app.ts, web/ts/app.test.ts, web/ts/app/
- **Problem:** Strict profile and typing findings have not been assessed for this component. Contracts: API requests, workspace and document sessions. Consumers: HTTP API, editor and browser users.
- **Recommendation:** Run the deslop Types step for this bounded component. Accept: clean at the adopted profile, escape hatches not increased, and witnesses recorded; run make test.
- **Fix with:** deslop
- **Effort:** M

### DSLP-9 · P2 · Types: web UI and browser tests

- **Area:** deslop · types · web UI and browser tests
- **Where:** web/ except app and editor, including web/ts/e2e/
- **Problem:** Strict profile and typing findings have not been assessed for this component. Contracts: rendering, routing, browser interactions and API integration. Consumers: browser users and HTTP API.
- **Recommendation:** Run the deslop Types step for this bounded component. Accept: clean at the adopted profile, escape hatches not increased, and witnesses recorded; run make test.
- **Fix with:** deslop
- **Effort:** M

### DSLP-10 · P2 · Types: Loupe extension

- **Area:** deslop · types · Loupe extension
- **Where:** extension-loupe/
- **Problem:** Strict profile and typing findings have not been assessed for this component. Contracts: extension messaging, imports and persisted settings. Consumers: browser tabs and Tansu HTTP API.
- **Recommendation:** Run the deslop Types step for this bounded component. Accept: clean at the adopted profile, escape hatches not increased, and witnesses recorded; run make test.
- **Fix with:** deslop
- **Effort:** M

### DSLP-11 · P2 · Types: tooling and benchmarks

- **Area:** deslop · types · tooling and benchmarks
- **Where:** scripts/, bench/, deploy/, docker/, root build configuration and .github/
- **Problem:** Build, deployment, fixtures and benchmark tooling have not been assessed. Contracts: build artifacts, deployment and benchmark commands, CI entrypoints. Consumers: developers, deployed services, browser tests and CI.
- **Recommendation:** Run the deslop Types step for this bounded component. Accept: clean at the adopted profile, escape hatches not increased, and witnesses recorded; run make test.
- **Fix with:** deslop
- **Effort:** M

### DSLP-12 · P2 · Tests: search and shared crates

- **Area:** deslop · tests · search and shared crates
- **Where:** crates/
- **Problem:** Coverage, boundary gaps and mutation have not been assessed for this component. Contracts: search indexing and queries, note formats, API types and WebAuthn. Consumers: application and web API clients.
- **Recommendation:** Run the deslop Tests step for this bounded component. Accept: critical survivors dispositioned, test cost budget holds, and any qualified lane is green; run make test.
- **Fix with:** deslop
- **Effort:** M

### DSLP-13 · P2 · Tests: web editor

- **Area:** deslop · tests · web editor
- **Where:** web/ts/editor/ excluding vendor
- **Problem:** Coverage, boundary gaps and mutation have not been assessed for this component. Contracts: Markdown editing, assets and document transactions. Consumers: web application and stored Markdown.
- **Recommendation:** Run the deslop Tests step for this bounded component. Accept: critical survivors dispositioned, test cost budget holds, and any qualified lane is green; run make test.
- **Fix with:** deslop
- **Effort:** M

### DSLP-14 · P2 · Tests: web application

- **Area:** deslop · tests · web application
- **Where:** web/ts/app.ts, web/ts/app.test.ts, web/ts/app/
- **Problem:** Coverage, boundary gaps and mutation have not been assessed for this component. Contracts: API requests, workspace and document sessions. Consumers: HTTP API, editor and browser users.
- **Recommendation:** Run the deslop Tests step for this bounded component. Accept: critical survivors dispositioned, test cost budget holds, and any qualified lane is green; run make test.
- **Fix with:** deslop
- **Effort:** M

### DSLP-15 · P2 · Tests: web UI and browser tests

- **Area:** deslop · tests · web UI and browser tests
- **Where:** web/ except app and editor, including web/ts/e2e/
- **Problem:** Coverage, boundary gaps and mutation have not been assessed for this component. Contracts: rendering, routing, browser interactions and API integration. Consumers: browser users and HTTP API.
- **Recommendation:** Run the deslop Tests step for this bounded component. Accept: critical survivors dispositioned, test cost budget holds, and any qualified lane is green; run make test.
- **Fix with:** deslop
- **Effort:** M

### DSLP-16 · P2 · Tests: Loupe extension

- **Area:** deslop · tests · Loupe extension
- **Where:** extension-loupe/
- **Problem:** Coverage, boundary gaps and mutation have not been assessed for this component. Contracts: extension messaging, imports and persisted settings. Consumers: browser tabs and Tansu HTTP API.
- **Recommendation:** Run the deslop Tests step for this bounded component. Accept: critical survivors dispositioned, test cost budget holds, and any qualified lane is green; run make test.
- **Fix with:** deslop
- **Effort:** M

### DSLP-17 · P2 · Tests: tooling and benchmarks

- **Area:** deslop · tests · tooling and benchmarks
- **Where:** scripts/, bench/, deploy/, docker/, root build configuration and .github/
- **Problem:** Build, deployment, fixtures and benchmark tooling have not been assessed. Contracts: build artifacts, deployment and benchmark commands, CI entrypoints. Consumers: developers, deployed services, browser tests and CI.
- **Recommendation:** Run the deslop Tests step for this bounded component. Accept: critical survivors dispositioned, test cost budget holds, and any qualified lane is green; run make test.
- **Fix with:** deslop
- **Effort:** M

### DSLP-18 · P2 · Dead code: search and shared crates

- **Area:** deslop · dead code · search and shared crates
- **Where:** crates/
- **Problem:** Tools and debloat have not been assessed for this component. Contracts: search indexing and queries, note formats, API types and WebAuthn. Consumers: application and web API clients.
- **Recommendation:** Run the deslop Dead code step for this bounded component. Accept: tools clean or at most five reasoned allowlist entries, and walk-backs filed; run make test.
- **Fix with:** deslop
- **Effort:** M

### DSLP-19 · P2 · Dead code: web editor

- **Area:** deslop · dead code · web editor
- **Where:** web/ts/editor/ excluding vendor
- **Problem:** Tools and debloat have not been assessed for this component. Contracts: Markdown editing, assets and document transactions. Consumers: web application and stored Markdown.
- **Recommendation:** Run the deslop Dead code step for this bounded component. Accept: tools clean or at most five reasoned allowlist entries, and walk-backs filed; run make test.
- **Fix with:** deslop
- **Effort:** M

### DSLP-20 · P2 · Dead code: web application

- **Area:** deslop · dead code · web application
- **Where:** web/ts/app.ts, web/ts/app.test.ts, web/ts/app/
- **Problem:** Tools and debloat have not been assessed for this component. Contracts: API requests, workspace and document sessions. Consumers: HTTP API, editor and browser users.
- **Recommendation:** Run the deslop Dead code step for this bounded component. Accept: tools clean or at most five reasoned allowlist entries, and walk-backs filed; run make test.
- **Fix with:** deslop
- **Effort:** M

### DSLP-21 · P2 · Dead code: web UI and browser tests

- **Area:** deslop · dead code · web UI and browser tests
- **Where:** web/ except app and editor, including web/ts/e2e/
- **Problem:** Tools and debloat have not been assessed for this component. Contracts: rendering, routing, browser interactions and API integration. Consumers: browser users and HTTP API.
- **Recommendation:** Run the deslop Dead code step for this bounded component. Accept: tools clean or at most five reasoned allowlist entries, and walk-backs filed; run make test.
- **Fix with:** deslop
- **Effort:** M

### DSLP-22 · P2 · Dead code: Loupe extension

- **Area:** deslop · dead code · Loupe extension
- **Where:** extension-loupe/
- **Problem:** Tools and debloat have not been assessed for this component. Contracts: extension messaging, imports and persisted settings. Consumers: browser tabs and Tansu HTTP API.
- **Recommendation:** Run the deslop Dead code step for this bounded component. Accept: tools clean or at most five reasoned allowlist entries, and walk-backs filed; run make test.
- **Fix with:** deslop
- **Effort:** M

### DSLP-23 · P2 · Dead code: tooling and benchmarks

- **Area:** deslop · dead code · tooling and benchmarks
- **Where:** scripts/, bench/, deploy/, docker/, root build configuration and .github/
- **Problem:** Build, deployment, fixtures and benchmark tooling have not been assessed. Contracts: build artifacts, deployment and benchmark commands, CI entrypoints. Consumers: developers, deployed services, browser tests and CI.
- **Recommendation:** Run the deslop Dead code step for this bounded component. Accept: tools clean or at most five reasoned allowlist entries, and walk-backs filed; run make test.
- **Fix with:** deslop
- **Effort:** M

### DSLP-25 · P2 · One oversize note disables search for the whole vault

- **Area:** search and indexing · resource bounds
- **Where:** src/reconcile.rs walk_dir, crates/tansu-search/src/service.rs check_rebuild_bounds
- **Problem:** Reconcile reads every Markdown file whole with no per-file cap, and a search rebuild is refused when the vault's total source exceeds MAX_REBUILD_SOURCE_BYTES (128 MiB) or MAX_REBUILD_NOTES (10,000; same check, not separately reproduced). Reproduced on target/debug/tansu at 8a20a7b: a 3,000-note vault searched normally; adding one 300 MB .md file raised server RSS to 1.3 GB and 52 CPU-seconds, made each search for a term in that file take about 30 s, left searchStatus {dirty:true, degraded:true} across restart, and after the search directory was removed every query ('needle', 'Alpha', 'Note 5') returned 200 with zero hits. Deleting the file and restarting restored search. The API refuses bodies over 32 MiB, so such a note can be listed and opened but never saved. Evidence: docs/deslop-diagnose.md F1.
- **Recommendation:** Bound file size where files enter the vault (skip with an unresolved or too-large reason, as invalid UTF-8 already is) and make rebuild truncate or skip oversize documents instead of failing the whole index; surface degraded search in the UI.
- **Fix with:** os-boundaries
- **Effort:** M

### DSLP-26 · P2 · Unauthenticated login options exhaust the ceremony cap and lock the owner out

- **Area:** HTTP endpoints and auth
- **Where:** src/auth.rs begin_authentication (MAX_PENDING_CEREMONIES 256), src/http.rs login/options route
- **Problem:** POST /api/v2/auth/login/options needs no session, and each call stores a pending ceremony for 300 s; the table holds at most 256 across all callers. Reproduced on target/debug/tansu at 8a20a7b with auth configured (origin https://notes.test, one credential row seeded in auth.db because a real passkey needs an authenticator): 300 unauthenticated requests gave 255 x 200 then 45 x 429, and the next owner login/options call returned 429 rate_limited with retryAfterMs 1000 although the lockout lasts up to 300 s. An attacker repeats 256 requests per 5 minutes with no credentials. Evidence: docs/deslop-diagnose.md F2.
- **Recommendation:** Reserve ceremony capacity for the owner (per-client or per-kind quota, evict oldest unfinished login ceremony instead of refusing, or bind the cap to the source), and report a retry delay that matches the real expiry.
- **Fix with:** security
- **Effort:** M

### DSLP-27 · P2 · Extension import image rewrite is quadratic on hostile Markdown and freezes the Tansu tab

- **Area:** extension messaging · web application
- **Where:** web/ts/app/extension-import.ts IMAGE_EMBED_PATTERN and rewriteImageTokens
- **Problem:** The embed pattern /!\[((?:\\.|(?!\]\()[^\\\n])*)\]\(tansu-import-image:(\d+)\)/g rescans to the end of the line from every '![', so a long line of '![' costs O(n squared). The payload is page content imported by Loupe (a code block in a web page keeps it verbatim) and the receiver caps Markdown at only 5 MB. Reproduced in Chromium (Playwright) against the built app served by target/debug/tansu at 8a20a7b by posting import.request over window.postMessage: 40 KB took 0.8 s, 80 KB 3.0 s, 160 KB 12.7 s to answer import.result, the page main thread blocked throughout; extrapolated cost at the 5 MB cap is hours. The same function in node gave 0.9/3.6/14.5 s for 40/80/160 KB. Evidence: docs/deslop-diagnose.md F3.
- **Recommendation:** Replace the backtracking alt capture with a linear scan (or bound the alt length and the work per match), cap work by input size, and add a timing-bounded test with a worst-case line.
- **Fix with:** security
- **Effort:** S

### DSLP-24 · P3 · Pinned pnpm is missing from the configured registry

- **Area:** Needs environment · package registry
- **Where:** .npmrc, package.json
- **Problem:** The configured npm.17166969.xyz/current registry returned no matching pnpm or @pnpm/exe 12.21.0 when make test and make lint started on 2026-11-20. Both passed with a process-local registry override to registry.npmjs.org.
- **Recommendation:** Restore the pinned pnpm release to the configured mirror and verify the commands without an override.
- **Fix with:** none
- **Effort:** S

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
