# Testing

The main targets are in the root `Makefile`:

| Command | Coverage |
| --- | --- |
| `make check` | Generated API types, Oxlint, TypeScript checking, unit tests, and Rust compilation |
| `make test` | TypeScript and Rust unit tests |
| `make test-e2e-chromium` | Browser end-to-end tests in Playwright Chromium |
| `make test-e2e-webkit` | Browser end-to-end tests in Playwright WebKit |
| `make test-acceptance` | Save, recovery, and browser behavior against the real server |
| `make test-loupe-browser` | Loupe reader UI tests in Playwright Chromium |
| `make test-e2e-loupe` | Loupe-to-Tansu import integration in a fixture server |

`make test` installs the locked frontend dependencies before building and
running tests. Install the Rust toolchain and the Node and pnpm versions named
by the repository first. Run `pnpm install --frozen-lockfile` before direct
pnpm tasks. See [Development](development.md) for setup and browser dependencies.

The path tests passed on Linux x86_64 musl and aarch64 musl on 2026-10-23.
Each matching-architecture Alpine container executed all eight `paths::tests`,
including `operations_accept_a_root_relative_to_the_current_directory`:

```sh
cargo test --locked --target x86_64-unknown-linux-musl --lib paths::tests
cargo test --locked --target aarch64-unknown-linux-musl --lib paths::tests
```

Use the normal debug test profile. The logging tests require debug instrumentation,
so `--release --lib` cannot compile the complete library test harness.

Install browser dependencies with `pnpm run playwright:install`; see
[Development](development.md) for toolchain setup.

`make test-acceptance` first runs app interleaving tests, then the browser group
tagged `acceptance:`. Set `ACCEPTANCE_BROWSER=webkit` to use WebKit. Set
`ACCEPTANCE_SERVER_BINARY=path/to/tansu` to test a specific server binary.
The server runs from an isolated working directory with an empty `PATH` and
isolated home directories. The integration suite uses fixtures under
`.work/tmp/`. To exercise a release binary, build the frontend with
`pnpm run build`, build the server with
`cargo build --locked --release --bin tansu`, then run
`make test-acceptance ACCEPTANCE_SERVER_BINARY=target/release/tansu`.

Browser screenshot baselines are specific to the browser and platform. A
platform without a baseline fails the baseline test. After an intentional UI
change, generate Chromium baselines with:

```sh
TANSU_UPDATE_BASELINES=1 TANSU_E2E_BROWSER=chromium pnpm run test:browser -- -t baselines
```

Review the generated images in the diff. A failing run writes the actual image
under `.work/tmp/`.
