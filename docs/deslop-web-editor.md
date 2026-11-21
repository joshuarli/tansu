# Web editor deslop evidence

Scope: `web/ts/editor/` excluding vendor, Darwin arm64, base `a8c1aebaa38071bd751efa3bdd0b5b04a37e2e1e`. No production or test code changed. Commands use `export PATH="$HOME/.local/bin:$PATH" TMPDIR="$PWD/.work/tmp"` first.

## DSLP-7

The existing `tsconfig.json:12`–`tsconfig.json:23` already adopts `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, and `noPropertyAccessFromIndexSignature`. No additional setting was adopted. `pnpm run typecheck` exited 0 after generating the pinned Loupe WASM bindings. `pnpm exec oxlint -c oxlint.config.mjs web/ts/editor -W typescript/no-explicit-any -W typescript/no-non-null-assertion -W typescript/no-floating-promises -W typescript/switch-exhaustiveness-check -W typescript/no-unsafe-assignment -W typescript/no-unsafe-call -W typescript/no-unsafe-member-access -W typescript/no-unsafe-return -W typescript/no-unsafe-argument -f json` exited 0. Counts below exclude vendor diagnostics and include tests; overrides are candidate measurements, not project configuration changes.

| Candidate | Diagnostics | Disposition |
| --- | ---: | --- |
| no-explicit-any, no-floating-promises, switch-exhaustiveness-check | 0 each | Rejected: no defect or escape-hatch witness for adoption. |
| no-non-null-assertion | 24 | Rejected: mostly test fixture DOM assertions; `wiki-target.ts:32` follows a length check. Not all assertions were proved sound. |
| no-unsafe-member-access | 2 | Rejected: `pasted-image-preview.ts:58`–`59` accesses CodeMirror's loosely typed decoration spec after an `instanceof` check. |
| no-unsafe-assignment, call, return, argument | 0 each | Rejected: no first-party witness. |

Before/after counts are unchanged: explicit `any` 0, `as` casts 17, non-null assertions 24, `@ts-` directives 0, lint disables 15. Casts were counted with `rg -n -P '\bas\s+(?:unknown\b|typeof\b|[A-Z{])' web/ts/editor -g '*.ts' -g '!**/vendor/**'` (17 matches, including both casts in double assertions); explicit `any` and non-null assertions use the Oxlint diagnostics above. `rg -n -P '@ts-(ignore|expect-error|nocheck|check)|(oxlint|eslint)-disable' web/ts/editor -g '*.ts' -g '!**/vendor/**'` counts directives. Definite-assignment assertions are not non-null expressions. The remaining casts and assertions were not all individually validated.

## DSLP-13

| Contract | Guarding test (file:line) | Disposition |
| --- | --- | --- |
| Markdown source, frontmatter and tag edits | `web/ts/editor/tests/editor-session.test.ts:137`, `web/ts/editor/tests/editor-session.test.ts:161`, `web/ts/editor/tests/clipboard.test.ts:17` | Retain: source protection, undoable tag edit, literal conversion. |
| Session isolation and document transactions | `web/ts/editor/tests/editor-session.test.ts:84`, `web/ts/editor/tests/editor-session.test.ts:305`, `web/ts/editor/tests/block-editing.test.ts:42` | Retain: independent histories, read-only rejection, undoable reorder. |
| Asset upload and insertion | `web/ts/editor/tests/image-paste.test.ts:130`, `web/ts/editor/tests/image-paste.test.ts:282`, `web/ts/editor/tests/image-paste.test.ts:332` | Retain: captured session, stale revision, invalid asset response. |
| Stored source and image rendering | `web/ts/editor/tests/editor-source-operations.test.ts:71`, `web/ts/editor/tests/editor-source-operations.test.ts:113` | Retain: previews preserve source; resize is undoable. |

Test pyramid: `cpu-guard --cores 4 -- pnpm exec vitest run web/ts/editor/tests` exited 0, 12 files and 86 tests, 0.526s on a busy host; editor unit and mounted integration tests run in happy-dom. `make test` combines web and Rust workspace tests; browser integration is separate (`AGENTS.md`, `Makefile:75`). No tests were changed; flake rate and individual layer costs are unmeasured. The ground report records warm `make test` at 71.71s on a busy host; a comparable before/after timing gate was not measured.

Fault injection: `cp web/ts/editor/codemirror-adapter.ts .work/tmp/editor-original.ts`; replace the unique `if (transaction.startState.facet(readOnlyFacet)) return [];` with `if (false) return [];`; run `cpu-guard --cores 4 -- pnpm exec vitest run web/ts/editor/tests/editor-session.test.ts -t 'rejects editor, extension, task, table, paste, and resize changes while read-only'`. Exit 1: that test failed at `editor-session.test.ts:333`, observing dirty source with `injected` and revision 1 instead of unchanged source and revision 0. `cp .work/tmp/editor-original.ts web/ts/editor/codemirror-adapter.ts` followed by `cmp .work/tmp/editor-original.ts web/ts/editor/codemirror-adapter.ts` exited 0; the same Vitest command on restored source exited 0 (1 passed).

Needs environment: make for the coverage and mutants-diff goals each exited 2 (no such targets); `node -e 'try{console.log(require.resolve("@vitest/coverage-v8"))}catch{console.log("@vitest/coverage-v8 unavailable")}'` reports unavailable, and `node_modules/.bin/stryker` is absent. Branch coverage, automated bounded mutation, survivor dispositions, and warm cost comparison remain unverified. The single manual fault is not a mutation sweep. Repository targets and CI are outside this slice.

## DSLP-19

`tsconfig.json:18`–`19` enables unused locals and parameters; this does not establish that exported code or dependencies are live. `node_modules/.bin/knip` is absent. Needs environment: configured default and production Knip runs, dependency analysis, and a complete debloat sweep remain unverified; no allowlist or removal is claimed.

Caller searches: `rg -n 'from .*editor|editor/' extension-loupe web/ts --glob '!**/vendor/**' --glob '!web/dist/**'` and `rg -n 'addPendingImagePreview|removePendingImagePreview|pendingImagePreviews|moveBlock\(|planBlockMove\(|sanitizeHtmlToMarkdown|resolveWikiTarget|webpAssetMarkdown' web/ts extension-loupe --glob '!**/vendor/**' --glob '!web/dist/**'`. The application creates the editor at `web/ts/app/services.ts:1`, resolves links at `web/ts/app.ts:604`, and uses asset Markdown in `web/ts/app/extension-import-receiver.ts:67`. Editor registration and internal callers include `web/ts/editor/codemirror-adapter.ts:527`, `web/ts/editor/codemirror-adapter.ts:734`, `web/ts/editor/codemirror-adapter.ts:846`, and `web/ts/editor/block-drag.ts:198`. Tests also call several exports; production-only absence would not prove them dead. No proven-dead code was removed. Packaged browser behavior and other platforms were not exercised in this pass.
