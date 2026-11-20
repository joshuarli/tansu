# Tooling and benchmarks deslop evidence

Scope: `scripts/`, `bench/`, `deploy/`, `docker/`, root build configuration and `.github/`; Darwin arm64, base `4cc285b1a6686d18c4b842c57c3b736d4da076f3`. No production or test code changed. Commands use `export PATH="$HOME/.local/bin:$PATH" TMPDIR="$PWD/.work/tmp"` first.

## DSLP-11

`tsconfig.json:12`–`24` enables strict, unchecked-index, exact-optional, override and index-signature checks, but its include does not cover root configs or `.mjs` scripts. A scratch config extending it and including the five Vite/Vitest TS configs, run with `pnpm exec tsrs -p .work/tmp/deslop-tooling-tsconfig.json --pretty false`, exited 2: `vitest.e2e.config.ts:13` has `minWorkers`, absent from Vitest's `InlineConfig`. Investigate the intended worker limit against the installed Vitest before changing the browser test contract. No setting adopted. JavaScript has no `checkJs` profile; Python has no configured type checker; shell has no type system. `build.rs` has 15 `expect` calls, mostly build-time input validation, and no `unsafe` or `unwrap` matches.

`pnpm exec oxlint -c oxlint.config.mjs scripts bench vite.loupe.config.ts vitest.config.ts vitest.e2e.config.ts vitest.loupe-browser.config.ts vitest.loupe.config.ts oxlint.config.mjs -W typescript/no-explicit-any -W typescript/no-non-null-assertion -W typescript/no-floating-promises -W typescript/switch-exhaustiveness-check -W typescript/no-unsafe-assignment -W typescript/no-unsafe-call -W typescript/no-unsafe-member-access -W typescript/no-unsafe-return -W typescript/no-unsafe-argument -f json` exited 0: unsafe assignment 92, call 103, member access 237, return 17, argument 71; the other four candidates 0. Reject adoption without typed JS and individual witnesses. The raw `rg -n -P '\bas (?!const\b)|\bany\b|@ts-(ignore|expect-error)|(oxlint|eslint)-disable' scripts bench vite.loupe.config.ts vitest*.config.ts oxlint.config.mjs` found two text matches, neither an escape hatch (an English test title and a lint rule configuration); before/after unchanged. No code changed.

`for f in scripts/*.mjs bench/*.mjs oxlint.config.mjs; do node --check "$f" || exit; done; for f in scripts/*.sh deploy/*.sh; do bash -n "$f" || exit; done; for f in deploy/openrc/* deploy/tansu-services; do sh -n "$f" || exit; done; PYTHONPYCACHEPREFIX="$TMPDIR/pycache" python3 -m py_compile deploy/http-redirect.py` exited 0. `shellcheck scripts/*.sh deploy/*.sh deploy/openrc/* deploy/tansu-services` exited 1: SC2086 at `deploy/deploy-state.sh:91` needs review of intentional SSH option splitting; SC2016 covers literal jaq programs; SC1007 at lifecycle/recovery `:4`; SC2034 covers OpenRC variables and sourced service configuration; SC1091 is an installed host file; SC2148 is the sourced configuration file. This is not a clean shellcheck profile. Needs environment: `ty` and `ruff` are unavailable; Python strict candidates not measured.

## DSLP-17

| Contract | Guard | Disposition |
| --- | --- | --- |
| Fixture path containment | `scripts/test-fixture.test.mjs:10`; browser callers `web/ts/e2e/server.test.ts:79` | Retain. |
| Encoder fingerprint and shipped assets | `scripts/webp-encoder.test.mjs:21` | Retain. |
| Seeded corpus, sizes and symlink replacement | `bench/corpus.test.mjs:15` | Retain. |
| Vanishing search index entry | `bench/directory-size.test.mjs:6` | Retain. |
| Installation lifecycle and mocked remote recovery | `deploy/lifecycle-check.sh:109`, `deploy/recovery-check.sh:148`; `docs/deployment.md:90` | Local checks exist; actual deployed host and credentials not exercised. |
| Build artifacts and CI entrypoints | `Makefile:63`, `.github/workflows/ci.yml:81`, `.github/workflows/lint.yml:35` | Full test and lint are the integration checks; no dedicated tests for every build mode. |

