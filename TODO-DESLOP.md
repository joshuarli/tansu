Prefix: DSLP
Next: 25

Deslop campaign backlog ([plan](https://github.com/laputa-systems/stuff/blob/main/docs/campaigns/deslop.md), tier D). One agent works this file with the `deslop` skill: take the lowest-numbered open ticket whose area does not start with `Needs owner ·`. After DSLP-5, work the open P1 and P2 findings, then fill in `## Report` below.

## Report

Not started.

## Tickets

### DSLP-2 · P2 · Diagnose: ultrareview into this backlog

- **Area:** deslop · diagnose
- **Where:** whole repository
- **Problem:** No review has ranked this repository's risks for the deslop pass.
- **Recommendation:** Run the deslop Diagnose step. Accept: the diff touches only docs, comments, and this file, and every finding names its Fix with.
- **Fix with:** deslop
- **Effort:** M

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

### DSLP-24 · P3 · Pinned pnpm is missing from the configured registry

- **Area:** Needs environment · package registry
- **Where:** .npmrc, package.json
- **Problem:** The configured npm.17166969.xyz/current registry returned no matching pnpm or @pnpm/exe 12.21.0 when make test and make lint started on 2026-11-20. Both passed with a process-local registry override to registry.npmjs.org.
- **Recommendation:** Restore the pinned pnpm release to the configured mirror and verify the commands without an override.
- **Fix with:** none
- **Effort:** S

