# Loupe deslop evidence

Scope: `extension-loupe/`, Darwin arm64, base `a8c1aebaa38071bd751efa3bdd0b5b04a37e2e1e`. No production or test code changed. Commands use `export PATH="$HOME/.local/bin:$PATH" TMPDIR="$PWD/.work/tmp"` first. Browser tabs and the Tansu HTTP API consume the import flow.

## DSLP-10

`tsconfig.json:12`–`23` already enables `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, and `noPropertyAccessFromIndexSignature`. No additional setting was adopted. `pnpm run typecheck` exited 0 after generating the pinned WASM bindings. Candidate command: `pnpm exec oxlint -c oxlint.config.mjs extension-loupe -W typescript/no-explicit-any -W typescript/no-non-null-assertion -W typescript/no-floating-promises -W typescript/switch-exhaustiveness-check -W typescript/no-unsafe-assignment -W typescript/no-unsafe-call -W typescript/no-unsafe-member-access -W typescript/no-unsafe-return -W typescript/no-unsafe-argument -f json`. Counts include tests and are diagnostics, not configuration changes.

| Candidate | Diagnostics | Disposition |
| --- | ---: | --- |
| no-explicit-any, no-floating-promises, switch-exhaustiveness-check | 0 each | Rejected: no defect or escape-hatch witness. |
| no-non-null-assertion | 47 | Rejected: many DOM and test fixture assertions; not all proved sound. |
| no-unsafe-assignment, call, member-access, return, argument | 2, 1, 0, 2, 1 | Rejected: dynamic browser calls require separate analysis; no witnessed defect established. |

Before/after counts unchanged: `any` 0, `as` casts 17, non-null assertions 47, `@ts-` directives 0, lint disables 0. Assertions use the Oxlint diagnostics; casts were counted with `rg -o -P '\bas\s+(?:unknown\b|typeof\b|[A-Z{])' extension-loupe -g '*.ts'`, excluding two matches in test names; directives use `rg -n -P '@ts-(ignore|expect-error|nocheck|check)|(oxlint|eslint)-disable' extension-loupe -g '*.ts'`. The remaining assertions and casts were not all individually validated.

## DSLP-16

| Contract | Guarding tests (file:line) | Disposition |
| --- | --- | --- |
| Window messaging origin, source, version and request identity | `extension-loupe/test/tansu-page-protocol.test.ts:72`, `extension-loupe/test/tansu-page-protocol.test.ts:86`, `extension-loupe/test/tansu-page-protocol.test.ts:121` | Retain: rejects foreign messages and correlates results. |
| Import payload and image limits | `extension-loupe/test/tansu-import.test.ts:297`, `extension-loupe/test/tansu-import.test.ts:314`, `extension-loupe/test/tansu-import.test.ts:479` | Retain: bounds downloads and preserves failures. |
| Persisted origin and validation | `extension-loupe/test/tansu-extension-calls.test.ts:12`, `extension-loupe/test/tansu-schemas.test.ts:24` | Retain: reads saved origin and rejects invalid settings; actual options-page persistence is not isolated here. |
| Browser-to-Tansu import | `web/ts/e2e/loupe-import.loupe.ts:107`, `web/ts/e2e/loupe-import.loupe.ts:143` | Retain: menu and keyboard flows through a packaged extension. |

Test pyramid: `cpu-guard --cores 4 -- pnpm exec vitest run extension-loupe/test` exited 0: 12 files, 76 tests, 0.533s on a busy host. `cpu-guard --cores 4 -- make test-loupe-browser` exited 0: 2 files, 2 tests, 1.99s after installing the pinned browsers with `pnpm run playwright:install` (the initial run exited 2 because Chromium was missing). Browser component tests use `make test-loupe-browser`; packaged integration uses `make test-e2e-loupe`; `make test` combines unit and Rust workspace tests. Flake rate and comparable warm before/after costs are unmeasured. No tests changed.

Fault injection: `cp extension-loupe/src/tansu-page-protocol.ts .work/tmp/loupe-protocol-original.ts`; replace the unique `event.source !== win || event.origin !== win.location.origin` with `event.source !== win`; `pnpm exec vitest run extension-loupe/test/tansu-page-protocol.test.ts` exited 1: `ignores readiness from other sources, origins, versions, and channels` and `a result from a foreign origin is ignored and the request times out` failed. `cp .work/tmp/loupe-protocol-original.ts extension-loupe/src/tansu-page-protocol.ts` and `cmp .work/tmp/loupe-protocol-original.ts extension-loupe/src/tansu-page-protocol.ts` exited 0; the same Vitest command after restoration exited 0 (6 passed).

Needs environment: `make coverage` and `make mutants-diff` exited 2, no targets; `node -e 'for(const p of ["@vitest/coverage-v8","@stryker-mutator/core","knip"])try{console.log(p,require.resolve(p))}catch{console.log(p,"unavailable")}'` reports all unavailable. Branch coverage, automated bounded mutation and survivor dispositions are unverified. The manual fault is not a mutation sweep; repository targets and CI are outside this slice.

## DSLP-22

`tsconfig.json:18`–`19` enables unused locals and parameters, but does not prove exports or dependencies dead. Caller searches: `rg -n 'from .*extension-loupe|extension-loupe/|tansu-page-protocol|tansu-settings|tansu-import' extension-loupe web -g '!**/vendor/**' -g '!**/dist/**'` and `rg -n 'entry|input|reader-content|service-worker|options|tansu-import-page' scripts/build-loupe.mjs extension-loupe/src/manifest.json`. The manifest registers the service worker and options (`extension-loupe/src/manifest.json:13`, `extension-loupe/src/manifest.json:24`); `extension-loupe/src/tansu-import-page.ts:1` imports the protocol; settings are consumed by `extension-loupe/src/options.ts:3` and `extension-loupe/src/tansu-send.ts:4`. The web receiver consumes the image placeholder format (`web/ts/app/extension-import.ts:3`), and packaged tests exercise the import. Production-only absence is not proof of dead code. No removal or allowlist is claimed.

Needs environment: Knip default and production runs, dependency analysis, and a complete debloat sweep remain unverified. DSLP-31 remains open: the Loupe image scanner is quadratic on hostile Markdown (`docs/deslop-diagnose.md`, F7); it is outside this slice. Other platforms and browsers remain unverified.
