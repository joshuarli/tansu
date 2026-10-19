# Fixtures

The dev app copies `tests/fixtures/demo-vault/` to `.dev/vault` and
`tests/fixtures/demo-vault-field-notes/` to `.dev/vault-field-notes`. It
registers them as `Demo` and `Field Notes` and initializes isolated SQLite
settings and data under `.dev/`.

## Dev state

```sh
make dev-config
```

The generator replaces `.dev/config`, `.dev/data`, and `.dev/vault`. The demo
vault covers editor, image, and tag behavior. Tag fixtures live under
`tests/fixtures/demo-vault/tags/`; the tag end-to-end test copies them into its
seeded vault. See `src/tags.rs` and `web/ts/e2e/server.test.ts` for the parser
and test cases.

## Test fixtures

Small synthetic vaults live under `tests/fixtures/test-vaults/` and are
prepared by `scripts/test-fixture.mjs`:

```sh
node scripts/test-fixture.mjs .work/tmp/tansu-fixture
```

Use the printed `configHome` as `XDG_CONFIG_HOME` and `dataHome` as
`XDG_DATA_HOME`. The generator points to versioned vaults by default; add
`--copy-vaults` for disposable copies. The e2e harness uses copied vault
contents and isolated XDG paths. Add fixture Markdown and images under
`tests/fixtures/test-vaults/`, not inline in JS or TS.
