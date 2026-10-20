# Testing

The main targets are in the root `Makefile`:

| Command | Coverage |
| --- | --- |
| `make check` | Generated API types, TypeScript type checking, and Rust compilation |
| `make test` | TypeScript and Rust unit tests |
| `make test-e2e-chromium` | Browser end-to-end tests in Playwright Chromium |
| `make test-e2e-webkit` | Browser end-to-end tests in Playwright WebKit |
| `make test-acceptance` | Save, recovery, and browser behavior against the real server |
| `make test-loupe-browser` | Loupe reader UI tests in Playwright Chromium |
| `make test-e2e-loupe` | Loupe-to-Tansu import integration in a fixture server |

`make test` installs the locked frontend dependencies before building and
running tests. Install the required Rust, Deno, Node, and npm toolchains first.
For direct `deno task build` use, run `make setup` once. See [Development](development.md)
for the setup steps and browser dependencies.

Install browser dependencies with `deno task playwright:install`; see
[Development](development.md) for toolchain setup.

`make test-acceptance` first runs app interleaving tests, then the browser group
tagged `acceptance:`. Set `ACCEPTANCE_BROWSER=webkit` to use WebKit. Set
`ACCEPTANCE_SERVER_BINARY=path/to/tansu` to test a specific server binary.
The integration suite uses isolated fixtures under `.work/tmp/`.

Browser screenshot baselines are specific to the browser and platform. A
platform without a baseline fails the baseline test. After an intentional UI
change, generate Chromium baselines with:

```sh
TANSU_UPDATE_BASELINES=1 TANSU_E2E_BROWSER=chromium deno task test:browser -t "baselines"
```

Review the generated images in the diff. A failing run writes the actual image
under `.work/tmp/`.
