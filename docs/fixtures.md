# Fixtures

The dev app uses the single-note vault in `tests/fixtures/demo-vault/`.
`scripts/dev-fixture.mjs` copies it to `.dev/vault` and writes isolated config
and data under `.dev/`.

## Regenerate dev state

```sh
make dev-config
```

The generator replaces `.dev/config`, `.dev/data`, and `.dev/vault`. The demo
vault contains one note and its 17 WebP images. `make dev` opens that note in
the app.

Small synthetic e2e fixtures live under `tests/fixtures/test-vaults/`. Their
generator is `scripts/test-fixture.mjs`.

## Create a fixture root

```sh
node scripts/test-fixture.mjs .work/tmp/tansu2-fixture
```

Use the printed `configHome` as `XDG_CONFIG_HOME` and `dataHome` as
`XDG_DATA_HOME`. By default, the generator points to the versioned vaults. Add
`--copy-vaults` to create disposable copies:

```sh
node scripts/test-fixture.mjs .work/tmp/tansu2-fixture --copy-vaults
```

The e2e harness uses copied vault contents and isolated XDG paths. Add fixture
Markdown and images under `tests/fixtures/test-vaults/`. Do not inline vault
content in JS or TS.
