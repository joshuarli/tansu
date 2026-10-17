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
uncommitted changes) when it starts and again when it passes, and the SHA-256 of
the server binary the browser group ran against. Record the artifact hash in the
release notes: it identifies what was tested, and the revision only says where
it came from. The browser group fails if the binary changes while it runs.

By default the suite builds and tests the debug binary. To test a release
artifact, run `ACCEPTANCE_SERVER_BINARY=path/to/tansu2 make test-acceptance`; the
printed hash must equal `node scripts/artifact-hash.mjs` of the file you ship.

It runs two groups of tests:

- Interleavings in `web/ts/app.test.ts` (`interleavings`). Injected services
  delay or reject one response at a time while the test switches tabs, closes a
  tab, expires auth, or finishes an image upload.
- Persistence, recovery, and browser behavior in `web/ts/e2e/server.test.ts`
  (`acceptance:`), against the real server in one browser:
  - Exact Markdown bytes on disk after an edit closed immediately and read from
    a second browser context, a save held in flight across a server restart, a
    stale save whose conflict draft restores against the canonical revision, and
    a save dropped twice by the network that is retried under one mutation id.
  - Auth expiring during an image upload locks the app without a dangling image
    link or lost text; a replayed stale event and a duplicated event stream do
    not roll the note list back or move the resume cursor.
  - A long session of opening, closing, and pasting leaves no live Worker, no
    extra blob URL, and no second editor.
  - Canonical light and dark screenshots of the note view and command palette.

Screenshot baselines live in `web/ts/e2e/baselines/<browser>-<platform>/`.
Fonts and text rendering differ across operating systems and browser builds, so
a baseline is only valid for the browser and platform in its directory, and a
platform without one fails the test. The comparison runs in the browser, ignores
per-channel differences up to 8 and fails above 0.2% differing pixels. Create or
refresh baselines after an intentional UI change with
`TANSU2_UPDATE_BASELINES=1 TANSU2_E2E_BROWSER=chromium deno task test:browser -t "baselines"`
and review the images in the diff. A failing run writes the actual image to
`.work/tmp/baseline-actual-<name>.png`.

`ACCEPTANCE_BROWSER=webkit make test-acceptance` runs the browser group in Safari's
engine. The test named `saves an image inserted into a note after the user
switched away` is marked `it.fails` because the defect is open; when it is fixed
the suite fails until the marker is removed.

## Loupe import test

`make test-e2e-loupe` runs an opt-in Chromium test of the Loupe extension
importing a page into a fixture Tansu server. It is not part of `make test`,
`make check`, or the default e2e commands, and it needs Chromium only because
WebKit cannot load extensions.

It needs a checkout of the extensions repository with its own prerequisites (see
that repository's development guide). The target uses `~/d/extensions`; set
`LOUPE_EXTENSIONS_DIR` to use another checkout. When the directory is missing the
target prints a skip reason and exits 0. Otherwise it runs `pnpm run build` there,
which writes the unpacked extension to `build/extension-loupe`, and then runs
`web/ts/e2e/loupe-import.loupe.ts`. Running that file without
`LOUPE_EXTENSIONS_DIR` skips it.

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
