# Tansu

A self-hosted Notion-style note-taking app. Rust backend (single-threaded HTTP server, no frameworks), TypeScript frontend (no frameworks, bundled with Bun).

## Architecture

- `src/main.rs` — HTTP server, routing, API endpoints, session management, encryption lifecycle
- `src/crypto.rs` — AES-256-GCM encryption, key wrapping, recovery keys, vault I/O
- `src/index.rs` — Tantivy full-text search index
- `src/http.rs` — HTTP helpers (parsing, responses, file serving)
- `src/revisions.rs` — Note revision history (copy-on-write snapshots)
- `src/scanner.rs` — Markdown scanner (wiki-links, tags, headings)
- `src/settings.rs` — User settings persistence
- `web/ts/main.ts` — Frontend entry point, app initialization, SSE, keyboard shortcuts
- `web/ts/editor.ts` — ContentEditable editor, source mode, conflict resolution
- `web/ts/webauthn.ts` — WebAuthn PRF extension for biometric unlock
- `SECURITY.md` — Encryption design doc and implementation progress

## Build & Test

```sh
cargo build                    # build server (never use --release)
cargo test                     # run all Rust tests (98 tests)
bun test                       # run all TypeScript tests (19 test files)
bun build web/ts/main.ts --outfile web/static/app.js --bundle --format esm  # bundle frontend
bunx tsc --noEmit              # typecheck without emitting
make dev                       # run dev server (cargo run + bun build)
```

## Conventions

- No frameworks or unnecessary dependencies on either side
- Encryption is opt-in: `tansu encrypt <dir>` to enable, `tansu decrypt <dir>` to revert
- Plaintext mode (no crypto.json) = current behavior, no auth, no sessions
- Tests live alongside source: `foo.rs` has `#[cfg(test)] mod tests`, `foo.ts` has `foo.test.ts`
- Pre-commit hooks are not used; user verifies commits independently
- Never push to remote
