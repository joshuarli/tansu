# Tansu2 desktop redesign campaign

**Status:** ready for an unattended executor. **Prepared:** 2026-10-14 against `1ecf383` on `master`; work from the actual checkout.
**Target:** `~/d/tansu2`. **Read-only references:** `~/d/ferrisearch` @ `039b6b2` (search core), `~/d/laputa-systems/laputa/mirror/webauthn-minimal` @ laputa `ef53ce3` (WebAuthn), `~/d/tansu` (optional visual reference). The campaign must run without any of them present after vendoring.

**Goal:** a calm desktop-browser Markdown workspace over ordinary files: CodeMirror 6 + vendored Atomic live preview replacing the custom contentEditable editor; Ferrisearch-derived search; hardened storage, identity, and recovery; a Hyper transport with passkey auth; one standalone binary with embedded assets.

**Deliverables**

1. **D1 Editor.** CodeMirror 6 with vendored Atomic modules behind a Tansu adapter; one `EditorState` per open note; the old engine deleted.
2. **D2 Storage.** Durable `vaultId`/`serverInstanceId`, `/api/v2`, byte-preserving source, versioned hashes, idempotent mutations, pre-write disk reconciliation, crash-safe materialization.
3. **D3 Search.** `crates/tansu-search` (Ferrisearch core) with source-range hits, quick-open, private unsaved-note overlay, durable warm-restart index.
4. **D4 Sessions.** Per-document state machine, one in-flight save, recovery journal, per-browser workspace store, clean cache separated from drafts.
5. **D5 UI.** Desktop surfaces, keyboard map, virtual-title rename.
6. **D6 Transport and auth.** Runtime-neutral Hyper HTTP/1 and HTTP/2 prior knowledge, bounded work, SSE resync, `crates/tansu-webauthn` passkeys, origin/CSRF/CSP.
7. **D7 Packaging.** Embedded fingerprinted assets, standalone binary, dry-run migration, deployment docs.
8. **D8 Performance.** Section 6 targets measured against the frozen corpus.
9. **D9 Docs and provenance.** Updated docs, vendored-code provenance, licenses.

---

# Charter

- Decide, log the call in the Decision log, and keep going. Never ask, never wait for approval, send no check-in or progress report. Run until every deliverable is met or every remaining item is parked.
- **Hard stops** (park the item with a finding, continue elsewhere): any action outside the repo or on real data (real vault, real config/data dir, Tailscale configuration, real credential enrollment, publishing, deploying, pushing); a boundary the Non-goals or Contract changes section forbids; a loop that cannot check anything. Pushing is always forbidden. Never run pre-commit hooks or formatters.
- **Parity before optimization.** Until phase P3, time budgets are measured and logged, never gating. Structural gates (section 6) apply from the first item that touches the path.
- **Fix on the way, in its own commit,** what is egregious: a loop command over 120 s; a typing transaction over 100 ms of main-thread work on a 50 KB note; a vault search over 1 s on the 2,500-note corpus; a regression over 3x against the P0 baseline; a baseline-red test that blocks the item. Record anything else seen and leave it.
- **Failing item:** find the cause before retrying (`root-cause`). Three attempts, then park with a finding.
- **Commits** (owner decision): lanes and the integrator commit on branch `campaign/desktop-redesign` from worktrees `.work/wt/<lane>`; each is a Conventional Commit scoped to the workstream (`feat(search): ...`); the item ID goes in the body. `master` is never committed to.
- **Working state** lives under `.work/` (ignored through `.git/info/exclude`). Scratch is `.work/tmp`; set `TMPDIR` to it. Never `/tmp`. Fixture roots, test servers, config and data dirs are created there.
- **Code comments:** none, except an external-protocol quirk, a lint-required comment, or a legal header. Vendored upstream files stay verbatim, comments included. Files adapted from Ferrisearch and webauthn-minimal lose their prose comments on adoption. Comments never cite this document.
- **Bookkeeping:** this document's two logs are the ledger. No per-file hashes, corpus fingerprints, status files, or evidence directories. Check the thing itself.
- **Width.** Machine: 10 cores, 32 GB. P1 runs up to five implementation lanes (SRV, SEA, NET, EDT, APP), each in its own worktree and `CARGO_TARGET_DIR` under that worktree (kache shares compilation). Budget about 4 GB per lane. Browser suites (Playwright) run only in the integrator's scratch worktree, one engine at a time. The coordinator writes no feature code while lanes run, merges one lane at a time (rebase, fast-forward, run the touched areas' checks from a scratch worktree), then `git worktree remove` and `git branch -d` for merged lanes.
- **Lane contract:** lanes own the design of their slice inside their files and log each call. They never coordinate with each other; cross-workstream needs go to the integrator. Shared files are append-only (`Cargo.toml`, `Cargo.lock`, `package.json`, `pnpm-lock.yaml`, `src/api_types.rs`, `src/api.rs` route table, docs). A lane runs only the checks for the tests it wrote or changed; suites, browser runs, and release builds belong to the integrator. A lane adds a dependency only when its item names it.
- **Contract-first:** DTOs, hash formats, route shapes, and lifecycle semantics are settled once by item G3. No lane redesigns them.

---

# Decisions

## Owner-decided

| Date | Decision |
| --- | --- |
| 2026-10-14 | Commit on `campaign/desktop-redesign`, never push, never touch `master`. |
| 2026-10-14 | `z-images/` is the only asset directory. No legacy `images/` resolver, no HEIC inventory. A reference outside `z-images/` renders an unresolved-asset tile and stays editable source. |
| 2026-10-14 | Passkeys use a vendored, hardened `webauthn-minimal` (not `webauthn-rs`). Profile: one configured RP, one owner, several credentials, ES256/P-256, attestation `none`, `userVerification: required` enforced in both finish methods (fixed policy, no setting). Hardening list in N2. |
| 2026-10-14 | Plain TypeScript. No SolidJS, React, Preact, Effect, signals library, virtual DOM, or framework. |
| 2026-10-14 | CodeMirror 6 plus vendored Atomic Editor `b6ed65f` (0.6.2, MIT), headless modules only. |
| 2026-10-14 | Vendor Ferrisearch core as `crates/tansu-search`; SQLite catalog and Tantivy index both stay; per-vault mutations stay serialized. |
| 2026-10-14 | Pin the local Hyper and H2 futures-lite forks; accept HTTP/1 and prior-knowledge HTTP/2 without Tokio or h2c. Keep synchronous vault work on bounded blocking workers. |
| 2026-10-14 | Title is the filename-derived virtual title; an existing H1 stays in the body; title edit is a rename, not a body edit. |
| 2026-10-14 | Desktop first. iPhone/touch/virtual keyboard, PWA, service worker, offline sync are deferred. |
| 2026-10-14 | Ferrisearch keeps its LGPL-3.0 notice (the LICENSE is FSF boilerplate with no holder line). No distribution happens in this campaign; relicensing is the owner's later call. |

