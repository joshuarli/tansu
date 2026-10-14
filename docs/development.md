# Development

## Setup

Requirements:

- Rust from `rust-toolchain.toml`
- Deno 2.x
- Node 26 or later for Node-based tooling
- `pnpm` from `package.json`

Supported Rust targets:

- `aarch64-apple-darwin`
- `x86_64-unknown-linux-musl`
- `aarch64-unknown-linux-musl`

Install dependencies:

```sh
pnpm install
deno task playwright:install
```

## Run

```sh
make dev
```

`make dev` regenerates isolated dev config/data under `.dev/`, points vaults at
the versioned fixture content, bundles the frontend, and runs the server on port
`3000` with `XDG_CONFIG_HOME=.dev/config` and `XDG_DATA_HOME=.dev/data`. It does
not read the user's real config or app data.

See [Logging](logging.md) for dev/e2e server, browser, and harness logs.

## Validate

Use these first:

```sh
make check
make test
make coverage
make test-e2e
```

Full focused list:

```sh
deno task lint
deno task typecheck
deno task test
deno task test:browser
cargo check -q
cargo test -q
```

`pnpm` installs packages. Use `deno task` to run project commands.

## Linux Musl Build

Linux server binaries are built for musl targets only. The Docker build compiles
the pinned SQLite amalgamation into a static archive first, then points
`libsqlite3-sys` at that archive instead of enabling Rusqlite's bundled SQLite
feature or linking a system SQLite library.

```sh
make build-linux-musl-docker
TARGET=aarch64-unknown-linux-musl make build-linux-musl-docker
```

The pinned SQLite inputs and compile flags are in
`scripts/build-sqlite-static.sh`. The current build uses SQLite `3.54.0` as a
static archive with no optional extension modules enabled. JSON, FTS, RTree,
DBSTAT, URI filename handling, loadable extensions, authorization hooks,
EXPLAIN, integrity checks, UTF-16 APIs, compile-option diagnostics, deprecated
APIs, tracing, progress callbacks, and deserialize APIs are omitted.

Coverage gates are enforced by `make coverage`: Rust uses `cargo llvm-cov`,
the app TypeScript suite uses Vitest/V8, and the editor package uses
Vitest/V8. App and editor TypeScript are gated at 90% lines and 85% functions.
Rust is currently gated at 87% lines and 80% functions after excluding only
binary entrypoint glue; the remaining gap is concentrated in long-running
server/app wiring and vault internals that need broader behavior tests before
raising the gate to 90%/85%.

Do not run release builds unless explicitly requested.

## Generated Types

```sh
make types
make types-check
```

`src/api_types.rs` generates `web/ts/types.generated.ts`. Do not edit the
generated file.

## Real Vault Config

The server reads `$XDG_CONFIG_HOME/tansu/config.toml`, then
`~/.config/tansu/config.toml`. Per-vault catalog, history, session, settings,
and search state are stored under `$XDG_DATA_HOME/tansu/<vault-name>`, or
`~/.local/share/tansu/<vault-name>` when `XDG_DATA_HOME` is unset.

```toml
[[vaults]]
name = "Personal"
path = "~/notes"
excluded_folders = ["archive/tmp"]

[[vaults]]
name = "Work"
path = "~/work-notes"
```

Nested vaults are rejected before startup.

## Generated Local Files

- `.dev/`: generated dev-only config/data
- `web/static/app.js`: generated frontend bundle
- `bindings/`: ignored `ts-rs` output

Do not commit generated local state.
