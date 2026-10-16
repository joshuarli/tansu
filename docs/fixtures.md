# Fixtures

The dev app uses the vault in `tests/fixtures/demo-vault/`.
`scripts/dev-fixture.mjs` copies it to `.dev/vault` and initializes isolated
SQLite settings and data under `.dev/`.

## Regenerate dev state

```sh
make dev-config
```

The generator replaces `.dev/config`, `.dev/data`, and `.dev/vault`. The demo
vault contains one long article with its 11 WebP images, plus the tag notes in
`tags/`. `make dev` opens that vault in the app.

## Tag notes

`tests/fixtures/demo-vault/tags/` exercises the tags-only frontmatter forms
that `src/tags.rs` parses: block lists, flow lists, and comma scalars. It
covers:

- shared tags: `baking` and `recipes` on `sourdough-starter.md`,
  `rye-loaf.md`, and `pantry-inventory.md`
- a unique tag: `lighthouse`
- a long tag: `coastal-navigation.md`
- similar prefixes: `rec`, `recipe`, `recipe-ideas`, and `recipes` in
  `rec-prefix.md`
- normalization: `"#Weekend"` and `Recipes` keep their case and drop the
  leading `#` in pills
- overflow: `pantry-inventory.md` has six tags, so rows show three pills and
  `+3`
- no tags: `untagged.md`
- tag-weighted ranking: searching `zephyr` finds `storm-log.md`, which has it
  only as a tag, and `field-journal.md`, which has it once in a long body. The
  tagged note ranks first.

The tag e2e test in `web/ts/e2e/server.test.ts` copies this directory into the
seeded vault One for the duration of the test. The notes live in a subfolder so
the article-only corpus used by the editor benchmark is unchanged.

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
