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
make test-e2e-webkit
```

`make dev` serves the app on port `3000` with one demo note and its WebP images.
It generates isolated config, data, and a copied vault under `.dev/`; it does
not use your real vault configuration. See [Fixtures](fixtures.md) for fixture
setup and [Logging](logging.md) for the dev and e2e log stream.

`make check` verifies generated types, TypeScript types, and Rust compilation.
`make test` runs the TypeScript and Rust unit suites. The two e2e commands cover
Chrome's and Safari's browser engines.

See [Configuration](configuration.md) for server settings and
[Deployment](deployment.md) for passkey administration, remote access, and
backup and recovery procedures.

## Build

`deno task build` creates fingerprinted frontend bundles and a manifest under
`web/dist/`. That directory is generated and ignored. Cargo runs `build.rs`
whenever it compiles the root package, and that script reads the manifest.
`make check`, `make test`, `make types`, and `make types-check` build production
assets first. `make dev` builds development assets before generating API types.
Run `deno task build` before invoking Cargo directly. Cargo embeds the listed
assets and does not run Node or Deno.

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