## Prescribed (the owner can overrule)

| Decision | Reason, and what reverses it |
| --- | --- |
| Convert the root to a Cargo workspace (`[workspace] members = ["crates/*"]`, root package stays `tansu2`). | Today `Cargo.toml` has no workspace; `crates/` needs one. `make coverage-rs` already says `--workspace`. |
| Embedded assets are new work. | Today `src/http.rs:395-411` serves `web/` relative to the working directory; nothing is embedded. `deno task build` emits `web/dist/` plus a manifest; Rust embeds it through generated `include_bytes!` entries. No new crate unless it saves more than it costs; `cargo build` never runs Node. |
| Dependencies: pinned Hyper and H2 futures-lite forks, `http-body-util`, and modular async-executor, async-io, async-net, async-lock, async-channel, blocking, event-listener, futures-io, futures-lite, futures-util, and ctrlc packages; no Tokio or upstream Hyper. `nucleo-matcher = "0.3"`. Tantivy stays `0.26` with `mmap`, `lz4-compression`. | The local forks provide HTTP/1 and HTTP/2 builders over futures I/O, avoiding a Tokio adapter. Measure the final stripped binary in O4. |
| `webauthn-rs` is dropped. | It needs OpenSSL unconditionally (`openssl-sys` via `webauthn-rs-core`); the repo's musl Dockerfile has no perl/make/OpenSSL, and the closure grows 140 to 238 crates. |
| Dev/loopback mode (no auth, loopback origins only) and authenticated mode (fixed HTTPS origin and RP ID) are the only two modes. No "no-auth tailnet" mode. | The draft hedged ("if retained"). Reversible by one config value later. |
| Session tokens and enrollment capabilities come from the OS RNG (`getrandom`, already in the closure through graviola). `fastrand` (note IDs, request IDs) never mints a secret. | `src/catalog.rs:633` and `src/http.rs:275` use `fastrand`. |
| Search field weights stay Ferrisearch's effective ones: title 10, path/directory 7, headings 5, tags 2 (real Tansu tags only), content 1. | Its real defaults are not 10/5/1 (`types.rs` FieldBoosts). Change only with a frozen-expectation test. |
| Incremental commits use `commit_no_merge`; `commit()` force-merges (`index.rs:204-215`) and is not called on the save path. | Structural gate. |
| "Typo-only" mode post-filters hits to those with at least one match at edit distance greater than zero. | Upstream fuzzy-only still retrieves distance-0 documents; only highlights exclude them. |
| Fuzzy threshold: 5 sparse results, independent of requested limit (upstream compares against the limit-capped count, so limits at or under 5 always go fuzzy). Phrase-only queries never go fuzzy. | Keeps the documented semantics deterministic. |
| New `sourceHash` values use BLAKE3 over LF-normalized source (`blake3-v3:`, format 3); new `diskHash` values use BLAKE3 over exact bytes (`blake3-v2:`, format 2). SHA-256 snapshot, catalog, workspace-journal, and idempotency records remain readable; catalog values upgrade during reconciliation without a new note revision. | The wire version identifies the algorithm and normalization rules. WebAuthn retains protocol-mandated SHA-256. |
| Parser fuzzing is table and property tests with fixed seeds; no `cargo-fuzz`. | A new toolchain for one small parser is not earned. |
| Vendor Atomic's nine closure files plus `styles/inline-preview.css`, including `wiki-links.ts` (adds `@codemirror/autocomplete`). Exclude `AtomicCodeMirrorEditor.tsx` and `code-languages.ts`. `markdown({ codeLanguages: [] })`, no language registry. | Probe: closure is 3,973 lines, no React, one `@codemirror/state` copy. Autocomplete is a required feature. |
| `UPSTREAM.md` per vendored root: upstream URL, commit, license, imported paths, local patches, manual update steps. No per-file hashes. | `git diff` against the import commit is the patch record. |
| Release builds are permitted only for items O1-O4, H4 and Z3. Edit the "no release binaries" line in `AGENTS.md` to say exactly that. | Packaging and perf need them; publishing stays forbidden. |
| The musl artifact is built with `make build-linux-musl-docker` (OrbStack is available). The Dockerfile keeps lld; it gains `COPY` lines for `crates/` and the built `web/dist/`. `.github/workflows/build-server.yml` runs `deno task build` first. | The host has no mold or musl C toolchain. |
| Real desktop Safari and hardware authenticators are reported as unavailable. | Nothing to fake. |
| Playwright browsers are not installed. P0 runs `deno task playwright:install` (documented setup). | Required for three-engine gates. |

## Delegated (executor decides inside the bound, logs the call)

| Area | Bound |
| --- | --- |
| Line-ending map for edits that join or split lines | Untouched lines keep their spelling; inserted boundaries use the file's recorded dominant convention; new files LF; deterministic and tested. |
| Where `vaultId` and `serverInstanceId` live | Application state under the data root, never in Markdown or the vault directory; survives config reorder and vault rename. |
| Queue, body, overlay, and image limits | Existing 32 MB request body and 1 MB header limits are ceilings. Overlay defaults: at most 20 notes and 2 MB. Every queue bounded with a stated overflow policy. |
| Search memory | Start with one shared writer budget of at most 64 MB; idle vaults hold no open writer. Raise only on measurement. |
| Editor stylesheet placement | One bundled file under `web/ts/editor/`. |
| Table widget, read-only bypass, whole-document syntax work in Atomic | Patch the vendored module minimally, record it in `UPSTREAM.md`, add the test. Never replace with a new contentEditable engine. |
| Route and DTO names inside G3 | Follow `/api/v2/vaults/:vaultId/notes/:noteId` and the field names in section 7. |

---

# Baseline (P0, measured 2026-10-14 on `1ecf383`)

**Known failures.** The unit loop is green. `make test-e2e-chromium` fails at browser launch: Playwright browsers are not installed (11 s). That is environment, not a regression; G1 fixes it. Nothing else red.

**Loop timings** (warm caches; cold Rust build not measured):

| Command | Seconds |
| --- | --- |
| `deno task typecheck` | 1 |
| `deno task lint` | under 1 |
| `deno task test` (602 tests) | 3 |
| `make types-check` | 4 |
| `cargo check -q` | under 1 |
| `cargo clippy --all-targets` | 5 |
| `cargo test -q` (49 tests) | 3 |
| `make test-e2e-chromium` | not measured (blocked) |

The loop is already fast; no loop-repair item. `make lint-rs` runs `clippy --fix`: never use it. Use `cargo clippy --workspace --all-targets`.

**Gates that exist:** TS coverage lines 90 / functions 85 (`vitest.config.ts`); Rust coverage lines 87 / functions 80 (`make coverage-rs`); `bench/budgets.json` (`productionBundleBytes` 1,500,000). Production bundle today: 135,577 B raw, 39,259 B gzip.

