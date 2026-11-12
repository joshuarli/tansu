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

`pnpm run check` checks generated API types, lint, TypeScript, unit tests, and
Rust compilation. `make check` runs the same check after installing dependencies.
Type checking is `tsc --noEmit` from the TypeScript 7 package.

The supported Rust targets are `aarch64-apple-darwin`,
`x86_64-unknown-linux-musl`, and `aarch64-unknown-linux-musl`. CI runs the web
half with `pnpm run check:web`, then runs `cargo check` and the Rust tests in the
musl image from `docker/rust-check.Dockerfile`. Reproduce that half with:

```sh
pnpm run build
docker build --platform linux/amd64 -f docker/rust-check.Dockerfile -t tansu-rust-check .
docker run --rm --platform linux/amd64 \
  -v "$PWD:/work" -v "$PWD/.work/tmp/cargo-target:/target" \
  -e CARGO_TARGET_DIR=/target -w /work tansu-rust-check \
  cargo test --locked --workspace --target x86_64-unknown-linux-musl
```

## Run locally

```sh
make dev
```

The fixture app serves port `3000` with one demo note and its WebP images. It
uses isolated settings, data, and a copied vault under `.dev/`. See
[Fixtures](fixtures.md) for fixture setup and [Logging](logging.md) for the dev
and e2e log stream.

To serve your own notes at `notes/` in place instead of the fixtures, run:

```sh
make notes
```

The first run registers `notes/` as the `Notes` vault. Its settings and data
live under `.dev/notes/`, so `make dev` and `make dev-config` do not touch them.
Delete `.dev/notes/` to reset that state. Set `NOTES_DIR` to point at a
different vault, but a changed path reuses the existing registration until you
reset `.dev/notes/`.

`make dev` watches the frontend source and rebuilds it after changes. CSS changes
apply without reloading the page. TypeScript changes reload the page.

For server settings, see [Configuration](configuration.md). For passkey
administration, remote access, and backup procedures, see
[Deployment](deployment.md).

## Skins

A skin restyles the app chrome. It is separate from the `light`, `dark`, and
`paper` color themes. `default` is the shipped look.

`TANSU_SKIN` selects the skin when the frontend is built and must name an entry
in the `skins` list in `scripts/build-web.mjs`. The build defines the name as
`process.env.TANSU_SKIN`, and `web/ts/main.ts` publishes a non-default name as
`data-skin` on the root element. A skin's CSS lives at the end of
`web/static/app.css` under `:root[data-skin="<name>"]`.

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

The build reads `../defuddle-rs` by default when present; set `DEFUDDLE_RS_DIR`
to use another checkout. When neither is set and no sibling checkout exists, it
clones and checks out a pinned defuddle-rs revision into `.work/defuddle-rs`.
It installs the matching `wasm-bindgen` CLI and `wasm32-unknown-unknown` target
when needed. On macOS arm64 and x86_64, and Linux arm64 and x86_64, the build
downloads a checksum-verified CLI release when one is available. It caches the
executable under `$CARGO_HOME/wasm-bindgen-cli/<version>/<target>`. Other
platforms and CLI versions use `cargo install` into the same versioned cache.
Binaryen's `wasm-opt` is also required. On macOS, the build installs Binaryen
with Homebrew if missing. Set `WASM_BINDGEN` or `WASM_OPT` to select executable
paths. The build uses `.work/target-defuddle-wasm` unless `CARGO_TARGET_DIR` is
set and writes generated bindings under `extension-loupe/.generated/`.

## Vendored search engine

Tansu uses the source of Tantivy 0.27.0 in `vendor/tantivy`, licensed under
MIT. `tansu-search` owns the dependency. Changes to the vendored engine must
preserve Tansu's search behavior and derived-index recovery.
The vendored build omits upstream aggregation support, query parsing, and
snippet generation; Tansu constructs queries and excerpts itself.
The vendored crate's upstream unit tests and doctests are disabled because
they depend on removed APIs and development dependencies. Run
`cargo test -p tansu-search` to check the retained search behavior.
The workspace excludes the vendored crate, so workspace-wide lint checks it
as a dependency and checks Tansu's own test targets separately.

