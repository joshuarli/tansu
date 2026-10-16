# Development

## Set up

Install the Rust toolchain in `rust-toolchain.toml`, Deno 2, Node 26 or later,
and pnpm 12.13.0. `make dev` installs the locked frontend dependencies for you.

```sh
pnpm install --frozen-lockfile
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
make test-acceptance
```

`make dev` serves the app on port `3000` with one demo note and its WebP images.
It creates isolated SQLite settings, data, and a copied vault under `.dev/`; it
does not use your real vault configuration. See [Fixtures](fixtures.md) for fixture
setup and [Logging](logging.md) for the dev and e2e log stream.

`make check` verifies generated types, TypeScript types, and Rust compilation.
`make test` runs the TypeScript and Rust unit suites. The two e2e commands cover
Chrome's and Safari's browser engines.

See [Configuration](configuration.md) for server settings and
[Deployment](deployment.md) for passkey administration, remote access, and
backup and recovery procedures.

## Acceptance suite

`make test-acceptance` is the standing check for save and recovery behavior. It
prints the git revision it ran against (with `-dirty` when the tree has
uncommitted changes) when it starts and again when it passes. Record that revision in the
release notes and run the suite on the exact commit you build the release from.

It runs two groups of tests:

- Interleavings in `web/ts/app.test.ts` (`interleavings`). Injected services
  delay or reject one response at a time while the test switches tabs, closes a
  tab, expires auth, or finishes an image upload.
- Persistence and conflict recovery in `web/ts/e2e/server.test.ts`
  (`acceptance:`), against the real server in one browser. They assert the exact
  Markdown bytes on disk: an edit closed immediately and read from a second
  browser context, a save held in flight across a server restart, and a stale
  save whose conflict draft restores against the canonical revision.

`ACCEPTANCE_BROWSER=webkit make test-acceptance` runs the browser group in Safari's
engine. The test named `saves an image inserted into a note after the user
switched away` is marked `it.fails` because the defect is open; when it is fixed
the suite fails until the marker is removed.

## Build

`deno task build` uses Vite 8 to create fingerprinted frontend bundles and a
manifest under `web/dist/`. That directory is generated and ignored. Cargo runs `build.rs`
whenever it compiles the root package, and that script reads the manifest.
`make check`, `make test`, `make types`, and `make types-check` build production
assets first. `make dev` installs frontend dependencies, builds development
assets, and generates API types before starting the server.
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