**Perf numbers the P3 phase compares against:** run `make bench` once in G1 on an idle host (`perf-gate-ready` must exit 0, and again with `-1` right after) and log the output in the campaign log. The host was busy during preparation (load 9-13 on 10 cores), so no timing was taken.

**Parity register.** The reference is the current Tansu2 at `1ecf383`: runnable, with its tests. Dispositions are logged in the campaign log as each area lands.

| Area | Reference tests | Disposition |
| --- | --- | --- |
| Pure transforms | `format-ops`, `diff`, `merge`, `markdown-tags`, `save-delta`, `html-import`, `util` tests | Keep; the new editor and sessions call them. |
| Model/DOM engine | `editor-model`, `editor-normalize`, `cursor-offset`, `render-selection`, `editor-hot-path`, `serialize`, `roundtrip`, `editor.test.ts` internals | Behaviors port to CodeMirror adapter tests (source fidelity, selection, undo, source mode); DOM-model internals are deleted with the engine, reason logged. |
| Markdown rendering | `markdown`, `highlight`, `inline-patterns`, `extensions` (wiki link, wiki image, callout) | Every case is a live-preview or extension test, or logged as an intentional change. |
| App/state | `app.test.ts` (27), `state`, `view`, `api`, `note-cache` tests | Re-expressed against the session state machine and new components. |
| Server | 49 Rust tests; `web/ts/e2e/server.test.ts` (26) | Six browser cases remain, two are rewritten for V2, one lifecycle case is new, and 18 editor cases have dispositions below. |
| Search | `src/search.rs` tests; Ferrisearch's 106 inline tests | Port; differential run once against the reference; intentional differences logged. |

A behavior with no test is not done. Break the port on purpose once per area and see its test fail.

---

# Sequence

**Workstreams and ownership**

| Workstream | Owns |
| --- | --- |
| **INT** (integrator) | `Cargo.toml` workspace, `AGENTS.md`, `Makefile`, `src/api_types.rs` contract, docs index, merges |
| **SRV** | `src/{vault,catalog,history,reconcile,paths,config,tags}.rs`, `src/app.rs` |
| **SEA** | `crates/tansu-search/**`, `src/search.rs` |
| **NET** | `src/{http,auth,embedded_assets}.rs`, `build.rs`, `crates/tansu-webauthn/**`, `scripts/build-web.mjs`, `docker/**`, `.github/workflows/**` |
| **EDT** | `web/ts/editor/**` (vendor, adapter, extensions, harness, editor tests) |
| **APP** | `web/ts/{app,state,api,note-cache,save-delta,view,dom,main}.ts`, `web/ts/app/**`, `web/ts/ui/**`, `web/static/app.css`, `web/index.html` |

Fixtures and e2e files (`tests/fixtures/**`, `web/ts/e2e/**`, `bench/**`) are append-only for every lane; G2 owns the corpus.

## P0: ground (INT, serial, one session)

- **G1 Baseline and guards.** Create the branch; confirm `.work/` exclusion; `deno task playwright:install`; run the e2e suite on all three engines and `make bench` on an idle host; log the numbers and any red. Convert the root to a workspace; add `crates/` to the Dockerfile `COPY`; edit the `AGENTS.md` release-build line (D-prescribed wording). Add a test-harness guard that refuses to start a server whose config or data dir is outside `.work/` or the OS temp root. Proof: `make check`, `make test`, `cargo test --workspace -q`, `make test-e2e-chromium`.
- **G2 Source-fidelity corpus.** Fixtures under `tests/fixtures/source-fidelity/`: repeated, leading, trailing blank lines; LF, CRLF, mixed, BOM; unsupported and mixed frontmatter; Unicode and emoji; duplicate titles; identical-content notes; nested folders; large source; corrupt and missing snapshots; stale saves; escaped delimiters, fences containing `#`, unusual list indentation, tables, links, callouts, wiki embeds. Tests operate on copies under `.work/` and finish with `git diff --exit-code tests/fixtures`. Proof: the corpus loader test.
- **G3 Wire contract v2.** Settle in one commit: `/api/v2/vaults/:vaultId/...` routes; `vaultId`, `serverInstanceId`; `mutationId` on every mutation; `sourceHash`, `diskHash`, hash format version; operation states (`accepted`, `pendingMaterialization`, `conflict`); per-vault monotonic SSE `eventVersion` plus `resyncRequired`; `apiVersion` and `buildId` response headers; search hit and overlay request DTOs (section 7); typed errors; old `X-Tansu-Vault` index routes answer a typed `api_version_unsupported`. DTOs and `docs/api.md` only, handlers return `not_implemented` until SRV/SEA/NET fill them. Proof: `make types-check`, `deno task typecheck`.

## P1: parity and completeness (up to five lanes, started together after G3)

**SRV, one lane, in this order**

- **S0 Repro.** A failing test for the watcher-delay race: an external write lands, then a save based on the old base arrives before reconciliation. Today `save_reconstructed_note` (`src/vault.rs:300-378`) checks only catalog state, then `write_visible_atomic` overwrites the file, so the external bytes are never snapshotted. Keep the test.
- **S1 Source format.** BOM and line-ending map; editor source (LF), disk bytes, parsed data kept separate; BLAKE3 `sourceHash` v3 and exact-byte `diskHash` v2; versioned snapshot reader keeps SHA-256 records readable without rewriting; invalid UTF-8 is unresolved and read-only; no-op open, index, and save never rewrite a file. Proof: corpus byte-identity tests.
- **S2 One accept path and durability.** Save, delta, rename, delete, restore, conflict restore, create, import share one precondition and durability path; reconcile the note's visible bytes before accepting (fixes S0); durable idempotency table keyed by `mutationId` (same payload returns the original outcome, different payload rejected); unique same-directory temp names, no-clobber create, atomic replace, file and directory sync (`src/history.rs:162-171` uses a fixed `name.md.tmp` today); operation intent plus verified snapshot-before-catalog ordering; explicit `pendingMaterialization`; startup repair classifies an unexpected visible file before acting; global unambiguous pairing for external moves (identical content never swaps IDs); vault-confined no-follow path checks for existing files and new parents. Fault-injection points: snapshot write, intent commit, catalog transition, file replace, directory sync, completion mark, event publish, response. Proof: interrupted-stage tests with restart and repair; stale-base, two-writer, occupied-path (case and Unicode), disk-full, permission, missing/corrupt-snapshot tests.
- **S3 Identity.** Durable `vaultId`/`serverInstanceId`; v2 routes live; state directories keyed by `vaultId` with a mapping from the old name-based layout (`src/config.rs:68,102`), old data preserved, backup-first, crash-safe marker; reject duplicate, nested, symlink-aliased roots and colliding state dirs; case/Unicode path policy consistent on macOS and Linux. Proof: reorder/rename tests; cross-vault ID tests; migrated-fixture byte comparison.

**SEA, one lane**

