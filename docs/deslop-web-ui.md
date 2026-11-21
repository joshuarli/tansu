# Web UI deslop evidence

Scope: `web/` outside app and editor, including browser tests, Darwin arm64, base `a8c1aebaa38071bd751efa3bdd0b5b04a37e2e1e`. No production or test code changed. Commands first use `export PATH="$HOME/.local/bin:$PATH" TMPDIR="$PWD/.work/tmp"`.

## DSLP-9

`tsconfig.json:12`–`23` already enables `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, and `noPropertyAccessFromIndexSignature`. No new setting was adopted. The scoped command below exited 0; diagnostics include tests and the counts are candidate overrides, not project configuration changes.

```sh
pnpm exec oxlint -c oxlint.config.mjs web/ts/{child-process.test.ts,dev-log.test.ts,dev-log.ts,dom.ts,main.ts,setup.test.ts,setup.ts,source-hash.test.ts,source-hash.ts,state.test.ts,state.ts,view.test.ts,view.ts,e2e} -W typescript/no-explicit-any -W typescript/no-non-null-assertion -W typescript/no-floating-promises -W typescript/switch-exhaustiveness-check -W typescript/no-unsafe-assignment -W typescript/no-unsafe-call -W typescript/no-unsafe-member-access -W typescript/no-unsafe-return -W typescript/no-unsafe-argument -f json > .work/tmp/web-ui-oxlint.json
node -e 'const a=JSON.parse(require("fs").readFileSync(".work/tmp/web-ui-oxlint.json")); console.log(a.diagnostics.reduce((m,d)=>(m[d.code]=(m[d.code]||0)+1,m),{}))'
```

| Candidate | Diagnostics | Disposition |
| --- | ---: | --- |
| no-explicit-any, no-floating-promises, switch-exhaustiveness-check, no-unsafe-return | 0 each | Rejected: no witness for adoption. |
| no-non-null-assertion | 102 | Rejected: many test DOM and fixture assertions; not all individually established. |
| no-unsafe-assignment / member-access / call / argument | 8 / 10 / 1 / 1 | Rejected: test JSON and mock values; blanket adoption would require validating test responses and exceeds the false-positive budget. The assertions have not all been proved sound. |

Before/after counts unchanged: explicit `any` 0, `as` casts 86, non-null `!` 102, `@ts-` directives 1, lint disables 0. Counts for `any` and `!` are Oxlint diagnostics. Cast count uses `rg -o -P '\bas\s+(?!const\b)(?:unknown\b|typeof\b|[A-Z{])'` on the scoped TypeScript files above; it is a lexical estimate, excluding `as const`. Directives use `rg -n -P '@ts-(ignore|expect-error|nocheck|check)|(oxlint|eslint)-disable'` over the same files: `web/ts/state.test.ts:92` is a negative brand witness. Remaining casts and assertions were not all individually validated.

## DSLP-15

| Contract | Guarding test (file:line) | Disposition |
| --- | --- | --- |
| Rendering and interaction | `web/ts/view.test.ts:22`, `web/ts/view.test.ts:46`, `web/ts/view.test.ts:269` | Retain: status, navigation and overlay events. |
| Workspace restoration | `web/ts/state.test.ts:55`, `web/ts/e2e/server.test.ts:187` | Retain: editor state and restored viewport assets. |
| Setup API and validation | `web/ts/setup.test.ts:100`, `web/ts/setup.test.ts:125` | Retain: request and rejected partial auth. |
| Browser and HTTP lifecycle | `web/ts/e2e/server.test.ts:987`, `web/ts/e2e/server.test.ts:1182`, `web/ts/e2e/auth.test.ts:21` | Retain: lifecycle, stale-save recovery and authentication. |

Test pyramid: `cpu-guard --cores 4 -- pnpm exec vitest run web/ts/{child-process,dev-log,setup,source-hash,state,view}.test.ts` exited 0: 6 files, 42 tests, 0.459s on a busy host. Unit and mounted DOM tests run in happy-dom; browser integration runs separately through `make test-e2e-chromium` and `make test-e2e-webkit`; `make test` includes web and Rust tests. Flake rate and separate browser layer costs were not measured. The ground report records warm `make test` at 71.71s on a busy host; a comparable before/after cost gate was not measured.

Fault injection: `cp web/ts/state.ts .work/tmp/web-ui-state-original.ts`, then replace the unique `sourceMode: tab.mode === "source",` with `sourceMode: false,`. `cpu-guard --cores 4 -- pnpm exec vitest run web/ts/state.test.ts -t 'converts loaded documents to tabs and persists workspace editor state'` exited 1: that test failed at `web/ts/state.test.ts:79`, expected `sourceMode: true`, received `false`. `cp .work/tmp/web-ui-state-original.ts web/ts/state.ts` and `cmp .work/tmp/web-ui-state-original.ts web/ts/state.ts` exited 0; the same test command after restoration exited 0 (1 passed).

Needs environment: make for the coverage and mutants-diff goals exited 2 (no target); `node -e 'try{console.log(require.resolve("@vitest/coverage-v8"))}catch{console.log("coverage-v8 unavailable")}'` reports unavailable, and `test -x node_modules/.bin/stryker` exited 1. Branch coverage, automated bounded mutation, survivor dispositions and comparable warm cost remain unverified. The manual fault is not a mutation sweep. Repository targets and CI are outside this slice.

## DSLP-21

`tsconfig.json:18`–`19` enables unused locals and parameters, but does not establish exported code or dependencies are live. `test -x node_modules/.bin/knip` exited 1. Needs environment: configured default and production Knip runs, dependency analysis and a complete debloat sweep remain unverified; no allowlist or removal is claimed.

Caller searches: `rg -n 'child-process|baselines|app.css|dev-hmr|setup.html|index.html' web extension-loupe src build.rs scripts -g '!web/dist/**' -g '!**/vendor/**'`, `rg -n 'stopChildProcess' web extension-loupe src -g '!web/dist/**'`, and `rg -n 'assets|manifest|include_bytes' src/embedded_assets.rs build.rs scripts/build-web.mjs`. The only `web/static/` asset is `app.css`, referenced by `web/index.html:7`; Vite registers both HTML entries at `scripts/build-web.mjs:35`, the development client at `scripts/build-web.mjs:79`, and the manifest is embedded by `build.rs:9` and `build.rs:58`. The child-process helper has browser and unit callers at `web/ts/e2e/server.test.ts:22`, `web/ts/e2e/auth.test.ts:11`, `web/ts/e2e/loupe-import.loupe.ts:12`, and `web/ts/child-process.test.ts:5`. Browser/platform baselines are selected at `web/ts/e2e/server.test.ts:1902`; the four variants cover Chromium and WebKit on Darwin and Linux. No static asset, helper or fixture was proven dead. Linux execution and other browser/platform combinations remain unverified.
