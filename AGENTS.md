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
- TypeScript 7 owns type checking. Oxlint with `oxlint-tsgolint` owns linting. Vitest owns tests. Vite builds the web app.
- Do not reintroduce Deno, React, SolidStart, Vite+, Jest, ESLint, the npm CLI, Yarn, Bun, or another lockfile.

## Topics

- Architecture and API: [architecture](docs/architecture.md), [API](docs/api.md)
- Vault configuration and migration: [configuration](docs/configuration.md), [migration](docs/migration.md)
- Development and testing: [development](docs/development.md), [testing](docs/testing.md), [fixtures](docs/fixtures.md)
- Browser support and performance: [browser support](docs/browser-support.md), [performance](docs/performance.md)
- Editor behavior: [editor](docs/editor.md)
- Browser extension import: [extension import](docs/extension-import.md)
- Loupe browser extension: [Loupe](docs/loupe.md)
- Security and deployment: [security](docs/security.md), [deployment](docs/deployment.md)
- Logging and backlog: [logging](docs/logging.md), [logging backlog](docs/logging-backlog.md)
- Deferred features: [product backlog](docs/product-backlog.md)
- Pending materialization: [TNS-085](docs/rfc/TNS-085-pending-materialization.md)
