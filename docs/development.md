# Development

## Set up

Install the Rust toolchain in `rust-toolchain.toml`, Deno 2, Node 26 or later,
and npm. Install the locked frontend dependencies and Playwright Chromium and
WebKit for browser tests:

```sh
make setup
deno task playwright:install
```

`make setup` runs pnpm 12.13.0 through npm and installs the frozen lockfile.
Run it before `deno task build` or other direct Deno tasks that use
`node_modules`. `make test`, `make dev`, and `make dev-config` run this setup
automatically.

The supported Rust targets are `aarch64-apple-darwin`,
`x86_64-unknown-linux-musl`, and `aarch64-unknown-linux-musl`.

## Run locally

```sh
make dev
```

The fixture app serves port `3000` with one demo note and its WebP images. It
uses isolated settings, data, and a copied vault under `.dev/`. See
[Fixtures](fixtures.md) for fixture setup and [Logging](logging.md) for the dev
and e2e log stream.

`make dev` watches the frontend source and rebuilds it after changes. CSS changes
apply without reloading the page. TypeScript changes reload the page.

For server settings, see [Configuration](configuration.md). For passkey
administration, remote access, and backup procedures, see
[Deployment](deployment.md).

## Build

`deno task build` creates fingerprinted frontend assets and a manifest under
`web/dist/`. Cargo embeds those assets; run the frontend build before invoking
Cargo directly. `make types` generates `web/ts/types.generated.ts` from
`src/api_types.rs`; do not edit the generated file. The dev setup also
generates ignored bindings under `bindings/`.

Build Linux musl binaries with Docker:

```sh
make build-linux-musl-docker
TARGET=aarch64-unknown-linux-musl make build-linux-musl-docker
```

The Docker build links the static SQLite archive built by
`scripts/build-sqlite-static.sh`.

## Loupe

`make loupe` builds the production extension in `dist/extension-loupe`. On
macOS, it opens Helium's extension page when Helium is installed. Choose
**Load unpacked** and select that folder. See [Loupe](loupe.md) for extension
behavior and permissions.

The build reads `../defuddle-rs` by default; set `DEFUDDLE_RS_DIR` to use
another checkout. It installs the matching `wasm-bindgen` CLI and
`wasm32-unknown-unknown` target when needed. It also requires Binaryen's
`wasm-opt`; on macOS the build installs Binaryen with Homebrew if missing. Set
`WASM_BINDGEN` or `WASM_OPT` to select executable paths. The build uses
`.work/target-defuddle-wasm` unless `CARGO_TARGET_DIR` is set and writes
generated bindings under `extension-loupe/.generated/`.