- **Q1 Vendor core.** `crates/tansu-search` from `ferrisearch-core` (`src/{index,schema,search,tokenizer,types}.rs`, 3,151 lines; tests are inline): drop `js_sys`, the non-`filesystem` branches, `f64` limits and timestamps, stringly fuzziness and recency; typed `SearchMode`, `Fuzziness`, checked integer limits and typed errors; UTF-16 offsets become explicit range types. Keep `LICENSE` (LGPL-3.0) and `UPSTREAM.md`. Port all 106 tests; run reference and port on one corpus, commit the goldens, log intentional differences. Proof: `cargo test -p tansu-search`.
- **Q2 Schema, semantics, ranges.** Schema: `noteId`, path, title, headings, supported tags, LF source, revision, `sourceHash`; no aliases or basename promised. Compact hits: identity, revision and `sourceHash`, title, path, score, bounded excerpt with highlight ranges, optional source-reveal range (half-open UTF-16 into the declared revision; excerpt-local and note-global ranges are distinct types; filename-only hits carry no offset). Semantics per section 7. Proof: relevance and range tests over accents, combining marks, emoji, surrogate pairs, tabs, frontmatter, repeated text.
- **Q3 Lifecycle.** Long-lived writer and reader; `commit_no_merge`; coalescing queue where the latest revision wins and a delete is never undone by an older upsert; overflow marks dirty and schedules bounded reconciliation; schema/analyzer version and watermark; one later upsert never clears an earlier degraded flag; reopen valid indexes on restart; rebuild into a sibling directory and swap; lazily opened writers. The save path never fails because of indexing. Proof: simulated-failure save test; clean-restart no-rebuild test. The `vault.rs` call-site switch is item I1 (INT, after SRV and SEA merge).
- **Q4 Quick-open and overlay.** `nucleo-matcher` over title/filename/path with exact, prefix, then subsequence priority, stable ties, explicit codepoint-to-UTF-16 mapping, pinned/recent for the empty query without touching Tantivy. POST search variant carrying bounded dirty-note snapshots (identity, base, local revision), evaluated with the same query code, never written to the index, stale canonical hits suppressed, partial-coverage notice when bounds are exceeded. Prereq: G3. Proof: overlay privacy and suppression tests.

**NET, one lane**

- **N1 Hyper transport.** Replace `src/http.rs` (thread per connection, `src/http.rs:141`) with the pinned futures-lite Hyper/H2 forks. Support HTTP/1 and HTTP/2 prior knowledge; reject h2c upgrades. Keep explicit header, body, duration, connection, and queue limits; incremental bounded body reads; bounded blocking pool separate from I/O; SSE with `eventVersion`, bounded replay or `resyncRequired`, subscription release on disconnect; cancellation stops admission and ends streams. Prereq: none (transport only; route layer unchanged until G3 lands). Proof: HTTP/1 and HTTP/2 transport tests plus oversized, slow, malformed, shutdown, and SSE lifecycle tests.
- **N2 `crates/tansu-webauthn`.** Vendor `webauthn-minimal` (one 909-line `lib.rs`; deps `base64ct`, `ciborium`, `graviola`, `serde`, `serde_json`, `tracing`) with `UPSTREAM.md`, then harden. Required changes, each with a negative test:
  1. `userVerification: "required"` in both option sets; both finish methods reject a missing UV bit.
  2. Finish methods validate outer `type == "public-key"`, `id` equals decoded `rawId`, and at registration equals the credential ID in authenticator data; authentication takes the permitted credential set and expected owner handle in the ceremony state and rejects a mismatched `userHandle`.
  3. COSE parser requires `kty=2`, `alg=-7`, `crv=1`, valid P-256 point at registration, duplicate map keys rejected, bounded input, exact consumed length, extension data handled by flags.
  4. Reject `crossOrigin: true` and any `topOrigin`; validate BE/BS combinations (BS without BE is invalid); store both flags in `StoredCredential`.
  5. Strict ASN.1 DER ECDSA only; remove the 64-byte raw `R||S` branch (`lib.rs:380`).
  6. Return a structured counter result; keep the highest observed counter; zero counters stay valid.
  7. Request attestation `none`; accept only `none`; reject `packed` and everything else (the current "structurally valid packed" check only tests for a CBOR map).
  Proof: `cargo test -p tansu-webauthn` (six upstream tests plus the negatives above, malformed CBOR and truncation tables with fixed seeds); `cargo check --target aarch64-unknown-linux-musl -p tansu-webauthn` (passed on the unmodified crate).
- **N3 Auth module.** Prereq: N1, N2, G3. First enrollment needs a one-time random capability created by an explicit CLI action (`tansu2 auth enroll`), hash-only at rest, expiring; later credentials need a recently verified session; no public first-visitor registration. Server-held ceremonies, expiring and atomically single-use (consumed in the same transaction that completes the ceremony, whatever the outcome). Opaque server-revocable sessions in an `HttpOnly; Secure; Path=/` host-scoped cookie; session-bound CSRF token plus strict `Origin`/`Host` validation against the configured external origin; no permissive CORS. Authorization on bootstrap, notes, search, revisions, conflicts, assets, SSE (open streams close on revocation or expiry). Auth state lives outside search and cache directories. Document that changing origin or RP ID invalidates credentials; local CLI recovery with backup. Proof: security tests in section 8.
- **N4 Assets and headers.** `deno task build` emits fingerprinted assets and a manifest into `web/dist/`; the binary embeds exactly that set; HTML shell revalidates, fingerprinted files are immutable; sensitive API responses `no-store`; CSP without inline script or `eval`; `X-Content-Type-Options`; asset MIME from an allowlist, never inline SVG/HTML; confined `z-images/` resolution through stable vault-scoped URLs; source maps not shipped. Proof: manifest and traversal tests; run from an unrelated working directory.

**EDT, one lane**

