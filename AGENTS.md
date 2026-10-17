# Tansu2

Tansu2 is a local Markdown note app.
Commands: frontend build `deno task build`, fixture app `make dev`, check `make check`, unit tests `make test`, browser e2e `make test-e2e-chromium` and `make test-e2e-webkit`.

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

## Topics

- Architecture and API: [architecture](docs/architecture.md), [API](docs/api.md)
- Vault configuration and migration: [configuration](docs/configuration.md), [migration](docs/migration.md)
- Development and fixtures: [development](docs/development.md), [fixtures](docs/fixtures.md)
- Browser support and performance: [browser support](docs/browser-support.md), [performance](docs/performance.md)
- Editor behavior: [editor](docs/editor.md)
- Browser extension import: [extension import](docs/extension-import.md)
- Security and deployment: [security](docs/security.md), [deployment](docs/deployment.md)
- Security design proposals: [WebAuthn counter policy](docs/rfcs/0001-webauthn-counter-policy.md), [RP ID validation](docs/rfcs/0002-webauthn-rp-id-validation.md)
- Logging and backlog: [logging](docs/logging.md), [logging backlog](docs/logging-backlog.md)
- Deferred features: [product backlog](docs/product-backlog.md)