Test pyramid: Vitest includes script and benchmark unit tests (`vitest.config.ts:11`); `make test` also builds assets, checks generated types and runs the Rust workspace; browser tests and `make deploy-check` are separate integration layers. Ground report (`AGENTS.md`) gives warm suite 71.71s on a busy host; no comparable before/after timing or flake rate was measured. No tests were modified. Needs environment: `@vitest/coverage-v8`, Stryker, and coverage/mutation targets are absent; branch coverage, bounded mutation and survivor dispositions are unverified. Adding tools, targets and CI is outside this slice.

Benchmark pyramid: `bench/integrated-bench.mjs:112` measures startup, bootstrap, editor open/switch, save, search, conflict, SSE, watcher, image and restore; large-note find is at `:247`. It checks representative completions, fixed budgets and server process-tree RSS, and writes `.work/tmp/bench-results`; corpus generation is deterministic and separately tested. `make bench` is the existing scenario entrypoint (two warmups, five Chromium runs, host gate); `make bench-full` is the manual wider browser/sample run. Edit tier is `pnpm exec vitest run bench/*.test.mjs`; no named Change selector, list, dry-run or standalone preflight target exists. No benchmark timing run was performed on this busy host. Ranked gaps: (1) no interleaved baseline comparison or change-tier selector, so budget passes can miss regressions below thresholds; (2) CPU, allocation and I/O attribution and browser process memory are not covered; use separate profiled runs; (3) prerequisite and input identity reporting is incomplete. Do not infer a performance verdict from syntax checks.

## DSLP-23

Caller inventory: `rg -n 'bench/|scripts/|deploy/|docker/' Makefile package.json .github docs AGENTS.md build.rs vite*.ts vitest*.ts scripts bench deploy docker` and `rg -n 'corpus|directory-size|process-group|webp-encoder|test-fixture|recovery-check' --hidden -g '!.git/**' -g '!.work/**' -g '!node_modules/**' -g '!target/**' -g '!web/dist/**' .`. Retain means a caller or documented manual use exists; parse evidence is the DSLP-11 syntax command above.

| Entrypoint or file | Caller | Disposition |
| --- | --- | --- |
| `scripts/auth-recovery-drill.sh`, `build-sqlite-static.sh` | Makefile:128, 133; docs/deployment.md:237; Dockerfiles | Retain. |
| `scripts/build-browser-test-bundles.mjs`, `build-defuddle-wasm.mjs`, `build-loupe.mjs`, `build-reader-sample-fixture.mjs` | package.json:13–17; docs/loupe.md:41 | Retain. |
| `scripts/build-web.mjs`, `dev-fixture.mjs`, `dev-hmr.mjs`, `install-playwright-browsers.mjs` | package.json:7–8, 18; Makefile:23–27 | Retain. |
| `scripts/perf-gate.sh`, `test-fixture.mjs`, `webp-encoder.mjs` | Makefile:175; bench/integrated-bench.mjs:11; scripts/build-web.mjs:4; docs/fixtures.md:26 | Retain. |
| `scripts/test-fixture.test.mjs`, `webp-encoder.test.mjs` | vitest.config.ts:12 | Retain. |
| `bench/integrated-bench.mjs`, `budgets.json`, `directory-size.mjs`, `process-group.mjs` | Makefile:181; integrated-bench.mjs:13–14, 592 | Retain. |
| `bench/corpus.mjs`, `corpus.test.mjs`, `directory-size.test.mjs` | vitest.config.ts:11; corpus.test.mjs:7 | Retain; corpus CLI has no non-test caller found, but test exercises its CLI and no removal is proved safe. |
| `deploy/deploy.sh`, `deploy-state.sh`, `install.sh`, `http-redirect.py`, `openrc/tansu`, `openrc/tansu-http-redirect`, `tansu-services` | Makefile:157; deploy/deploy.sh:23, 38, 135, 298–300 | Retain. |
| `deploy/lifecycle-check.sh`, `recovery-check.sh` | Makefile:160; docs/deployment.md:90 | Retain. |
| `docker/linux-e2e-baselines.Dockerfile`, `linux-musl.Dockerfile`, `rust-check.Dockerfile` | Makefile:98, 148; .github/workflows/ci.yml:86, 112 | Retain. |

Dockerfiles are build inputs, not shell entrypoints; no image build was performed in this audit. Needs environment: Knip, cargo-machete, vulture and deptry unavailable; no complete dependency or debloat sweep or allowlist is claimed. No proven-dead file removed; platform-specific deployment execution and remote behavior remain unverified.