- **E1 Vendor and harness.** Vendor the Atomic closure under `web/ts/editor/vendor/atomic/` with its CSS and `UPSTREAM.md`; pin `@codemirror/{state,view,language,commands,autocomplete,lang-markdown}` and `@lezer/{common,highlight,markdown}` (resolve once; exactly one `@codemirror/state`); a fixture-only harness page built by the real esbuild pipeline. Proof: bundle has no `react`; one state instance.
- **E2 Adapter and sessions.** `createEditor` surface kept narrow: create/dispose, attach/detach session, focus, coherent snapshot (revision, UTF-16 selection, mode, scroll; source string cached by revision), selection reveal, undo/redo, mode reconfiguration through compartments (source mode is the same document, not a textarea), configuration update. One `EditorState` with history per open note, one mounted `EditorView`. Transaction origins distinguish load, mode change, external reload, user edit. Hard read-only rejects every mutation including task checkboxes (Atomic's checkbox dispatch bypasses `EditorState.readOnly`, `inline-preview.ts:296-302`), tables, image resize, drag/drop, paste, extension dispatches. A clean external reload resets history under an explicit policy; a dirty note is never replaced. No DOM serialization as a save source.
- **E3 Tansu extensions.** Wiki image `![[name]]` and `![[name|320]]` (not supplied by Atomic); callouts `> [!type] Title` with raw fallback; `[[target|label]]` resolved against the active vault only with explicit relative/root/basename rules and no arbitrary pick on ambiguity; image resize as one undoable transaction touching only that construct; source-preserving copy/cut and plain-text paste; table edits that change only the edited span; literal current-note find with smartcase and source reveal; outline from the syntax tree (fenced `#` is not a heading); tags edit as a bounded source edit; frontmatter stays source. Rich HTML paste goes through the sanitizing import path, never the save serializer.
- **E4 Cross-engine proof.** Playwright on Chromium, Firefox, WebKit: type/select/cut/copy/paste/undo across paragraphs, headings, fences, lists, tables; A to B to A undo isolation; repeated mode toggles; pointer selection held across a reveal boundary; wrap-boundary resize; IME composition and cancellation; combining marks and emoji; keyboard-only; hard-lock and revision-view mutation attempts; instrument parse/decorate/measure on a long note and name the synchronous whole-document work (`ensureSyntaxTree` runs in `inline-preview.ts:413`, `image-blocks.ts:130`, `table-widget.ts:1233`; decoration rebuild is whole-document, `inline-preview.ts:437`).

**APP, one lane**

- **A1 Document sessions.** A typed union per document: loading, clean, dirty, saving, conflict, unavailable/unresolved, auth-locked, with local and accepted revision counters. One in-flight save per note; later edits coalesce into a follow-up against the acknowledged base; an acknowledgment touches only the version it accepted; cancellation is never rollback (use `mutationId` to resolve uncertain sends); finite backoff only for classified transient failures; every response checks server, vault, note, and request generation. Pure TS with injected services; tests with fake clock and deferred promises.
- **A2 Recovery and workspace.** Three IndexedDB stores with separate eviction: clean cache (`web/ts/note-cache.ts`, key `["vault","noteId","contentHash"]` becomes `(serverInstanceId, vaultId, noteId, sourceHash)`), private workspace state, draft journal. Journal source and title drafts with identity, base revision and hashes, local revision, `mutationId`, selection, format version; coalesced typing writes, structural checkpoints, flush on visibility change. Clear only the matching local revision after a confirmed accept; never a newer record. Recovery against a changed server revision opens a conflict workflow. Storage failure keeps the live draft, offers source export, shows state, and never blocks server saves. One-time import of the old server-side session; per-browser tab order, pins, active note, selection, scroll, mode, search history. State plainly that IndexedDB is not encrypted and passkeys do not change that.
- **A3 Client v2.** Prereq: G3. `api.ts` rewritten for v2 with small tested decoders at every network and storage boundary (safe integers, ranges, versions); SSE client with resync; identity keys everywhere.
- **A4 Cutover.** Prereq: E2, A1, A2, A3, S1. Wire the adapter into sessions; delete `syncActiveDraft` and the frontmatter split/reassemble (`web/ts/app.ts:381`); virtual title and rename workflow with its own recoverable draft and conditional commit (Enter confirms, Escape cancels, a committed rename is not undone by body undo); unnamed first note stays a local journaled draft until a valid title is saved, then atomically takes the durable ID. Tab switch captures the outgoing snapshot before swapping state. Dirty-tab close waits for an accepted save or leaves a discoverable draft. Decompose `app.ts` and `view.ts` into mounted components (`update`/`dispose`, keyed nodes); editor DOM is opaque to the shell.
- **A5 Surfaces.** Prereq: A4. Slim tab strip (pinned, dirty, saving, conflict indicators), collapsible sidebar and outline, quick-open, vault search panel, current-note find, command palette, rename, recovery/conflict, revision view (hard read-only), settings (persistent-storage request at a user gesture), passkey enrollment and lock screens, and the states empty vault, unnamed draft, loading, server unavailable, auth lock, unresolved note, failed save. Panels never remount the editor; Escape restores focus and selection. Search panels prereq Q3, Q4: sequence responses and check generation; excerpts as text nodes plus highlight elements, never HTML; overlay hits in a labeled local-draft section; opening a hit checks `sourceHash` and requeries rather than applying a stale offset. Keymap: `Mod+P` quick-open, `Mod+K` commands, `Mod+Shift+F` vault search, `Mod+F` note find, `Mod+S` save, `Mod+Alt+N` new local note; do not intercept browser-reserved chords.
- **A6 Cut over assets and images.** Pasted and uploaded images tie insertion to the source session and revision, show progress, handle failure, never insert into whichever note is active at completion; object URLs and observers are released on dispose. Existing upload stays WebP into `z-images/`.

**I1 Integration (INT).** After SRV, SEA, NET land: switch `vault.rs` to the new search service; three-engine end-to-end run of open, edit, save, search, restart, conflict, rename, recovery. Then delete the retired editor engine files and DOM-model tests (reason logged per dropped test), so one production editor remains.

## P2: hardening

- **H1 (SRV)** Fault-injection and restart matrix from S2 completed; startup repair never overwrites new external content.
- **H2 (NET)** Security tests (section 8).
- **H3 (INT)** Docs: `architecture`, `api`, `editor` (required by `AGENTS.md`; the editor invariants change), `development`, `migration`, `configuration`, `performance`, `browser-support`, plus new `security` and `deployment` pages (loopback, Tailscale Serve private HTTPS, never Funnel, passkey enrollment and recovery, backing up both authored content and durable app state, rebuilding derived caches, rollback limits). Update the `AGENTS.md` invariants that changed (per-vault serialization stays; tags-only frontmatter stays). Document the filesystem coordination envelope and residual races honestly: a mutex and a pre-write recheck are not compare-and-swap against a non-cooperating writer.
- **H4 (NET)** Packaging: `make test-package` runs the release binary from an unrelated empty directory with temporary vault, config, data roots and no Node, pnpm, Deno, or `web/` on `PATH` or disk: open, edit, save, search, restart, repeat, with `~/d/ferrisearch`, `~/d/laputa-systems`, and Atomic checkouts unreachable. Linkage of both musl targets verified with the Dockerfile's `llvm-readelf -d | grep NEEDED` check. `tansu2 migrate --dry-run <copied-config>` report command and a backup-first migration. Release builds allowed.

## P3: optimization and polish (measurements now gate)

- **O1 Corpus and harness.** Generated corpora with fixed seeds: the checked-in fixture vaults, about 2,500 notes, 10,000 notes, plus 50 KB, 250 KB, 1 MB stress notes with tables, images, Unicode. Time gates run only when `perf-gate-ready` exits 0 and again with `-1` right after; an overlapped run is discarded; if the host stays busy write "perf gate deferred: host busy" and do not call D8 done. Prefer CPU time, min of N, interleaved baseline and candidate.
- **O2 Editor.** Targets in section 6. Optimize with maintained syntax and affected-range invalidation; no viewport-only rendering that leaves offscreen source unstyled or breaks selection.
- **O3 Search.** Targets and memory with one active and several idle vaults.
- **O4 Size.** esbuild metafile: raw, minified, gzip, per-module; no React/Solid/Effect; no duplicate CodeMirror; update `bench/budgets.json` to the measured bundle plus margin; stripped release size and cold start recorded for the selected search and runtime-neutral transport dependencies.
- **O5 Visual polish.** Light neutral canvas, system fonts, 16-17 px body, 1.55-1.65 line height, 70-80 character measure, one accent, CSS variables shared by shell and editor, `prefers-reduced-motion`, visible focus. Deterministic Playwright scenarios (fixed source, locale, clock, viewport, real ready state, decoded images) at 1024, 1280, 1440, 1920 px and 200% zoom for every surface in A5, plus long text, image-heavy text, a wide table, a long fence, a narrow window. Inspect screenshots at normal scale and crops before recording baselines; no baseline of broken output.
- **O6 Long session.** Repeated open/close/switch/edit/undo/search/image with delayed and failed requests; record DOM and editor instance counts, heap after a controlled idle point, subscriptions, server RSS, queue counts; look for sustained growth.

## P4: close (INT)

- **Z1** Delete what is dead (old engine, v1 routes and shims, unused deps, stale docs) and prove liveness per `dead-code-archaeology`.
- **Z2** Run `ultrareview`; fix P1 and P2 findings.
- **Z3** Full suites, final report.

Phase gates: each phase ends on the checks of the areas it touched; the full suite (`make ci` equivalent without `audit`: lint, coverage, three engines) runs at I1 (integration risk), end of P2, and Z3.

---

# Acceptance

| Deliverable | Proof (nothing waits on a person) |
| --- | --- |
| D1 | `deno task test`; `make test-e2e-chromium test-e2e-firefox test-e2e-webkit`; bundle has no `react`/Solid/Effect and one `@codemirror/state`; no normal save path calls HTML serialization; no file from the retired engine remains. |
| D2 | S0 test green; corpus byte-identity; interrupted-stage and restart-repair tests; two-writer test (one accepted, other draft preserved); lost-ack replay returns the original outcome; cross-vault ID and stale API version tests fail before mutation. |
| D3 | `cargo test -p tansu-search`; differential goldens; range tests; save-survives-index-failure; warm restart without full rebuild; overlay privacy. |
| D4 | Session and journal tests with fake clock, deferred promises, reordered responses, failed IndexedDB transactions, abrupt page termination after a confirmed checkpoint, lost responses, SSE reconnect; two contexts, two windows, identical paths in different vaults. |
| D5 | Every A5 surface has behavior assertions and a reviewed screenshot; panels do not remount the editor. |
| D6 | `cargo test -p tansu-webauthn`; security tests below; Chromium virtual authenticator registration and login. |
| D7 | `make test-package` green; `make build-linux-musl-docker` for both targets with no `NEEDED`; dry-run migration on copied fixtures. |
| D8 | Section 6 table recorded with corpus, hardware, build profile, browser versions, warm/cold; a miss is visible work, never a loosened target. |
| D9 | `UPSTREAM.md` plus license files in `crates/tansu-search`, `crates/tansu-webauthn`, `web/ts/editor/vendor/atomic`; docs list in H3 updated. |

Existing gates stay: no lowered coverage thresholds, no recorded broken visual oracle, no skipped required browser, no broad lint suppressions.

---

# Contract changes

**Pre-authorized** (list each made change for the owner at Z3): `/api/v2` routes and DTOs, `X-Tansu-Vault` index API retired; `sourceHash`/`diskHash` formats; additive catalog schema migrations behind a backup and crash-safe marker; state-directory relocation by `vaultId` with the old data preserved; new CLI (`auth enroll`, `migrate --dry-run`); new config keys (external origin, auth mode); `AGENTS.md` release-build clause; `docs/editor.md` rewrite; new crates and the dependencies named in this document (each justified in its commit body with build-time and binary-size impact).

**Forbidden:** rewriting visible vault bytes in a no-edit migration; hidden IDs in Markdown; widening V1 frontmatter beyond tags; dropping per-vault serialization without a tested design; weakening or adding a setting for the UV policy; an auth-off fallback when the auth module fails; lowering coverage gates; touching a real vault, config, or data directory; pushing; publishing.

---

# Non-goals

iPhone and touch layout, virtual keyboard, PWA, service worker, offline sync; collaboration or CRDTs; backlinks and vault-wide link rewriting (a rename leaves textual links unchanged; document it); remote-image localization; metadata beyond tags; legacy `images/` and HEIC handling; AI features, plugins, global cross-vault search; a client-side search index; attestation trust or enterprise identity; SolidJS, Effect, Axum, HTTP/2, embedded TLS; alias or tag-aliased search; a split preview, graph view, or ribbon. Drop ideas outside this list instead of queueing them.

---

# Reference

## 6. Targets and structural gates

Measured and logged from P1; gating in P3 on the reference machine. A missed target is visible work; keep absolute and baseline-relative numbers and do not loosen silently. No unexplained regression over 15% on retained paths.

| Operation | Target |
| --- | --- |
| 50 KB note, warm open to useful editor | p95 under 250 ms |
| Switch to a loaded unchanged note | p95 under 50 ms |
| Typing transaction, 50 KB / 250 KB / 1 MB | p95 main-thread under 8 / 16 / 32 ms |
| Quick-open, about 2,500 notes | server p95 under 10 ms |
| Exact/prefix full-text | server p95 under 15 ms |
| Representative fuzzy | server p95 under 100 ms |
| Exact search to painted results, loopback | p95 under 100 ms |
| Visible indexing after an acknowledged save, idle | normally under 500 ms |
| Journal checkpoint after a typing pause | normally under 250 ms |

Structural gates, always on: no full-document string materialization or hash per keystroke or caret move; no app-root or editor replacement for a status dot, search result, or title update; no forced full reindex on clean restart; no writer construction or force-merge per save; no full note body per search hit; no unbounded request, event, image, cache, or search queue; no large writer budget resident per idle vault.

## 7. Domain contracts

- **Identity.** Client keys are `(serverInstanceId, vaultId, noteId)` plus a browser/workspace id for private state. Paths are mutable metadata. Config reorder and vault rename never redirect a cache entry, SSE subscription, draft, or save.
- **Source.** Three separate things: editor source (LF, UTF-16 addressable, the whole file including frontmatter), disk bytes (exact UTF-8, BOM and EOLs kept), parsed display data (never replaces authored source). Never round-trip through HTML, a generic Markdown serializer, or a YAML emitter. Never trim or append a final newline unless the edit does. A normalized hash must not hide an external line-ending-only change (that is what `diskHash` is for). Legacy snapshots recover only the bytes they stored.
- **Mutations.** Every note mutation carries `mutationId`, base revision, base `sourceHash`, disk baseline, candidate, and intended metadata. A snapshot is complete before the revision that references it commits. Never report "saved to the vault" before the catalog and file steps finish; `pendingMaterialization` is an explicit state shown to the user. A stale base preserves both the submitted draft and the canonical version. Delta saves reconstruct the whole candidate from the exact base, check offsets (including split surrogates) and the final hash, then use the full-save path.
- **Residual races.** The application mutex and a recheck immediately before replace are not a universal compare-and-swap; a non-cooperating writer between the last check and the rename, or through an open descriptor, is not covered. Document it and recommend one concurrent writer for strict guarantees.
- **Editor.** CodeMirror owns document and transactions; the DOM is a view. Selection-only and appearance-only changes mark nothing dirty. Undo survives tab switch, pin, and rename; persistent undo across restarts is not required.
- **Recovery.** The guarantee is the latest successfully journaled checkpoint, not every keystroke. `pagehide` is opportunistic, not the mechanism. A denied persistent-storage request is not a failure and is not immunity from clearing. Sign-out or server-identity change locks the editor and follows an explicit retain/export/purge policy for drafts.
- **Search semantics.** All whitespace terms required; quoted multiword phrases are ordered adjacency and do not deduplicate words; single-word quotes become a term, empty quotes are ignored, an unclosed quote becomes terms. Shared analyzer for index and query. Exact/prefix first; fuzzy fallback only when sparse (5), expansion bounded by term length (terms of 3 or fewer bytes: none), fuzzy hits downranked, phrases never fuzzy. Recency is off by default and, if kept, tested for units at fixed ages. Score explanations are opt-in and off the normal path. Never expose a Tantivy `DocAddress`.
- **Overlay.** Private to the requesting session; request-scoped; never indexed, logged, or put in a URL.
- **Auth.** Exact RP ID and origin; fixed HTTPS origin in authenticated mode; Tailscale identity headers are not authorization; the counter result is policy, not proof of cloning.

## 8. Security test matrix (H2)

Forged or missing session; challenge replay, expiry, and two concurrent finishes of one ceremony (exactly one wins); wrong origin or RP ID; cross-origin iframe ceremony; invalid signature; malformed credential response; UV bit missing; `alg` other than -7; non-DER signature; CSRF; unauthorized enrollment (no capability, expired capability, replayed capability); revocation; assets, revisions, conflicts, and SSE after logout and on already-open streams after expiry; oversized and slow requests; encoded traversal; symlink escape and substitution; wrong-vault IDs; hostile Markdown, links, and assets. Virtual authenticators in Chromium plus crate-level fixtures; production checks stay on.

## 9. Verified code map (at `1ecf383`)

- `src/history.rs:11-14` canonicalizes to CRLF; `:26-37` hashes the canonical bytes; `:162-171` fixed temp name.
- `src/vault.rs:248-378` save, delta, and the shared accept path; no visible-bytes reread before a content-changing accept; `:754,786` assets only under `z-images/`.
- `src/http.rs:141` thread per connection; `:395-411` static files read from `web/` relative to the working directory.
- `src/config.rs:68,102` state directory is the vault name; vault selection by index (`docs/api.md`).
- `web/ts/note-cache.ts:94` key `["vault","noteId","contentHash"]`; `web/ts/app.ts:381` `syncActiveDraft`.
- Workflows: `.github/workflows/{ci,build-server}.yml`; `deny.toml` allows MIT, Apache-2.0, BSD, ISC, MPL-2.0, Zlib, Unicode-3.0, CC0.

## 10. Stack rationale (short)

Plain TS keeps the editor problem (document, selection, history) separate from rendering; Atomic's headless factories avoid a React island. Effect is not used because the Rust service owns the authoritative workflows; Rust DTOs plus `ts-rs` stay the wire-type source and boundaries get small decoders. SQLite holds durable identity, history relations, conflict drafts, and credentials, so the catalog is not "rebuildable"; Tantivy and thumbnails are. Hyper replaces hand-written framing because request framing and slow-client handling are not Tansu's product value.

## 11. Sources

Atomic `https://github.com/kenforthewin/atomic-editor/tree/b6ed65f01bde4510031bc7a495520bc1a7688c66` (`src/index.ts`, `AtomicCodeMirrorEditor.tsx`, `docs/architecture.md`); Ferrisearch `~/d/ferrisearch/crates/ferrisearch-core`, `docs/performance.md` (exact p50 about 3 ms, fuzzy 50-75 ms with score breakdown, 4-worker index 783 ms on 2,518 files); `~/d/laputa-systems/laputa/mirror/webauthn-minimal`; WebAuthn L3 `https://www.w3.org/TR/webauthn-3/`; Hyper `https://hyper.rs/guides/1/server/hello-world/`; Tailscale Serve `https://tailscale.com/docs/features/tailscale-serve`; nucleo-matcher `https://docs.rs/nucleo-matcher/`; CodeMirror `https://codemirror.net/docs/ref/`; browser lifecycle and storage `https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event`, `https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria`.

---

# Decision log

Append-only, one line per judgment call a reader would miss.

2026-10-14 | G1 | Ignore only `ENOENT` for entries that disappear during benchmark directory sizing; Tantivy atomically replaces index files while the measurement runs.
2026-10-14 | G1 | Keep the cache benchmark's nine samples; the overlong run was an unbounded wait for a filename missing from the copied fixture, not representative sampling work.
2026-10-14 | P0 | Start the campaign from the actual `a875868` checkout; the prepared `1ecf383` baseline exists as an ancestor but is not the checked-out commit.
2026-10-14 | G1 | Keep the root package as the only workspace member until the first crate lands; `crates/*` fails Cargo metadata when the directory has no members, and a placeholder crate would be dead code.
2026-10-14 | G3 | Keep `sourceHash` over LF editor source including a leading BOM, and `diskHash` over exact bytes, so line-ending-only external edits remain detectable.
2026-10-14 | G3 | Retain idempotency records for the life of vault state; a delayed retry must resolve to the original outcome after a client restart.
2026-10-14 | G3 | Apply dirty overlays as an ordered prefix capped at 20 notes and 2 MiB, then return a skipped count while still searching canonical notes.
2026-10-14 | G3 | Keep tabs, pins, and recents browser-local; only transient search requests carry unsaved source to the server.
2026-10-14 | G3 | Derive `resyncRequired` from the event update variant in a server-only constructor, so serialized events cannot contradict their update.
2026-10-14 | G3 | Cap search and quick-open queries at 1,024 UTF-8 bytes, results at 100, and excerpts at 512 bytes to bound request and response work.
2026-10-14 | G1 | Refresh block metadata after native input because Firefox could select a stale gutter id; two diagnostic full-suite runs also hit transient editor polling timeouts, while the final three-engine runs passed.
2026-10-14 | INT | Keep the seeded-image, delete-modal, and watcher assertions live while their APP and SRV integration defects remain. Do not replace those user flows with API-only checks.
2026-10-14 | INT | Publish watcher metadata only for added or changed notes, and report removals separately; a full-vault payload exceeded the SSE event bound and was converted into a resync.
2026-10-14 | INT | Construct paste events with an explicitly attached `DataTransfer`; Firefox ignores `clipboardData` in synthetic `ClipboardEvent` initialization.
2026-10-14 | N1 | Detect and replay the exact HTTP/2 prior-knowledge preface so Hyper enforces explicit H1 and H2 header limits without enabling h2c upgrades.
2026-10-14 | Z1 | Remove the retired contenteditable engine after V2 cross-browser workflow and CodeMirror source, selection, and paste coverage passed; move the large-note harness to the maintained adapter.
2026-10-14 | O3 | Limit four concurrent Tantivy writers to 15 MB each (60 MB total); each idle writer is still released after ten seconds.

# Campaign log

Append-only, one line per phase end.

2026-10-14 | P0 | `make check`, `make test` (588 TS, 51 Rust, 1 source corpus), `cargo test --workspace -q`, fixture immutability, and all browser suites passed (26 each); idle pre/post perf gates passed, with cold start 3,606.88 ms, editor interactive 91.22 ms, edit-save 39.65 ms, search 110.54 ms, bundle 135,387 B, large-note setValue 11,871.13 ms for 6,214,657 chars.
2026-10-14 | INT | Ported the server harness to V2 and added cross-engine lifecycle proof. The lifecycle and delta-edit cases passed in Chromium, Firefox, and WebKit. The full server browser file passed six of nine cases in each engine; all three runs exposed the seeded image render timeout, delete-modal close timeout, and external watcher event timeout.

## INT server browser test dispositions

The reference suite had 26 cases. Six server and UI cases remain. The delta-save and large-note cases now use V2. The lifecycle case adds cross-engine save, search, rename, restart, conflict, and recovery proof. These 18 cases asserted retired editor DOM or V1 routes:

| Reference case | Disposition |
| --- | --- |
| `keeps immediate typing after Enter in the visual editor` | The lifecycle case types after Enter and saves the exact Markdown in three browsers. It drops the old paragraph-host DOM check. |
| `preserves repeated blank lines across autosave` | The lifecycle case presses Enter three times and verifies the saved source. `web/ts/app.test.ts` covers V2 autosave. Old contenteditable line-box counts no longer apply. |
| `preserves blank lines inserted between typed paragraphs` | The lifecycle case verifies two blank lines between typed paragraphs. It drops the old `.app-editor` layout metrics. |
| `places the visual cursor after a real blank line when pressing Enter twice` | The lifecycle case types after repeated Enter presses and verifies the saved position in source. CodeMirror owns the cursor and document. |
| `moves through visible blank lines with arrow keys` | The test measured placeholder lanes in the old contenteditable DOM. CodeMirror owns arrow navigation and exposes document selections. `editor-session.test.ts` covers UTF-16 selection snapshots. |
| `source mode round trip preserves repeated blank-line geometry and markdown` | `editor-session.test.ts` verifies source mode keeps the same document and does not mark it dirty. The old textarea and placeholder geometry checks were removed. |
| `handles Enter at paragraph start, middle, and end through model transactions` | CodeMirror owns input transactions. The lifecycle case covers Enter at the end of a heading and preserves exact source. Old custom-model DOM assertions were removed. |
| `handles Backspace and Delete across text and blank-line boundaries` | CodeMirror owns Backspace and Delete behavior. The old test asserted mutations to placeholder paragraphs in the retired DOM model. |
| `applies visual block input syntax through model-backed rendering` | CodeMirror parses Markdown source directly. Markdown and extension tests cover rendered syntax. The old live-DOM model summary was removed. |
| `preserves blank lines when pasting multiline plain text and sanitized HTML` | `editor-session.test.ts` now checks multiline paste preserves empty lines and rich HTML passes through the sanitizer. |
| `adapts legacy editor typing and inline round-trip regressions` | Markdown round-trip and extension tests cover syntax preservation. The lifecycle case covers live CodeMirror typing and persistence. |
| `adapts legacy heading, list, and boundary regressions` | CodeMirror owns the source and selection. The lifecycle case enters a heading. Markdown tests cover heading and list syntax. Legacy DOM cursor-host checks were removed. |
| `adapts legacy autosave, reload, and double-newline loss regressions` | V2 app tests cover autosave. The lifecycle case verifies exact source after restart. Old randomized contenteditable editing sequences were removed. |
| `adapts legacy save and shortcut integration coverage` | The V2 UI case keeps the Meta or Control search and command shortcuts. The lifecycle case uses the V2 save shortcut. Old `/api/session` and `/api/notes` request checks were retired with those routes. |
| `covers lists, tasks, and undoable structural editing across the exposed markdown surface` | `editor-session.test.ts` checks a task checkbox changes Markdown in one edit. Markdown tests cover syntax. The old list and task DOM transformations were removed. |
| `pastes and resizes images through model markdown` | The V2 browser case covers asset upload and download, clipboard paste through the active vault, insertion, and save. `editor-source-operations.test.ts` covers image resizing. |
| `covers block gutter copy, range selection, replacement, delete, escape, and undo` | The CodeMirror adapter test covers copying and cutting authored source. The new editor has no legacy block-gutter control, so block-handle actions were removed. |
| `restores markdown and cursor through undo and redo checkpoints` | `editor-session.test.ts` covers independent per-note history. `web/ts/app.test.ts` covers tab selection and scroll restoration. Old DOM cursor markers were removed. |

The old exact-delta request test now exercises `PATCH /api/v2/vaults/:vaultId/notes/:noteId` with a revision precondition, UTF-16 range, and `sourceHash`. The large-note case keeps keyboard editing and V2 persistence, but drops its fixed 2.5-second limit because the campaign runs timing gates only on an idle host.

The startup image render, delete-modal close, and external watcher event assertions remain in the browser suite. APP and SRV integration fixes preserve those user flows. The browser file now passes all nine cases in Chromium, Firefox, and WebKit.

2026-10-14 | I1 | All nine V2 server browser cases passed in Chromium, Firefox, and WebKit, including open, edit, save, search, rename, restart, conflict recovery, revision restore, image paste, delta save, and watcher reconciliation.
2026-10-14 | P2 | Rust and TypeScript coverage passed unchanged gates (87.04%/84.75% lines/functions and 90%/88.88%); lint, typecheck, workspace tests, Chromium/Firefox/WebKit suites, auth virtual-authenticator checks, and package smoke passed. Both musl artifacts passed the no-NEEDED linkage check; x86_64 was rebuilt at the phase head and is 11 MiB stripped.

# For the owner afterwards

Read the Contract changes list the executor appends at Z3; the Decision log; the dropped-test reasons for the retired editor; the ferrisearch differential goldens' intentional-difference list; the `webauthn-minimal` hardening commits (consider upstreaming them to laputa); the unavailable-hardware list (real Safari, hardware authenticators). Cherry-pick from `campaign/desktop-redesign`.
