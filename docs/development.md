# Development

## Set up

Install the Rust toolchain in `rust-toolchain.toml`, Node from `.node-version`,
and pnpm from `package.json`. Install the locked frontend dependencies and
Playwright Chromium and WebKit for browser tests under `.work/`:

```sh
pnpm install --frozen-lockfile
pnpm run playwright:install
```

`make setup` installs the frozen lockfile. `make test`, `make dev`, and
`make dev-config` run setup automatically. Run `pnpm install --frozen-lockfile`
before direct pnpm tasks.

`make check` runs `tsrs` for TypeScript type checking. On macOS, use an arm64
machine; `tsrs` does not provide an Intel macOS binary.

`pnpm run check` checks generated API types, lint, TypeScript, unit tests, and
Rust compilation. `make check` runs the same check after installing dependencies.

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

`pnpm run build` creates fingerprinted frontend assets and a manifest under
`web/dist/`. Cargo embeds those assets; run the frontend build before invoking
Cargo directly. `make types` generates `web/ts/types.generated.ts` from
`crates/tansu-api-types/src/lib.rs`; do not edit the generated file. The dev setup also
generates ignored bindings under `bindings/`.

Build Linux musl binaries with Docker:

```sh
make build-linux-musl-docker
TARGET=aarch64-unknown-linux-musl make build-linux-musl-docker
```

The Docker build links the static SQLite archive built by
`scripts/build-sqlite-static.sh`.

## Linux screenshot baselines

Generate and verify Linux Chromium and WebKit screenshot baselines with:

```sh
make update-e2e-baselines-linux
```

The target uses the Playwright `v1.64.0-noble` image and the Node version from
`.node-version` on `linux/amd64`. It writes four screenshots under each of
`web/ts/e2e/baselines/chromium-linux/` and
`web/ts/e2e/baselines/webkit-linux/`. The target sets
`TANSU_UPDATE_BASELINES=1` to write them, then reruns the test without the
variable. Review the generated PNG files before committing them.

The image runs Ubuntu with glibc, so the workspace lock includes glibc
variants of the existing Linux optional packages alongside the musl variants.

## Loupe

`make loupe` builds the production extension in `dist/extension-loupe`. On
macOS, it opens Helium's extension page when Helium is installed. Choose
**Load unpacked** and select that folder. See [Loupe](loupe.md) for extension
behavior and permissions.

The build reads `../defuddle-rs` by default; set `DEFUDDLE_RS_DIR` to use
another checkout. It installs the matching `wasm-bindgen` CLI and
`wasm32-unknown-unknown` target when needed. On macOS arm64 and x86_64, and
Linux arm64 and x86_64, the build downloads a checksum-verified CLI release
when one is available. It caches the executable under
`$CARGO_HOME/wasm-bindgen-cli/<version>/<target>`. Other platforms and CLI
versions use `cargo install` into the same versioned cache. Binaryen's
`wasm-opt` is also required. On macOS, the build installs Binaryen with
Homebrew if missing. Set `WASM_BINDGEN` or `WASM_OPT` to select executable
paths. The build uses
`.work/target-defuddle-wasm` unless `CARGO_TARGET_DIR` is set and writes
generated bindings under `extension-loupe/.generated/`.
