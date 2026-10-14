# Fixtures

Dev and e2e tests use disk-backed vaults under
`tests/fixtures/test-vaults/`. The generator is `scripts/test-fixture.mjs`.

## Regenerate dev state

```sh
make dev-config
```

The generator writes `.dev/config/tansu/config.toml` and `.dev/data/`. The
config points directly at the versioned fixture vaults. The app stores runtime
state under `.dev/data`.

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
