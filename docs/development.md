# Development

## Set up

Install the Rust toolchain in `rust-toolchain.toml`, Deno 2, Node 26 or later,
and pnpm 12.13.0.

```sh
pnpm install
deno task playwright:install
```

The supported Rust targets are `aarch64-apple-darwin`,
`x86_64-unknown-linux-musl`, and `aarch64-unknown-linux-musl`.

## Run and validate

```sh
make dev
make check
make test
make test-e2e-chromium
```

`make dev` serves the app on port `3000` with the shared fixture vaults and
isolated `.dev/` config and data. It does not use your real vault configuration.
See [Fixtures](fixtures.md) for fixture setup and [Logging](logging.md) for the
dev and e2e log stream.

`make check` verifies generated types, TypeScript types, and Rust compilation.
`make test` runs the TypeScript and Rust unit suites. The e2e targets are
`make test-e2e-chromium`, `make test-e2e-firefox`, and
`make test-e2e-webkit`.

## Authenticated-mode administration

Authenticated mode is configured through `[auth]` in the config file described
in [Configuration](configuration.md). `make dev` keeps its loopback behavior
when that section is absent. With authenticated mode configured, run
`tansu2 auth enroll` before starting the server to print the expiring,
single-use first-registration capability. Stop the server before local auth
commands; an exclusive OS file lock also rejects commands while the server is
running.

Create and restore passkey backups with:

```sh
tansu2 auth backup /path/to/auth-backup.db
tansu2 auth restore /path/to/auth-backup.db
```

Backup creates a consistent SQLite file and refuses to overwrite its path.
Restore validates the file, restores credentials, and clears sessions,
enrollment capabilities, and pending ceremonies. These commands do not back up
vault notes or history; see [Security](security.md) for path and recovery
details.
See [Deployment](deployment.md) for Tailscale Serve setup, full backup scope,
passkey recovery limits, and rollback guidance.

## Build

`deno task build` creates fingerprinted frontend bundles and a manifest under
`web/dist/`. Run it before Rust commands that compile the server, including
`make check` and `make test`. Cargo embeds the files listed by that manifest
and does not run Node or Deno.

Build the Linux server for musl with Docker:

```sh
make build-linux-musl-docker
TARGET=aarch64-unknown-linux-musl make build-linux-musl-docker
```

The Docker build links a static SQLite archive built by
`scripts/build-sqlite-static.sh`.

## Generated files

```sh
make types
make types-check
```

`src/api_types.rs` generates `web/ts/types.generated.ts`. Do not edit that file.
The dev setup also generates `.dev/` and `web/dist/`. The type generator writes
ignored bindings under `bindings/`.
