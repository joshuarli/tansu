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

## Build

`deno task build` creates the production frontend bundle at
`web/static/app.js`. Build the Linux server for musl with Docker:

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
The dev setup also generates `.dev/` and `web/static/app.js`. The type generator
writes ignored bindings under `bindings/`.
