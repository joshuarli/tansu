# Tansu

Tansu is a local Markdown note app.
Commands: frontend build `pnpm run build`, fixture app `make dev`, check `pnpm run check`, unit tests `pnpm run test`, browser e2e `make test-e2e-chromium` and `make test-e2e-webkit`.

## Invariants

- `noteId` is durable identity. `path` is mutable metadata.
- Every accepted content-changing write has a full recoverable snapshot. Stale saves preserve canonical content and create conflict drafts.
- Search is derived state. Indexing failures cannot reject accepted writes.
- Watcher events trigger reconciliation. Search, SSE, and watcher freshness never roll back accepted writes.
- V1 frontmatter support is tags-only. Markdown files contain no hidden Tansu IDs.
- `z-images/` assets are vault-local opaque files in V1.
- Per-vault mutations stay serialized unless a tested design change says otherwise.
- Markdown editor behavior stays inside `web/ts/editor/`. Update `docs/editor.md` when editor invariants or extension behavior change.
- Broad dependencies require documentation updates.

## Tooling

- Node runs project scripts. pnpm owns JavaScript packages and tasks. `package.json` and `pnpm-lock.yaml` are the only JavaScript manifest and lockfile.
- `tsrs` owns type checking. Oxlint's `tsrs-lint` backend owns type-aware linting. Vitest owns tests. Vite builds the web app.
- Do not reintroduce Deno, React, SolidStart, Vite+, Jest, ESLint, the npm CLI, Yarn, Bun, or another lockfile.

## Topics

- Architecture and API: [architecture](docs/architecture.md), [API](docs/api.md)
- Vault configuration and migration: [configuration](docs/configuration.md), [migration](docs/migration.md)
- Development and testing: [development](docs/development.md), [testing](docs/testing.md), [fixtures](docs/fixtures.md)
- Browser support and performance: [browser support](docs/browser-support.md), [performance](docs/performance.md)
- Editor behavior: [editor](docs/editor.md)
- Browser extension import: [extension import](docs/extension-import.md)
- Loupe browser extension: [Loupe](docs/loupe.md)
- Security and deployment: [security](docs/security.md), [deployment](docs/deployment.md), [deslop diagnose](docs/deslop-diagnose.md)
- Logging and backlog: [logging](docs/logging.md), [logging backlog](docs/logging-backlog.md)
- Deferred features: [product backlog](docs/product-backlog.md)

## Verification

- `make test`: TypeScript unit and Rust workspace tests; cold 701.79s, warm 71.71s (busy host).
- `make lint`: generated types, TypeScript lint, and Rust clippy for x86_64 Linux musl; cold 718.42s (busy host).
- `make test-e2e-chromium` / `make test-e2e-webkit`: browser integration; use one worker.
- CLI flags, help and error exit: `tests/cli_help.rs`; other CLI exit paths: none.
- HTTP API and JSON wire formats: `src/api.rs` route tests; authentication and origin: `src/http.rs` tests.
- Markdown, note identity, snapshots and conflicts: `src/vault.rs` tests; file and asset paths: `src/paths.rs` tests.
- Search query and indexing: `crates/tansu-search/src/search.rs` tests; index failure isolation: `src/vault.rs` tests.
- Editor behavior: `web/ts/editor/tests/`; extension import and messaging: `extension-loupe/test/` and `make test-e2e-loupe`.
- Configuration and history formats: `src/config.rs` and `src/history.rs` tests; complete format compatibility: none.
- Performance: `make bench` runs the integrated Chromium workload with warmups and five runs.
- Components: application and integration tests (`src/`, `tests/`); shared crates (`crates/`); editor (`web/ts/editor/` excluding vendor); web application (`web/ts/app/`, `app.ts` and its test); other web UI and e2e; Loupe; scripts, bench, deployment, containers and build configuration.
- Vendored: Atomic Editor, https://github.com/kenforthewin/atomic-editor at `b6ed65f01bde4510031bc7a495520bc1a7688c66`; jSquash WebP, https://github.com/jamsinclair/jSquash, reference 1.5.0 (original import revision unknown); Tantivy, https://github.com/quickwit-oss/tantivy, 0.27.0. See each `UPSTREAM.md`.
