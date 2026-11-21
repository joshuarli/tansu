# Web application deslop evidence

Scope: `web/ts/app.ts`, `web/ts/app.test.ts`, and `web/ts/app/`, Darwin arm64, base `a8c1aebaa38071bd751efa3bdd0b5b04a37e2e1e`. No production or test code changed. Commands use `export PATH="$HOME/.local/bin:$PATH" TMPDIR="$PWD/.work/tmp"` first. Node 26.13.1, pnpm 12.21.0.

## DSLP-8

`tsconfig.json:12`–`23` already adopts all five strict-profile compiler candidates: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, and `noPropertyAccessFromIndexSignature`. No additional setting adopted. The final `pnpm run typecheck` checks the existing profile. Candidate measurement (includes tests):

```sh
pnpm exec oxlint -c oxlint.config.mjs web/ts/app.ts web/ts/app.test.ts web/ts/app -W typescript/no-explicit-any -W typescript/no-non-null-assertion -W typescript/no-floating-promises -W typescript/switch-exhaustiveness-check -W typescript/no-unsafe-assignment -W typescript/no-unsafe-call -W typescript/no-unsafe-member-access -W typescript/no-unsafe-return -W typescript/no-unsafe-argument -f json > .work/tmp/app-oxlint.json
jaq '[.diagnostics[] | .code] | group_by(.) | map({code: .[0], count: length})' .work/tmp/app-oxlint.json
```

Oxlint exited 0. These are candidate diagnostics, not changes to the project configuration.

| Candidate | Diagnostics | Disposition |
| --- | ---: | --- |
| no-explicit-any, switch-exhaustiveness-check, no-unsafe-call, no-unsafe-return | 0 each | Rejected: no defect or escape-hatch witness for adoption. |
| no-non-null-assertion | 214 | Rejected: many fixture assertions, e.g. `web/ts/app.test.ts:173`; not all assertions independently validated. |
| no-floating-promises | 4 | Rejected: three calls track handled promises (`web/ts/app.ts:1382`, `:2781`, `:2913`); one is in a test. |
| no-unsafe-assignment, no-unsafe-argument, no-unsafe-member-access | 5, 12, 11 | Rejected: diagnostics occur in tests, including mock call arguments (`web/ts/app/document-session.test.ts:83`); no production defect established. |

Before/after: explicit `any` 0, non-null assertions 214 (Oxlint above), `as` casts 131, `@ts-` directives 0, lint disables 3. Count casts with `rg -o -P '\bas\s+(?!const\b)[^\s,;)]+' web/ts/app.ts web/ts/app.test.ts web/ts/app -g '*.ts' | wc -l` (143 matches less five import aliases and seven prose matches; includes both casts in double assertions, excludes `as const`). Count directives with `rg -n -P '@ts-(ignore|expect-error|nocheck|check)|(oxlint|eslint)-disable' web/ts/app.ts web/ts/app.test.ts web/ts/app -g '*.ts'`. Branded identity casts (`web/ts/app/identity.ts:21`) follow validation; IndexedDB and session-state casts remain leads, not all individually proved sound.

## DSLP-14

| Contract | Guarding test (file:line) | Disposition |
| --- | --- | --- |
| HTTP requests, response identity and mutation outcomes | `web/ts/app/v2-api.test.ts:100`, `web/ts/app/v2-api.test.ts:269`, `web/ts/app/v2-api.test.ts:379` | Retain: routes, outcome decoding and identity mismatch rejection. |
| Workspace ownership and persisted draft identity | `web/ts/app/workspace-ownership.test.ts:9`, `web/ts/app/workspace-ownership.test.ts:49`, `web/ts/app/workspace-store.test.ts:284` | Retain: exclusive lock, release and accepted revision handling. |
| Document saves and conflicts | `web/ts/app/document-session.test.ts:74`, `web/ts/app/document-session.test.ts:167`, `web/ts/app/document-session.test.ts:574` | Retain: serialized edits, conflict metadata and newer canonical revision. |
| Browser/editor session and extension import | `web/ts/app.test.ts:991`, `web/ts/app.test.ts:2028`, `web/ts/app.test.ts:2451` | Retain: tab isolation, merge and import through app boundary. |

Test pyramid: `cpu-guard --cores 4 -- pnpm exec vitest run web/ts/app.test.ts web/ts/app` exited 0: 16 files, 301 tests, 5.72s on a busy host. Unit and mounted integration tests use happy-dom; `make test` combines web and Rust tests, browser integration runs separately (`AGENTS.md`, `Makefile:75`). No tests changed; flake rate and individual layer costs are unmeasured. Ground recorded warm `make test` 71.71s on a busy host; no comparable before/after timing gate was measured.

Fault injection: `cp web/ts/app/document-session.ts .work/tmp/document-session-original.ts`; `python3 -c 'from pathlib import Path; p=Path("web/ts/app/document-session.ts"); s=p.read_text(); a="if (kind?.code === \"save_conflict\") {"; assert s.count(a)==1; p.write_text(s.replace(a,"if (false) {",1))'`; `cpu-guard --cores 4 -- pnpm exec vitest run web/ts/app/document-session.test.ts -t 'preserves canonical content and conflict metadata when a save conflicts'` exited 1: that test expected `conflict` but got `unavailable` at `document-session.test.ts:188`. `cp .work/tmp/document-session-original.ts web/ts/app/document-session.ts` and `cmp .work/tmp/document-session-original.ts web/ts/app/document-session.ts` exited 0; the same focused test on restored source exited 0 (1 passed).

Needs environment: make for the coverage and mutants-diff goals each exited 2 (no such target); `node -e 'try{console.log(require.resolve("@vitest/coverage-v8"))}catch{console.log("@vitest/coverage-v8 unavailable")}'` reported unavailable; `test -x node_modules/.bin/stryker` exited 1. Branch coverage, automated bounded mutation and survivor dispositions are unverified. One manual fault is not a mutation sweep. Adding targets, dependencies and CI is outside this slice.

## DSLP-20

`tsconfig.json:18`–`19` enables unused locals and parameters; exported code and dependencies require caller analysis. `test -x node_modules/.bin/knip` exited 1. Needs environment: configured default and production Knip runs, dependency analysis and a complete debloat sweep are unverified; no allowlist or removal is claimed.

Caller searches: `rg -n 'from ["\x27].*app|startApp\(|new TansuApp\(' web extension-loupe -g '!**/vendor/**' -g '!web/dist/**'` and `rg -n 'createV2ApiClient|DocumentSession|createWorkspaceId|acquireWorkspace|receiveExtensionImport' web extension-loupe -g '!**/vendor/**' -g '!web/dist/**'`. Build entry `scripts/build-web.mjs:35` includes `web/index.html`, which loads `web/ts/main.ts:1`; main calls `startApp` at `web/ts/main.ts:14`. The app creates sessions at `web/ts/app.ts:1110`, takes workspace locks at `web/ts/app.ts:334`, registers import at `web/ts/app.ts:632`, and creates the editor at `web/ts/app.ts:854`. API construction is registered at `web/ts/app/services.ts:62`; `web/ts/view.ts:14`–`18` imports app helpers, and `extension-loupe/test/tansu-import.test.ts:3` consumes an import limit. Searches alone do not establish all exports dead; no proven-dead code removed. Packaged browser behavior and other platforms were not exercised in this pass.
