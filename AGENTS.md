# Tansu2

Tansu2 is a local Markdown note app.
Commands: frontend build `deno task build`, fixture app `make dev`, check `make check`, unit tests `make test`, Chromium e2e `make test-e2e-chromium`.

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
- Release builds are permitted only for items O1-O4, H4 and Z3; do not run pre-commit hooks or push.

## Topics

- Architecture and API: [architecture](docs/architecture.md), [API](docs/api.md)
- Vault configuration and migration: [configuration](docs/configuration.md), [migration](docs/migration.md)
- Development and fixtures: [development](docs/development.md), [fixtures](docs/fixtures.md)
- Browser support and performance: [browser support](docs/browser-support.md), [performance](docs/performance.md)
- Editor behavior: [editor](docs/editor.md)
- Security and deployment: [security](docs/security.md), [deployment](docs/deployment.md)
- Logging and backlog: [logging](docs/logging.md), [logging backlog](docs/logging-backlog.md)
- Deferred features: [product backlog](docs/product-backlog.md)
