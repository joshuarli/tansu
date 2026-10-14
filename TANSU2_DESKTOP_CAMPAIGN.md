# Tansu2 desktop redesign campaign

**Status:** implementation directive, not a claim that the changes have been implemented or tested.  
**Prepared:** 2026-10-14.  
**Target:** the existing `~/d/tansu2` working tree.  
**Reference checkout:** `~/d/ferrisearch`, read-only.  
**Optional reference:** `~/d/tansu`, read-only; the campaign must remain executable without it.  
**Inspected Tansu2 revision:** `cf7a51274af7227a8be651080e4d911d80e393f2`. Work from the user's actual checkout, including subsequent changes; do not reset to this revision.  
**Inspected Atomic Editor revision:** `b6ed65f01bde4510031bc7a495520bc1a7688c66`, package version `0.6.2`.

## 1. Mission and execution authority

Evolve Tansu2 into an excellent **desktop browser Markdown workspace**: a quiet, polished writing surface, fast search derived from Ferrisearch, and a small, standalone Rust service over ordinary Markdown files. Preserve and strengthen the existing durable note identity, revision history, conflict handling, multiple-vault isolation, and external-file reconciliation. Replace the custom browser text-editing engine; do not rewrite the application as a greenfield product.

Execute the stages in this document autonomously and in order. Implement, test, inspect the actual browser output, correct regressions, and update the campaign ledger. Do not stop after a spike, scaffolding, a backend-only milestone, or a collection of skipped tests. A remaining blocker must be described accurately; never label a gated stage complete without its evidence.

The implementation is desktop-first. **iPhone layouts, touch interaction design, virtual-keyboard handling, PWA installation, service workers, and a full offline application are deferred.** Desktop Safari/WebKit remains a required browser target. Browser draft recovery is in scope because desktop crashes, refreshes, navigation, and network failures also lose memory-only drafts.

### Working-tree and scope rules

1. Read the current `AGENTS.md`, this campaign, and the named architecture/API/development/editor documents before changing code. Inventory local changes and preserve them. Do not overwrite or revert the recent TypeScript/tooling modernization.
2. Do not commit, push, publish packages, deploy, modify a real vault, change the user's Tailscale configuration, enroll real credentials, or run pre-commit hooks. These require separate user action. Use generated fixtures and temporary config/data directories exclusively.
3. Keep `~/d/ferrisearch` and any native Tansu checkout read-only. Vendored functionality must become ordinary tracked files inside Tansu2, never a symlink, submodule, machine-specific path dependency, or build-time download from the sibling checkout.
4. This campaign explicitly authorizes the scoped optimized builds needed for performance and packaging verification. Update the old blanket “no release builds” instruction to permit those gates only. It does not authorize publishing or distributing binaries.
5. Update architecture decisions before intentionally superseding old prototype constraints. In particular, draft recovery, passkey authentication, the new editor, source-format migration, and the replacement HTTP transport are explicit campaign scope, not accidental additions to the backlog.
6. Do not lower coverage gates, record broken output as a new visual oracle, skip a required browser to obtain green CI, or add broad lint/typing suppressions. Do not reintroduce the removed formatter or Knip merely because an old instruction mentions it.
7. Keep changes reviewable. Parallel implementation is allowed only on disjoint areas after their contracts are settled. One integration owner must reconcile DTOs, lifecycle semantics, migrations, and tests. Never let parallel workers independently redesign these boundaries.

Maintain `docs/campaigns/desktop-redesign/{status.md,decisions.md,evidence.md}`. Every stage records its changes, commands, results, artifact paths, unresolved issues, and deviations from this directive.

## 2. Prescribed stack and decisions

### 2.1 Keep plain TypeScript; do not introduce SolidJS in this campaign

Retain the current plain TypeScript application and modernized toolchain: pnpm installs dependencies; `deno task` runs commands; the current Node-based esbuild/Vitest/Playwright tools remain build/test dependencies, not production services. The inspected checkout pins TypeScript 7.0.2, esbuild 0.28.2, Vitest 5.0.4, and Playwright 1.64.0. Preserve the checkout's newer pins if they have advanced. [R1]

SolidJS 2.0 is still a release candidate in the research snapshot (`2.0.0-rc.15` appears in the release list). More importantly, a UI framework would not solve the editor's document, selection, history, or persistence problems. Atomic provides independently exported CodeMirror extension factories, so its React wrapper is not a mandatory integration boundary. [R4][R6]

Do not install SolidJS 1.x as a substitute, a signals library, React, Preact, a JSX compiler, or a meta-framework. Use explicit mounted view components with `update` and `dispose` operations, stable keyed DOM nodes, typed events, and small purpose-specific controllers. Do not implement a general reactive framework, virtual DOM, dependency-injection container, or homemade fiber scheduler.

Reconsider a view framework only in a later campaign if measured maintenance problems remain after isolating the editor and decomposing the existing render path. That is not a decision the implementation agent should reopen now.

### 2.2 Do not introduce Effect 4

Effect 4.0 was released on September 30, 2026; rejecting it as an unstable beta would be factually wrong. Its typed errors, resource lifetimes, and structured concurrency are useful capabilities. [R7]

Nevertheless, do not introduce it here. The Rust service already owns the authoritative filesystem, catalog, history, and indexing workflows. The browser needs a bounded set of document-session operations, network requests, a recovery journal, and one event subscription—not another application-wide runtime. Preserve native promises, `AbortController`, explicit cleanup, discriminated unions, and dependency injection through the existing `AppServices`-style seam. These choices are architectural scope control, not a claim that Effect is slow or intrinsically bloated.

Do not introduce Effect Schema alone, or port domain types through several parallel schema systems. Rust DTOs plus `ts-rs` remain the wire-type source of truth. Validate untrusted network/storage data at boundaries using small, tested decoders; generated TypeScript declarations alone are not runtime validation.

### 2.3 Use CodeMirror 6 and Atomic's framework-independent implementation

Use CodeMirror 6 as the editing substrate. Vendor the **framework-independent Atomic modules and required CSS** at the inspected revision into `web/ts/editor/vendor/atomic/`, retaining its MIT license and provenance. Compose them through a Tansu-owned imperative adapter.

This second, narrow vendoring boundary is intentional. Atomic's package root also exports its React component and declares React peers. Vendoring the small headless implementation avoids depending on undocumented package deep imports, shipping an unnecessary React island, or depending on a bundler to eliminate every React path. Do not copy its demo, application shell, React component, package-lock, entire development toolchain, or unrelated language grammar registry. CodeMirror and Lezer remain normal pinned dependencies, with exactly one resolved instance of their state/view packages. [R3][R4]

The Atomic React wrapper is a **reference for extension composition**, not a template for Tansu's session lifecycle. It remounts on document identity changes; Tansu must preserve per-open-document state and history instead. The wrapper also materializes the Markdown string on every document-change callback; Tansu should not copy that hot path blindly. [R5]

### 2.4 Vendor Ferrisearch's native Rust functionality

Create an in-repository workspace crate, `crates/tansu-search/`, derived from `~/d/ferrisearch/crates/ferrisearch-core`. Keep provenance for the copied source and tests. Adapt it for Tansu's note identities, versions, schema, compact result DTOs, and server lifecycle.

Do not import the Obsidian plugin, N-API layer, WASM build, WASM blob persistence, JS-oriented numeric types, plugin settings UI, or sibling repository build scripts. The server calls the Rust crate directly. Tantivy remains an ordinary pinned Cargo dependency with only the needed features.

**License finding:** the inspected Ferrisearch repository contains an LGPL-3.0 license, not MIT. Preserve applicable copyright and license notices and record file provenance. Inspect the local checkout for more-specific file/crate notices; do not invent a permissive relicensing grant based on repository ownership. Include the applicable license texts and a redistribution review note with packaging. No binary distribution is part of this campaign. [R8]

### 2.5 Keep the storage engine; replace custom HTTP framing

Retain SQLite for the durable catalog/history metadata and Tantivy for disposable full-text search. Do not substitute one for the other or call the catalog rebuildable without qualification. Markdown and attachments survive catalog loss, but durable IDs, history relationships, conflict drafts, and credentials do not necessarily survive it.

Preserve the synchronous Rust vault operations and per-vault serialization. Replace handwritten HTTP framing in `src/http.rs` with **Hyper 1.x HTTP/1 server support and narrowly enabled Tokio runtime/net/sync/time support**. Use Hyper's service function with the existing route/DTO layer; no Axum, application framework, HTTP/2, WebSocket framework, or embedded TLS server is needed. Bounded blocking workers handle filesystem/SQLite operations; CPU-heavy search must not run on an async I/O worker. [R12]

This is a deliberate correction to the earlier “keep the tiny handwritten server” recommendation. A simple deployment should not entail owning request-framing correctness, slow-client handling, and stream cleanup. The current backend's simplicity is worth preserving; its HTTP parser is not part of the product's differentiating value.

Production remains one Rust binary, with frontend assets embedded, binding to loopback and optionally exposed through Tailscale Serve HTTPS. Tailscale Serve is a separate deployment prerequisite, not bundled into Tansu2. [R13]

### 2.6 Authentication and auxiliary libraries

Implement optional single-user passkey authentication with the maintained high-level `webauthn-rs` API, not handwritten WebAuthn/CBOR/signature verification. Pin the selected compatible release and record its actual crypto/native dependency closure, including anything needed for musl builds. Do not conceal this cost or weaken authentication to reduce binary size. [R14]

Use `nucleo-matcher` for server-side quick-open subsequence matching, restricted to note metadata; it solves a different matching problem from Tantivy's edit-distance full-text fallback. Its offsets are not JavaScript UTF-16 offsets: explicitly map them. Do not add a client-side full-vault search index. [R15]

For HTTP implementation, use Hyper with `default-features = false` and its `server`/`http1` features, `hyper-util` only for the Tokio I/O adapter, and `http-body-util` for bounded body/stream composition. Enable only needed Tokio features such as `rt-multi-thread`, `net`, `sync`, and `time`; do not select `full` as a convenience. Keep the existing Tantivy 0.26 line unless a demonstrated compatibility/security issue requires a scoped upgrade. The WebAuthn API documentation inspected was 0.5.5; resolve and lock a compatible supported release once at implementation start, recording any change from that baseline. Pin all newly introduced direct frontend dependencies and retain the corresponding lockfile changes in the working tree; do not make a Git commit.

No Node/Deno service, external database process, hosted search, CRDT, vector database, AI features, plugin system, cross-vault global search, or collaboration engine is in scope.

## 3. What the repository already gives us

The inspected Tansu2 revision already has durable `noteId` values, mutable paths, a SQLite catalog, compressed snapshots, base-sequence/base-hash saves, exact delta transport, conflict drafts, multiple configured vaults, SSE, generated TS DTOs, and a clean-note IndexedDB cache. Its editor uses a source model rather than treating rendered DOM as authoritative. Preserve these useful contracts while replacing implementation details. [R1][R2]

Important implementation findings to address rather than reproduce:

- `src/history.rs` canonicalizes persisted source and history to CRLF. A browser editor that preserves its LF buffer does not, by itself, preserve disk bytes. [R2]
- `save_reconstructed_note` checks the submitted base against catalog state, then writes the visible file. The inspected path does not generally reread visible bytes before accepting the normal content-changing save. Test the external-write-before-watcher-reconciliation case; do not assume the catalog proves disk freshness. This is a source-inspection finding, not a claim that a race reproduction was run during preparation. [R2]
- Ferrisearch has a reusable long-lived writer/reader and exact/prefix-first, sparse-results fuzzy fallback. Its native writer currently uses four workers with a 120 MB indexing budget. Do not multiply that budget across many idle vaults without measuring. [R9]
- Ferrisearch's schema carries some stored-only or inactive fields, including aliases/basename/tag-related fields. Do not promise alias or tag matching merely because a DTO has those fields. Define the new schema and test actual retrieval. [R9]
- Atomic's current preview implementation has full-document syntax coverage work and decoration rebuild paths. Its use of CodeMirror is not proof that all its extensions are incremental or meet this application's latency targets. Measure and patch specific problems. [R3]
- Atomic “reading mode” permits checkbox toggles. This is not a security lock or immutable revision viewer. Tansu needs a separate hard read-only policy. [R5]

## 4. Target architecture and ownership

```text
Desktop browser
  application shell and mounted UI components        plain TypeScript
  document sessions and recovery controller          plain TypeScript
  one active EditorView / per-open-note EditorState  CodeMirror 6
  live-preview presentation                         vendored Atomic + Tansu extensions
  workspace + recovery journal + clean cache         IndexedDB
             |
       same-origin HTTP + SSE
             |
Loopback Rust service
  HTTP framing / bounded request execution           Hyper + narrowly configured Tokio
  auth / sessions / origin checks                    Rust, webauthn-rs
  vault mutations / reconciliation / history         existing Tansu2, hardened
  full-text search                                  in-tree tansu-search / Tantivy
  quick-open metadata matching                       in-tree tansu-search / nucleo-matcher
             |
  ordinary Markdown + attachments                    authoritative authored content
  durable catalog / snapshots / conflicts / auth      application state requiring backup
  Tantivy index / derived thumbnails                  rebuildable caches
```

Suggested code map; preserve existing names where moving them would create gratuitous churn:

```text
crates/tansu-search/
  Cargo.toml
  UPSTREAM.md
  LICENSES/
  src/{lib,index,schema,query,tokenizer,matches,quick_open,types}.rs
  tests/
web/ts/editor/
  editor.ts                 Tansu adapter / one integration surface
  editor-session.ts         CM state, revision, selection, scroll, source mode
  extensions/               vault images, callouts, source reveal, hard lock, etc.
  vendor/atomic/            upstream modules + license + provenance + patch notes
  tests/
web/ts/app/
  document-sessions.ts      open/close/activate/save/reconcile policy
  save-controller.ts        one in-flight save per note, exact snapshot ownership
  recovery-journal.ts       durable draft records, not a sync framework
  workspace-store.ts        per-browser/workspace navigation state
  search-controller.ts      request sequencing and draft overlay orchestration
  events.ts / services.ts   existing seams retained and extended
web/ts/ui/                  mounted desktop components; editor DOM is opaque
src/
  vault.rs / catalog.rs / history.rs / reconcile.rs / paths.rs
  search.rs                 app-to-tansu-search integration
  http.rs / api.rs / api_types.rs
  auth.rs                   single-user auth and challenge/session storage
  assets.rs                 confined asset serving and optional derivatives
  embedded_assets.rs        generated asset mapping, not a runtime filesystem walk
```

Do not split every module into a separate crate. A local search crate and the existing server crate are sufficient unless a demonstrable build/test boundary requires more.

## 5. Non-negotiable domain contracts

### 5.1 Identity and vault isolation

Use a durable `vaultId` independent of config order, vault display name, and machine-specific path. Use durable `noteId` within that vault; retain existing note IDs. All client identity keys are `(serverInstanceId, vaultId, noteId)`, extended with a browser/workspace identifier where state is private. A regenerated unrelated server must not accidentally reuse the cache namespace of an old server.

Paths are mutable filesystem metadata. They are not note IDs, auth grants, or a substitute for vault selection. Config reordering and vault renaming must not redirect a cache entry, SSE subscription, draft, or save into a different vault.

Migrate the old index-based vault API and name-based data layout conservatively. Preserve old data and a migration mapping; never silently assign existing application state to a different root. Reject duplicate physical roots, overlapping/nested roots, unsafe symlink aliases, and colliding state directories. Make case/Unicode path policy explicit and consistent across macOS and Linux. Do not silently rename conflicting user files.

### 5.2 Source representation and hash versioning

The full note source—including frontmatter—is authored content. Do not round-trip it through rendered HTML, a generic Markdown serializer, or a YAML emitter during open/save. Do not strip and reconstruct tags-only frontmatter on every editor snapshot.

Define three separate concepts:

- **Editor source:** a LF-normalized UTF-16-addressable string containing the complete Markdown document.
- **Disk bytes:** exact UTF-8 bytes, with the original BOM and line-ending representation retained where applicable.
- **Parsed/display data:** titles, headings, tags, previews, decorations, and excerpts. These never replace authored source.

Use versioned logical source hashes and exact disk-byte hashes. Name them distinctly in Rust and the wire API (`sourceHash` and `diskHash`, with an explicit format/hash version). The source hash is useful for editor revisions and search-range validity; the disk hash is needed for byte identity and external-change detection. A normalized source hash must not hide an external line-ending-only change.

Requirements:

1. Merely opening, closing, indexing, changing view mode, moving the cursor, or requesting a no-op save does not rewrite a Markdown file.
2. Unchanged files retain exact bytes, including BOM, mixed line endings, blank lines, escape spelling, Markdown delimiters, and unsupported frontmatter.
3. For edited files, preserve the newline spelling of untouched lines using a line-ending map. Newly inserted boundaries use the file's recorded preferred convention; new files use LF. Define deterministic behavior when an edit joins/splits lines. Never trim or append a final newline unless the edit requests it.
4. Invalid UTF-8 is unresolved/read-only and never silently decoded with replacement characters and saved back.
5. Existing history hashes were computed under the legacy canonicalization policy. Introduce a versioned snapshot reader; do not reinterpret old hash strings under a new algorithm or rewrite historical snapshots in place.
6. Legacy snapshots can only recover the bytes they actually stored. Do not claim to reconstruct pre-canonicalization originals that are no longer present.
7. A no-edit migration preserves all visible vault bytes. Materialize new baseline metadata/history only in application state, with backups and a crash-safe migration marker.

### 5.3 Title policy

Adopt the native Tansu-style **filename-derived virtual title** for the workspace. The title is presented above the writing surface but is not inserted into Markdown. An existing H1 stays exactly where it was in the document and remains searchable as a heading. Do not delete, deduplicate, or rename files based on H1 contents during migration.

Editing the virtual title is a **rename operation**, not a Markdown-body edit. Give it its own recoverable draft and conditional commit; Enter confirms, Escape cancels. The text field has ordinary focused text undo. A successfully committed rename is not undone by the body's `Cmd/Ctrl-Z`. This is an intentional simplification of native Tansu's combined title/body edit semantics, preventing the browser editor's undo stack from secretly performing filesystem operations. Document it explicitly.

A first unnamed note may remain a journaled local draft without creating a file. First save requires a valid nonempty title, creates a collision-safe file, obtains a durable ID, and atomically transfers the local draft/session identity. Existing titled notes autosave. Never create a parade of empty `Untitled N.md` files merely because a user opened and abandoned a new tab.

### 5.4 Durability, optimistic concurrency, and external edits

Keep each accepted content revision fully recoverable. Keep per-vault app mutations serialized. Add idempotent mutation identifiers so a lost HTTP response followed by retry does not create a second revision, a second note, or a duplicate conflict draft.

All mutating paths—save, delta save, rename, delete, restore, conflict recovery, create/import, and relevant asset operations—must enforce their applicable preconditions. Before accepting a note mutation, reconcile that note's actual visible state rather than waiting for a watcher event. A stale base must not overwrite a newer accepted or already-observed external version. Preserve the submitted draft and the canonical version independently.

Use a durable operation intent plus verified snapshot/catalog transitions to make interruptions recoverable. Write a complete snapshot before committing a revision that references it. Publish the ordinary file with a unique same-directory temporary file, appropriate no-clobber semantics for creation, atomic replacement for updates, and file/directory synchronization according to the supported platform's guarantee. Fixed `filename.md.tmp` scratch names are not acceptable.

Do not call a revision “saved to the vault” before its required durable/catalog/file steps have succeeded. If a revision is committed to recoverable server history but visible-file materialization is pending, return an explicit operation state and display that distinction; do not answer with a generic failure that encourages blind replay or with a false all-clear. Startup repair must not overwrite genuinely new external content merely to make the catalog appear consistent.

**Filesystem limit:** an application mutex and a pre-write hash check are not a universal compare-and-swap against arbitrary external programs. Specify and test the actual supported coordination envelope. Fix the ordinary watcher-delay race and recheck immediately before replacement; use stronger platform primitives where appropriate. Do not claim an absolute guarantee against a noncooperating process writing between the final check and replacement, or through an already-open descriptor. Record residual races and recommend a single concurrent writer for strict guarantees. Do not hide this limitation behind optimistic language.

### 5.5 Editor state, undo, and source mode

CodeMirror's document/transactions own editing. The DOM is a view. Keep an independent `EditorState` with history for every open, loaded note; mount one active `EditorView`. Tab switching stores the outgoing state and installs the incoming state without converting the note through HTML or replacing one document with another inside the old note's history.

The adapter exposes a coherent snapshot with source revision, source text when requested, selection anchor/head in UTF-16 units, view mode, note identity, and scroll state. A source-string materialization can be cached by revision. Selection-only or appearance-only changes do not mark a note dirty or trigger full-document hashing, serialization, autosave, or indexing. [R18]

Source mode reconfigures the same document with CodeMirror compartments; it does not open a textarea with a second independently owned buffer. Switching modes preserves text, selection, undo/redo, and scroll as far as the changed layout permits. In-memory undo survives tab switches, pinning, and renaming; persistent undo across browser restarts is not required.

A clean external reload is a new external baseline, not a local user undo entry. Safely reset/rebase its history under an explicit policy so old undo cannot silently restore another writer's removed content. A dirty note is never replaced by an external reload, save acknowledgment, cache hit, or late open response.

Hard read-only is separate from presentation reading mode. Auth locks, unresolved files, revision previews, and protected operations reject **all** user mutations, including task checkboxes, table commands, image resize, drag/drop, paste, and custom extension dispatches.

### 5.6 Recovery is not offline synchronization

Keep three distinct browser stores: disposable clean content cache; private workspace state; recoverable unsaved draft journal. Do not mix their eviction rules or describe all three as disposable caches.

Journal source and title drafts with identity, base revision/hashes, local revision, mutation ID, selection, and format version. Use IndexedDB transactions and record completion. Coalesce ordinary typing writes briefly, checkpoint structural edits, and opportunistically flush on visibility transitions. A shutdown callback is not the primary persistence mechanism. The guarantee is recovery of the latest successfully journaled checkpoint—not impossible guaranteed persistence of every keystroke during sudden process termination. [R16]

Never clear a newer journal record when an older save succeeds. A draft can be cleared only after the matching local revision has a confirmed accepted server result, and no later draft supersedes it. Recovery against a changed server revision must create a conflict workflow, never unconditional overwrite.

Browser storage can be unavailable, exhausted, cleared, or evicted. Feature-detect and offer/request persistent storage at an appropriate user interaction, but do not treat a denied request as an application failure or promise immunity from user data clearing. Display storage failure without discarding the live draft; offer source export and keep normal server saving operational. Browser persistence does not provide encryption at rest, and passkey login does not encrypt IndexedDB. State that clearly in settings/security documentation. [R17]

## 6. Stage 0 — establish a trustworthy baseline

**Goal:** understand the actual updated checkout, preserve user work, and make later comparisons meaningful.

Read:

- `AGENTS.md`, `deno.json`, `package.json`, `pnpm-lock.yaml`, `Makefile`, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, and the browser installation wrapper.
- `docs/{architecture,api,development,editor,performance,browser-support,fixtures,migration}.md`.
- `src/{vault,catalog,history,reconcile,search,paths,config,http,api_types}.rs`.
- `web/ts/{app,state,view,api,note-cache,save-delta,markdown-tags}.ts`, current app services/events, and the editor integration surface.
- Ferrisearch's core source, tests, Cargo manifests, license files, and `PERF.md`.

Record repository HEADs, local modifications, compiler/runtime/browser versions, package graph, production frontend size, and existing test/benchmark results. Confirm the current TS changes rather than assuming they are only version upgrades. Preserve Deno task dispatch, explicit dependency pins, the absence of unnecessary format tooling, and generated DTO discipline.

Use isolated fixture config and app-data directories. Record hashes of the fixture originals, then operate on copies; do not mutate the checked-in reference vault during a test. Add an easy-to-audit guard preventing test servers from using the real config/data directory.

Run the existing checks before changes. Prefer nonmutating forms: `deno task lint`, `deno task typecheck`, `make types-check`, `cargo check`, `cargo clippy --all-targets` without `--fix`, `make test`, and the documented browser suite. The current Makefile may contain auto-fixing lint targets; do not use those as a supposedly read-only baseline check.

Create fixtures for repeated/leading/trailing blank lines; LF/CRLF/mixed EOLs and BOM; unsupported/mixed frontmatter; Unicode and emoji; duplicate titles; identical note content; nested folders; both attachment directories; large source; corrupt/missing snapshots; and stale saves. Source samples should include escaped delimiters, code fences containing apparent headings, lists with unusual valid indentation, tables, links, callouts, and wiki embeds.

**Gate 0:** a reproducible baseline report, known existing failures classified separately from new regressions, an immutable source-fidelity corpus, and documented stack/provenance decisions. No mandatory dependency on another developer checkout is introduced.

## 7. Stage 1 — prove the editor boundary before the broad UI rewrite

**Goal:** demonstrate that headless Atomic plus CodeMirror can host Tansu documents without React, source damage, session leakage, or unacceptable desktop behavior.

Vendor the selected Atomic source closure and CSS. Add `UPSTREAM.md` with upstream URL, commit, package version, license, imported paths, source hashes, local patches, and a documented manual update procedure. Maintain a clear boundary between unchanged upstream files and Tansu integration code. A small, reviewable patch to an upstream module is allowed when configuration hooks cannot express the required behavior; record it and port/add the relevant test.

Start with the upstream `inlinePreview`, `highlightMarkdown`, `tables`, `imageBlocks`, theme/syntax helpers, editing helpers, and their transitive module closure. Include wiki-link support only through explicit Tansu resolution policy. Do not assume `![[asset|width]]` support is supplied by ordinary Markdown image handling.

Build a fixture-only development harness using the real Tansu esbuild pipeline. Compose `EditorView`, `EditorState`, history/keymaps, GFM Markdown parsing, and Atomic extensions. Reproduce the needed composition from the React wrapper, not its React lifecycle. Initially mount one document; then add the two-document state-switching harness.

Implement the adapter's essential operations: create/dispose, attach/detach session, focus, coherent snapshot, selection/reveal, undo/redo, mode reconfiguration, read-only policy, and configuration update. Use explicit transaction-origin annotations so loads, source-mode changes, external reloads, and user edits are distinguishable. Export no DOM serialization routine as an autosave source of truth.

Test in Chromium, Firefox, and desktop WebKit:

- Type, select, cut/copy/paste, undo/redo, and select across paragraphs, headings, fences, lists, tables, and hidden delimiters.
- Switch A → B → A, then undo in A. Neither B nor A's history should be lost or contaminated.
- Toggle source/live-preview mode repeatedly without changing source bytes at the normalized-model boundary.
- Hold a pointer selection across a reveal boundary and release outside the editor; selection must not collapse or leave the preview permanently frozen.
- Resize the window near line-wrap boundaries. Do not assume hidden markers cannot affect wrapping merely because line-height is fixed.
- Exercise IME composition, combining marks, emoji, keyboard-only operation, copy from a source range, and composition cancellation.
- Attempt task/table mutations while hard-locked and while viewing a historical revision.
- Open a long note and instrument parse/decorate/measure work. Identify synchronous full-document work rather than attributing all performance to CodeMirror.

Do not tune an entire desktop theme before this passes. Do not require mobile interaction tests here. Do not replace a failing Atomic path with a new handwritten contentEditable engine; fix the isolated extension, use a safe raw-source fallback for genuinely unsupported syntax, and keep the same CodeMirror document.

**Gate 1:** the production dependency graph and emitted bundle contain no React/Solid/Effect; the harness works across all three desktop engines; source/session tests pass; identified extension gaps have concrete implementation tests. The report distinguishes automated WebKit coverage from a real desktop Safari smoke test when the latter is unavailable.

## 8. Stage 2 — harden storage, identity, and source migration

**Goal:** make the retained backend a trustworthy foundation before wiring the new editor into normal saving.

Implement the contracts in section 5. Introduce durable vault/server identities, a versioned source-format layer, and migration metadata. Preserve existing `noteId`s and historical revision chains. Do not rebuild the durable catalog simply because the derived search schema changes.

Centralize note read/accept/materialize/reconcile operations. Do not leave independent correctness rules in PUT, PATCH, restore, import, and rename paths. Delta saves remain a transport optimization: reconstruct the entire candidate from its exact base, validate positions and final logical hash, and use the same full-snapshot acceptance path as full saves.

For every mutation capture an immutable operation identity, base revision, base logical hash, applicable disk baseline, candidate content, and intended metadata change. Add a durable uniqueness constraint for mutation IDs and verify that replay with a different payload is rejected. A successful retry returns the original operation outcome. A stale retry must not become a silent overwrite.

Add deterministic fault-injection points around snapshot write/sync, intent commit, catalog transition, visible-file replacement, directory sync, completion marking, event publication, and response delivery. Exercise process termination, restart, and repair on fixture data. A repair operation must classify an unexpected visible file before taking action.

Path operations must be vault-confined through filesystem-aware checks, not merely string checks for `..`. Reject unsafe symlinks and path aliasing; use handle-relative/no-follow operations where supported. Validate asset paths separately from Markdown paths. Check containment for existing files and for the parent of a newly created path. Recheck after path-changing operations; an initial canonicalization is not protection against subsequent symlink substitution. Document any remaining local-malicious-writer limits.

For external rename matching, only preserve identity on an unambiguous **global** pairing of missing tracked notes and newly found files. Duplicate identical notes must not have their identities arbitrarily swapped by first-match iteration. An ambiguous moved-and-edited file is delete/new or unresolved according to the documented policy, never a similarity-based guess.

Add explicit API revision/version handling. Prefer routes scoped by stable identity, for example `/api/v2/vaults/:vaultId/notes/:noteId`; update the generated DTOs and all callers together. Old clients must receive a clear incompatible-version response instead of misinterpreting new hashes or vault selectors.

Required tests include:

- No-op migration/open/save preserves exact visible bytes and metadata that should not change.
- Historical v1 snapshots remain readable after v2 writes, and a legacy restore produces a new revision without rewriting history.
- A fixture file changes externally while watcher processing is paused; a save based on the old version preserves both sources and reports conflict.
- Two browser writers save the same base; exactly one revision is accepted, the other draft survives.
- Create/rename into an occupied path never clobbers it, including same-case-key and Unicode collision cases.
- Same content appearing in several paths does not cause arbitrary identity reassignment.
- Invalid UTF-8, missing/corrupt snapshots, permission failures, disk-full simulation, and interrupted materialization remain visible and recoverable.
- Cross-vault IDs, stale API formats, malformed deltas, split-surrogate offsets, and invalid hash/version pairs fail before mutation.

**Gate 2:** byte-preserving migration on copied fixtures; deterministic recovery tests; every mutation shares the precondition/durability policy; all residual external-writer limitations are stated accurately.

## 9. Stage 3 — vendor and integrate Ferrisearch properly

**Goal:** reuse the real search implementation, not just the Tantivy dependency name.

### 9.1 Vendoring and API cleanup

Copy the needed Rust source/test closure into `crates/tansu-search`; record the actual local Ferrisearch HEAD and local modifications used. Retain applicable notices. Remove the native/WASM conditional split when only the native path remains, except for test-only in-memory construction where useful. Remove N-API/JS compatibility artifacts: floating-point limits and timestamps, stringly typed fuzziness levels, unused settings, and exports with no server consumer.

Use checked integer limits, typed `SearchMode`/`Fuzziness`, explicit field boosts, and monotonic version metadata. Reject unreasonable queries and result counts with typed errors; never let client values become unbounded allocations or unchecked float-to-integer conversions.

### 9.2 Schema and source ranges

A per-vault index should include durable note ID, mutable path/title, headings, tags actually supported by Tansu2, raw LF-normalized source, current revision, and logical source hash. Index title/headings/body with explicit weights, initially matching Ferrisearch's 10/5/1 emphasis unless a fixture-backed relevance decision changes them. Path metadata is available for quick-open and filtering. Do not carry unused aliases into the public UI; either implement and test a clearly sourced alias policy later or omit it now.

Retain source-preserving offsets. The simplest correct body representation is the raw normalized Markdown source. Heading extraction can build a separate search field with mappings back to that same source. Human-friendly excerpts may omit delimiters for display only if their displayed spans retain a map to original source positions.

Return compact hits: identity, revision/source hash, title/path, score, bounded plain-text excerpt, excerpt highlight ranges, and optional source-reveal range. Do not return whole note bodies for every result. A filename-only hit must not invent a Markdown source offset. Never expose a Tantivy `DocAddress` as durable identity.

All browser-facing source ranges are half-open UTF-16 code-unit ranges into the exact declared logical source revision. Excerpt-local ranges and note-global ranges are distinct types. Test accents, combining marks, emoji, surrogate pairs, tabs, frontmatter, escaped markup, and multiple identical text occurrences. Convert nucleo codepoint/grapheme-oriented indices explicitly rather than treating them as UTF-16 offsets.

### 9.3 Query semantics

Preserve Ferrisearch's useful behavior deliberately:

- Whitespace terms are all required; quoted multiword phrases require ordered adjacency. Do not deduplicate words inside a phrase (`"very very good"` is not `"very good"`).
- Single-word quotes become a term; empty quotes are ignored; unclosed quotes have a documented forgiving interpretation.
- Query analysis and indexing share normalization. Test punctuation, CamelCase, Unicode case/diacritics, and token boundaries instead of applying unrelated regex normalization on either side.
- Run exact/prefix matching first. Use a fixed sparse-results threshold of five for the normal fuzzy fallback, independent of requested result limit.
- Bound fuzzy distance by term length, with no fuzzy expansion for very short terms. Start with Ferrisearch's tested behavior and document intentional changes rather than “improving” relevance by guesswork.
- Downrank fuzzy contributions; keep exact/prefix candidates when running fallback.
- Quoted phrases remain phrase queries, not bags of fuzzy words.
- Keep the explicit typo-discovery/fuzzy-only mode, but verify its meaning: a fuzzy query can include edit-distance-zero matches. Results advertised as typo-only must contain an actual nonexact matching occurrence; do not merely hide exact highlight marks and leave exact-only documents in the result list.

Recency is off by default. Do not transplant the old decay formula without tests for units and expected behavior at fixed ages. If retained, make the reranking candidate window and its limitations explicit. Optional diagnostic field scores must correspond to actual retrieval/reranking contributions, not unrelated substring counts. Keep expensive score explanations off the normal path.

Quick-open is a separate metadata workflow. Use nucleo-matcher on filename/title/path with stable tie-breaking and explicit priorities for exact title, prefix, then subsequence matches. Empty query returns suitable pinned/recent items without querying the full-text index. Do not mistake abbreviation matching such as `clcd` for edit-distance matching over prose.

### 9.4 Search lifecycle and freshness

Own a long-lived Tantivy writer and reader. Normal incremental commits must not force-merge every segment. Publish reader reloads deliberately after a successful commit. Read-only searches use a searcher snapshot without taking a lock held for indexing. [R9][R10]

Use a bounded/coalescing mutation queue. For each note, the latest authoritative mutation wins by revision, not arrival time. Deletions cannot be undone by an older queued upsert. On overflow, mark the index dirty and schedule bounded reconciliation rather than blocking a durable note save or silently losing freshness.

Maintain schema/analyzer version and indexed revision/watermark metadata. One later successful upsert must not clear a degraded flag left by earlier unprocessed changes. An index failure cannot turn an accepted note write into a failed save.

Do not rebuild every index at every startup. Reopen valid indices and reconcile changes, with an explicit preparing/degraded status where needed. Permit the current note to load without materializing every note body in the browser. Rebuild into a separate derived directory and swap only after successful completion; never delete the only usable index first. Authoritative per-note reads/preconditions remain correct while discovery/indexing catches up.

Start with a small global search memory/thread budget. Ferrisearch's four-worker/120 MB setup is a useful bulk-index reference, not an unconditional per-vault resident allocation. Benchmark one active vault and several configured idle vaults. Separate bulk-build and incremental-writer tuning only when measurements justify it.

### 9.5 Required evidence

Port meaningful Ferrisearch relevance/highlighting tests, then add Tansu identity/range/rename/deletion/Unicode tests and frozen top-result expectations. Run differential tests against the local reference for unchanged semantics; record intentional differences. No reference checkout is needed to run the resulting Tansu2 tests.

Add native benchmarks with stored corpus fingerprints, hardware/compiler details, cold/warm runs, and separate times for discovery, source reads, indexing, commit/reload, query evaluation, and result materialization. Record score explanations on/off separately. Ferrisearch's recorded approximately 3 ms exact-search p50, 50–75 ms sample fuzzy p50s, and 783 ms four-worker indexing median are comparison data, not guarantees for a different corpus or machine. [R11]

**Gate 3:** vendored search builds standalone; source-range/relevance tests pass; note saves survive simulated search failure; clean warm restart does not force a full rebuild; performance and memory evidence include multiple vaults.

## 10. Stage 4 — document sessions, saves, workspace, and recovery

**Goal:** make frontend correctness independent of DOM rebuilding and response timing.

Replace loosely related flags with a small, documented per-document state machine. It may be implemented with ordinary TypeScript unions and functions; it must not become a general workflow engine. Distinguish at least loading, clean, dirty, saving, conflict, unavailable/unresolved, and authentication-locked states, plus local and accepted revision counters.

Each save captures immutable source/base/version/mutation identity. Permit one in-flight save per document; coalesce further edits into a follow-up save against the acknowledged base. Save acknowledgment updates only the version it actually accepted. It must not clear a newer dirty flag, overwrite newer editor content, or delete a newer journal checkpoint.

Use cancellation and generation checks together. `AbortController` helps cancel obsolete requests, but a canceled mutation might already have committed server-side. Never treat cancellation as rollback. Use mutation idempotency to resolve an uncertain save after reconnect. Read/search responses must check current server/vault/note/request generation before updating UI. Use finite, backoff-bounded retries only for classified transient failures; do not retry conflicts or invalid requests forever.

On tab/vault switching, capture the outgoing session and schedule/flush its save without relabeling it as the incoming document. Do not destroy the old editor before a coherent snapshot is captured. Closing a dirty tab waits for accepted save or retains a clearly discoverable recovery draft; it cannot silently discard after a failed request. Closing a clean tab may release its in-memory undo state. Reopening restores content/cursor, not a falsely promised persistent undo history.

Move workspace state to a per-browser/per-workspace store: open/closed tabs, active note, ordering, pinned tabs, cursor/selection/scroll, source mode, and search history. A phone added later must not take over a desktop's tab layout. Multiple browser windows must not race on a single session row. Import old server-side workspace state once and preserve an export/recovery path; do not let every startup reapply it over newer local state.

Retain the clean-note cache as an acceleration path keyed by current logical hash and stable identities. A cache hit is not a substitute for server authorization or freshness verification. An old cache result cannot replace a dirty session. Clean cache eviction must never delete draft journal records.

Implement recovery storage from section 5.6, including format validation, stale-draft detection, failed-storage UI, explicit discard/export, and conflict-aware reopening. Keep source out of ordinary debug logs and URLs. On sign-out or account/server-identity change, lock the editor and prevent unauthorized reuse of cached content; provide an explicit policy for retaining/exporting/purging drafts rather than silently deleting them.

Test with fake clocks, deferred promises, response reordering, failed IndexedDB transactions, abrupt test-page termination after a confirmed checkpoint, lost save responses, and SSE disconnect/reconnect. Run two browser contexts and two windows, with deliberately identical note paths in different vaults.

**Gate 4:** no document/session cross-contamination; latest acknowledged checkpoints recover; a newer draft survives every old response; failed saves remain discoverable; device/workspace navigation is isolated.

## 11. Stage 5 — replace the production editor and finish Markdown behavior

**Goal:** make the proven adapter the normal editor, retaining source semantics instead of compatibility with the old implementation's internals.

Integrate the adapter with the session/save/recovery controllers. Remove normal editing's dependency on the custom contentEditable model, DOM-to-Markdown serialization, marker-based selection mapping, and textarea source mode. Keep useful pure formatting, diff/merge, and HTML-import helpers only where still used and independently tested. Delete the retired engine after feature parity gates pass; do not ship two competing production editors or an indefinite engine selector.

Retain the existing editor folder as the ownership boundary. App shell code must not walk CodeMirror's generated DOM, mutate its content, or infer source from HTML. CodeMirror extensions own source editing; app services own persistence, assets, and navigation.

### Required Markdown capabilities

- Live typography for headings, emphasis, strong, strike, highlight, inline/fenced code, lists, tasks, blockquotes, rules, links, and tables.
- Raw-source reveal that does not mutate the document, with robust mouse/keyboard selection near hidden delimiters.
- List continuation/indent/outdent, code-fence editing, checkbox toggles, formatting commands, and undo/redo as ordinary source transactions.
- Existing wiki-image syntax `![[name]]` and `![[name|320]]`, standard Markdown images, and image resizing that changes only the relevant source construct as one undoable operation.
- Existing callouts such as `> [!warning] Title`, including nested/continued content, with a safe raw fallback for unfamiliar variants.
- Source-preserving copy/cut and plain-text Markdown paste. Rich HTML paste/import is a distinct sanitizing/conversion path, never the ordinary save serializer.
- Literal in-document find over the current editor source, with smartcase policy, next/previous navigation, source reveal, and no server round trip. A source-only match in hidden Markdown must be made visible rather than highlighting unrelated rendered text.
- An outline whose headings map to valid source ranges, not a regex that treats fenced `#` text as a heading.

Tables may replace/reformat the table span the user intentionally edits, but may not normalize unrelated paragraphs/frontmatter or change a document merely by receiving focus. Test pipes, escapes, inline code, links/images in cells, Unicode, row/column edits, backspace boundaries, and undo. Copy of a selected source span remains source, not a screenshot or lossy table HTML.

Use conventional `[[target|label]]` semantics for note links, with optional heading targets where supported. Do not import an upstream native engine's opaque-ID-after-pipe convention into ordinary Markdown. Resolve against the active vault only, with explicit relative/root/basename rules and ambiguity handling. Do not pick an arbitrary file when two basenames match. Broken links remain editable source; autocomplete lists only permitted current-vault metadata. Backlinks and automatic rewriting of links across a vault rename operation are deferred; make that limitation explicit rather than pretending stable internal IDs automatically fix textual links.

### Frontmatter and titles

The adapter receives the whole logical source. Remove the old unconditional split/reassemble frontmatter path from `syncActiveDraft` and equivalent flows. Tags-only interpretation remains the metadata scope. Unknown frontmatter stays authored text, not an error to repair.

If a tag control edits supported frontmatter, apply a bounded source edit with undo and preserve unrelated source. Do not add a general YAML serializer or strip unsupported fields. A compact presentation for frontmatter can be added, but raw mode always exposes the exact normalized source.

Render the filename-derived virtual title separately and implement its explicit rename workflow. Untitled local drafts are journaled and can be closed/recovered without creating files. The body history does not secretly undo a committed file rename.

### Attachments

Retain both existing `images/` and `z-images/` references; new pasted/uploaded images use one documented default (`z-images/`). Resolve legacy bare names only through a deterministic, confined resolver; ambiguity must be surfaced. Do not rename/move an existing asset directory during migration.

The server serves authenticated assets through stable vault-scoped URLs. It must derive/validate MIME type, bound sizes, prevent traversal/symlink escape, and never execute or inline arbitrary active content. No raw filesystem paths are exposed. Derivative thumbnails, when useful, live in disposable application cache, keyed by source hash and rendering parameters; originals remain unchanged.

Support ordinary browser-decodable raster formats present in fixtures. Inventory legacy formats, including HEIC/HEIF when present. Do not claim cross-browser HEIC support without a real decoder test. Preserve unsupported originals and display an explicit unsupported-format tile with a safe original-file retrieval action; codec-specific derivative support is a separately recorded compatibility item, not an excuse to rewrite originals or hide broken rendering. Any added codec must have a measured dependency/build cost and fixture tests.

Image paste/upload is asynchronous: keep insertion ownership tied to the source session/revision, preserve the original selection intent, show progress, handle failure, and do not insert into whatever note happens to be active when an upload finishes. Object URLs, decoded images, observers, and event handlers must be released when their owner is disposed.

Do not silently fetch arbitrary remote images from the server. Keep external Markdown references as source; external navigation follows a safe scheme policy. If remote localization is subsequently added, it requires a separate SSRF/redirect/size policy and is not part of this desktop campaign.

**Gate 5:** old production editor removed; all required Markdown behaviors and source tests pass; independent undo/session state is retained; images and asynchronous paste cannot cross notes/vaults; no normal save depends on HTML serialization.

## 12. Stage 6 — fast search and navigation UI

**Goal:** create one excellent search experience with three clearly different workflows.

1. **Quick-open:** title/path metadata with abbreviation matching, pinned/recent defaults, and immediate keyboard navigation.
2. **Vault search:** Ferrisearch-derived exact/prefix/fuzzy full-text results, meaningful excerpts, and reliable source reveal.
3. **Current-note find:** local literal/smartcase matching over the current unsaved CodeMirror document.

Provide a shared transient panel foundation with distinct modes. Keep the query field stable and focused while results change. Keyboard selection must survive incremental results when its note still exists. Escape returns focus/selection to its origin. Do not recreate the editor or lose its scroll/history when opening a panel.

For network search, cancel obsolete read requests, sequence responses, and check server/vault/query generation. Debounce only if measurements justify it; do not inherit the old three-character minimum for quick-open. Apply tighter expansion bounds to one-/two-character full-text queries rather than stalling ordinary navigation. Keep result count, terms, fuzzy expansion, and response sizes bounded.

### Unsaved-note search overlay

Saved notes with unsaved local edits must be searchable without waiting for a disk save/index commit. This overlay is **private to the requesting browser session** and never becomes canonical content or leaks into another client's index.

Use a request-scoped POST search variant carrying bounded current dirty-document snapshots and their identities/base/local revisions. Evaluate those sources using shared Rust query/match logic in `tansu-search`; suppress the corresponding stale canonical hits even when the draft no longer matches. Do not write these sources into the durable Tantivy index or application history merely because a search occurred.

Display matching unsaved results in a clearly identified small local-draft section rather than pretending BM25 scores from a tiny overlay and a full corpus are directly comparable. Limit overlay count/bytes explicitly; an exceeded bound produces a visible partial-coverage notice or actionable error, not silent omission. Keep source out of query-string URLs and logs. Unnamed never-saved drafts need not enter global vault search until first save; they remain accessible through open/recovery UI.

A hit includes the source revision/hash that its ranges refer to. Opening it must fetch/use the matching current source and check validity. If the source has changed, rematch/requery safely and indicate the changed result; never apply an old offset blindly. Do not use Atomic's heuristic reveal-by-snippet routine as the primary source-navigation contract.

Use plain text plus ranges to render excerpts with text nodes and explicit highlight elements. Never treat a raw search excerpt as trusted HTML. Provide a bounded, opt-in diagnostics surface for score explanations; do not clutter the normal search UI with internal scores.

**Gate 6:** quick-open, full-text, and local find have separate correctness tests; stale results never replace newer queries; dirty overlays suppress stale canonical hits; source reveal works through frontmatter/Unicode and rejects stale offsets; panels do not remount the editor.

## 13. Stage 7 — desktop visual and interaction polish

**Goal:** a deliberately designed writing application, not a dashboard around an editor demo.

The visual target is the calm, native-quality writing surface of the Tansu/Nodes reference: strong typography, very little chrome, well-behaved selection, and transient navigation. Do not copy Atomic's demo UI wholesale or add a component-library dashboard. If `~/d/tansu` is available, inspect its frozen visual references and editing lifecycle; do not require it to build or test Tansu2.

### Concrete desktop direction

Use a light neutral canvas, quiet ink colors, restrained borders, and one subtle accent. Start with system UI fonts; no third-party font CDN, runtime font download, or unlicensed bundled font. A useful initial scale is 16–17 px body text, approximately 1.55–1.65 line height, a reading measure around 70–80 characters, and a slightly larger virtual title. These are initial design tokens, not a substitute for screenshot/interaction review.

A slim tab strip and optional collapsible navigation/outline are sufficient. The editing canvas is dominant. Pins, recents, folders, settings, and history should not all occupy permanent panels. No split Markdown preview, graph view, AI sidebar, permanent formatting ribbon, or decorative metrics dashboard.

Require the following desktop surfaces:

- An open document with sidebar shown/hidden, several tabs, pinned tabs, active/dirty/saving/conflict indicators, and an outline.
- Quick-open, vault search, command palette, rename, recovery/conflict, and revision-view surfaces.
- Empty vault, unnamed local draft, loading, unavailable server, authentication lock, unresolved note, and failed-save states.
- Long text, image-heavy text, a wide table, a long code fence, and a narrow desktop window without overlap or horizontal page spill.

Target viewport widths of roughly 1024, 1280, 1440, and 1920 CSS pixels, including browser zoom and high-DPI rendering. Mobile-specific layouts below the desktop range are deferred, but avoid gratuitous fixed assumptions that make a future mobile shell impossible. Test browser zoom to 200% for functional access and scrolling.

Use CSS variables shared by shell/editor. Reserve image dimensions where known, constrain wide content appropriately, and preserve scroll anchors as images decode. A caret movement or search-panel update must not produce an app-wide layout jump. Honor `prefers-reduced-motion`. Keep visible focus, labels, contrast, and keyboard escape routes; do not trade accessibility for minimal chrome.

Define and document a small keyboard map. Suggested mappings: `Mod+P` quick-open, `Mod+K` commands, `Mod+Shift+F` vault search, `Mod+F` note find, `Mod+S` save, `Mod+Z`/redo editor history, and `Mod+Alt+N` new local note. Respect typing/composition and focused native controls. Do not promise interception of browser/OS-reserved commands such as window close or browser new-window; provide reliable visible and alternative commands.

### Visual acceptance

Build deterministic Playwright screenshot scenarios for the surfaces above. Use fixed source, locale, date/clock where relevant, viewport, test assets, and font readiness. Wait for a real ready state and visible image decode, not arbitrary sleep calls.

Inspect generated screenshots, both full surfaces and relevant crops, at normal scale. Record baselines only after that review and behavioral assertions. Existing reference images are evidence, not targets to overwrite automatically until a diff passes. Antialiasing thresholds should be engine/platform appropriate; screenshot similarity cannot certify good interaction behavior.

Measure pointer/keyboard response, reveal stability, table editing, tab transitions, and scroll pacing in headed desktop runs where available. Record the reference browser/display rate; do not impose a blanket 8.33 ms frame assertion on a 60 Hz display.

**Gate 7:** every required surface has reviewed screenshots and behavior assertions; no editor remount on unrelated UI changes; normal desktop keyboard/mouse use is coherent; the UI is not merely the old shell with a replacement text box.

## 14. Stage 8 — HTTP, event streams, and passkey hardening

**Goal:** private deployment is safe by design, not just because the service has a small audience.

### 14.1 Transport

Implement the prescribed Hyper HTTP/1 boundary. Keep route decoding/DTOs separate from vault operations. Set explicit connection, header, body, request-duration, and work-queue limits. Parse bodies incrementally with bounds; do not spawn an unlimited blocking thread per connection or collect an unbounded stream before checking its length. The library is responsible for HTTP framing; application code is responsible for resource limits and authorization.

Bound blocking vault/search work and isolate it from the I/O runtime. Long-lived SSE connections must not occupy all mutation workers. Disconnected clients must release subscriptions and response buffers. Shutdown should stop admission, terminate streams, and finish or record accepted operations without an unbounded wait.

SSE is a notification/freshness mechanism, never the authority deciding whether a save happened. Add a per-vault monotonic event version and reconnect semantics. Use bounded replay or a clear `resync_required` message when continuity cannot be guaranteed. A fresh bootstrap must reconcile metadata without discarding dirty sessions. Take care not to lose mutations between initial metadata capture and subscription establishment.

### 14.2 Origins and authorization

Bind to loopback by default. Configure the external origin explicitly; do not infer security policy from arbitrary `Host` or forwarded headers. Trust proxy identity only under the documented loopback proxy configuration. A Tailscale identity header is not a substitute for passkey session authorization.

There are two explicit modes: local development without auth on allowed loopback origins; and authenticated deployment with a fixed HTTPS origin/RP ID. Do not automatically disable auth when a dependency fails, a cookie expires, or the proxy appears local. A no-auth private-tailnet mode, if retained for personal use, must require an explicit setting and a warning; it is not the secure default for configured external origins.

Validate allowed hosts/origins, reject cross-origin state-changing requests, and use a session-bound CSRF mechanism rather than relying on SameSite cookies alone. Do not use permissive CORS as an integration shortcut. Apply authorization to bootstrap, note bodies, search, revisions, conflicts, assets, and SSE. Protect dev diagnostics or exclude them from production.

Serve application code/assets only from the build manifest. Return restrictive CSP and other suitable security headers; permit only the inline styles actually required by the editor, not arbitrary inline script or `eval`. Sanitize/disable active Markdown HTML, reject dangerous link schemes, and do not inline user SVG/HTML into the app origin. Treat MIME/asset rendering as an authorization and active-content boundary.

### 14.3 Passkeys

Use `webauthn-rs` registration/authentication flows with server-held, single-use, expiring challenges. Configure the exact relying-party ID and allowed origin. Require the appropriate user-verification policy. Store credential updates based on the library's validated result, including its handling of authenticator counters/backup state; do not invent a rule that rejects all legitimate synced passkeys with non-incrementing counters. [R14]

Implement a single local user rather than a multi-tenant account system. Initial enrollment requires a one-time cryptographically random bootstrap capability created by an explicit CLI action, with expiry and hash-only server storage. No public “first visitor becomes owner” registration. Do not put secrets into logs or normal query strings. Further credential enrollment/revocation requires an authenticated, recently verified session. Prevent accidental removal of the last recovery option without an explicit local recovery procedure.

Use cryptographically random, opaque, server-revocable session tokens in an HttpOnly/Secure/host-scoped cookie, with explicit lifetime and CSRF policy. Never use `fastrand` for session tokens or enrollment capabilities. Keep auth state out of the disposable search/cache directories. Clear or invalidate the appropriate caches and streams on lock/logout/revocation; preserve unsaved work according to the documented recovery policy.

Document the stable-hostname consequence of WebAuthn: changing the origin/RP ID is not just renaming a server setting. Provide a local CLI recovery/reset procedure with backups and explicit consequences, not a remote auth bypass. Passkeys do not replace disk backups or encrypt the Markdown vault.

### 14.4 Security tests

Cover forged/missing session, challenge replay/expiry, mismatched origin/RP ID, invalid signature, malformed credential response, CSRF, unauthorized asset/revision/SSE reads, session revocation, and concurrent enrollment attempts. Use virtual authenticators in Chromium for integration tests, plus library-level fixtures. Do not disable production checks to make these tests pass. Desktop Safari authenticator UX should be smoke-tested when available; absence of hardware is reported, not faked.

Cover oversized/slow requests, invalid framing handled by the chosen HTTP library, path traversal including encoded forms, symlink escape/substitution, wrong-vault IDs, malicious Markdown/links/assets, slow SSE consumers, and expired sessions on already-open event streams.

**Gate 8:** server binds only as configured; private endpoints are authorized; browser auth works with a test authenticator; replay/origin/CSRF/path/stream tests pass; a dependency inventory records the actual cost of the HTTP/auth additions.

## 15. Stage 9 — standalone packaging and migration tools

**Goal:** one deployable application binary, with no source-checkout dependency at runtime.

Generate the production frontend through the retained build toolchain. Emit fingerprinted assets and an explicit manifest. Embed the exact production asset set in the Rust binary; do not serve the source tree, a path relative to current working directory, or arbitrary files from `web/`. Production source maps and diagnostics must not expose source content/secrets unintentionally.

Keep asset generation an explicit build step. `cargo build` must not silently execute package installation or download another repository. A top-level packaging command can sequence deterministic frontend build and Rust compilation, with clear errors for missing generated artifacts. The embedded manifest and compile-time source paths must remain correct when the repository is copied to another directory.

Use immutable caching/ETags for fingerprinted static assets and revalidation for the HTML shell. Sensitive API responses use private/no-store semantics as appropriate; clean-note caching is explicit application behavior, not an accidental shared HTTP cache. Include MIME types, security headers, API version, and application build ID.

Provide example config and documentation for loopback startup and Tailscale Serve HTTPS. Do not actually configure the user's network or enable Tailscale Funnel. Explain the distinction between private Serve and public exposure. Include desktop passkey enrollment/recovery, backups of both authored content and durable application state, derived-cache rebuild, migrations, and rollback constraints. [R13]

Packaging acceptance must include a clean-environment test in which `~/d/ferrisearch` and any optional Tansu/Atomic checkout are absent. Run the binary from an unrelated empty working directory with temporary vault/config/data roots and no Node, pnpm, Deno, or source assets on its execution PATH. Open a note, edit/save, search, restart, and repeat.

Retain supported macOS and Linux-musl build targets. Record and test any required native crypto/image libraries rather than claiming a completely static Linux artifact on assumption. For a claimed static artifact, verify linkage with the appropriate platform tools. Include license/provenance files and a clear redistribution-review note; no publication is authorized.

Provide a dry-run migration/report command operating on user-specified copied data, and a backup-first migration workflow. Rollback must distinguish restoring application state from restoring newer authored note bytes. Never advise rolling an old executable over a newer schema without checks.

**Gate 9:** runtime is independent of working directory and reference checkouts; packaging includes tested frontend assets; supported target builds and linkage claims are evidenced; migration/backups/auth/deployment documentation is complete.

## 16. Stage 10 — integrated correctness, performance, and long-session validation

**Goal:** deliver the whole application, not independently successful subsystems that fail together.

Run the end-to-end fixture suite through the actual packaged server and all three desktop browser engines. Test at least two vaults with identical filenames/note text; two browser contexts; two windows; rapid A/B switching; edits during saves; watcher activity during indexing; auth expiry during a draft; and reconnect after a dropped save acknowledgment.

### Performance protocol

Use a named, fingerprinted corpus and record total notes, bytes, tokens, image count, note-size distribution, hardware/OS, compiler profile, browser version, and warm/cold conditions. Keep input datasets consistent for comparisons. Do not compare a debug Tansu build with an optimized Ferrisearch benchmark or compare score-explanation-enabled and disabled queries without labeling them.

Use at least the existing real fixture corpus, a 2,500-ish-note benchmark set, a 10,000-note scale set, a 50 KB note, a 250 KB note, and a 1 MB stress note with tables/images/Unicode. Synthetic repetitions are useful for stress but not evidence of real relevance quality.

Record separate metrics for UI boot, metadata bootstrap, current-note open, editor parse/decorate/first useful paint, visible image readiness, cached tab switch, input transaction, source snapshot, recovery checkpoint, save acceptance, index visibility, and search result paint. Network time and server computation time must be separated.

Initial desktop engineering targets on the documented reference machine:

| Operation | Initial target |
| --- | --- |
| Ordinary 50 KB note, local warm open to useful editor | p95 below 250 ms |
| Switching to a loaded unchanged note | p95 below 50 ms |
| Ordinary typing transaction, 50 KB note | p95 below 8 ms of main-thread work |
| Ordinary typing transaction, 250 KB note | p95 below 16 ms of main-thread work |
| 1 MB stress-note typing | p95 below 32 ms; no repeated whole-document serialization |
| Quick-open on about 2,500 notes | server p95 below 10 ms |
| Exact/prefix full-text query, normal diagnostics off | server p95 below 15 ms |
| Representative fuzzy query | server p95 below 100 ms |
| Exact-search query to displayed results, loopback | p95 below 100 ms |
| Visible indexing after an acknowledged save, idle system | normally below 500 ms, with explicit status during backlog |
| Routine recovered-draft journal checkpoint | normally completed within 250 ms of a typing pause |

These are proposed targets, not measurements from this campaign's preparation. Freeze the concrete benchmark configuration before evaluating them. If hardware/corpus makes an absolute target inappropriate, preserve both the absolute result and a controlled baseline-relative comparison, explain the difference, and do not silently loosen the target. Aim for no unexplained regression over 15% in retained important paths. A missed target is visible work, not a reason to falsify the measurement or remove the scenario.

Structural performance gates apply on every machine:

- No full-document string materialization/hash on every keystroke or caret move.
- No app-root or editor replacement for a status dot, search result, or title metadata update.
- No forced full-vault reindex on a clean restart.
- No Tantivy writer construction and force-merge for every note save.
- No API full-note-body payload for every search result.
- No unbounded request, event, image, cache, or search queue.
- No persistent allocation of a large writer budget for every idle configured vault without measured justification.

Inspect Atomic's full-parser-coverage and decoration rebuild behavior specifically. Optimize with maintained syntax/decorations and affected-range invalidation where feasible; do not introduce incorrect viewport-only rendering that leaves offscreen source permanently unstyled or breaks selection. Avoid tuning solely against ASCII paragraphs.

Use esbuild's output metadata to report raw/minified/compressed bundle sizes and module contributions. Verify the absence of React/Solid/Effect and duplicate CodeMirror instances. Lazy-load only measured secondary costs such as optional code grammars or history views; do not introduce complex chunk orchestration by default. No unused twenty-language registry should inflate the initial editor bundle.

Run a long-session stress test with repeated open/close/switch/edit/undo/search/image actions and periodic save/index/reconnect activity. Collect DOM/editor instance counts, heap after a controlled idle/collection point when available, subscription counts, server memory, and task/queue counts. Look for sustained growth rather than asserting RSS must shrink immediately. Run with delayed and failed network requests, not just an ideal loopback connection.

### Completion gate

All required behavior tests, migration/recovery tests, security tests, three-engine browser tests, type checks, lint checks, and existing coverage gates pass. Screenshots have been inspected. Search and editor performance results are recorded, with any remaining target misses explained explicitly. The packaged app passes the reference-checkout-absent test. No normal path still uses the retired editor.

Any unavailable real-Safari/hardware-authenticator test is labeled unavailable; automated substitutes are identified accurately. Do not present this qualification as proof that those real-device behaviors passed.

## 17. Test matrix and regression ownership

Maintain stable named tests for the following contracts. Add more cases as implementation reveals edge conditions, but do not replace contract tests with snapshots of current behavior.

| Area | Required regression families |
| --- | --- |
| Source | exact no-op bytes; blank lines; BOM/EOL maps; escapes; code; mixed/unknown frontmatter; invalid UTF-8; legacy/new hash formats |
| Identity | durable IDs on rename; config reorder; distinct server/vault namespaces; duplicates; global ambiguity in external moves |
| Durability | stale API save; watcher-delay external edit; lost ACK replay; create no-clobber; interrupted stages; missing/corrupt history; pending materialization |
| Editor | per-note history; coherent snapshots; source-mode parity; IME; UTF-16 selection; tables/images/tasks; hard lock; no DOM serialization save path |
| Async ownership | delayed note loads; late asset upload; stale save response; rapid vault switch; closed draft; auth expiry; dirty external reload |
| Recovery | journal transaction failure; latest checkpoint restore; newer draft not cleared; cache/journal isolation; incompatible persisted format |
| Search | all-required terms; repeated-word phrases; prefix/fuzzy thresholds; true typo-only mode; Unicode normalization; range mapping; stale hit; deletes/upserts; degradation |
| Search UI | quick-open versus full-text versus local find; request generation; focus restoration; overlay privacy; no stale canonical draft hit |
| Security | path/symlink confinement; cross-vault access; MIME/XSS/link schemes; auth/CSRF/challenge replay; limits; slow SSE and cleanup |
| Packaging | no sibling/source checkout; unrelated CWD; embedded manifest; no runtime JS server; target linkage; migration rollback boundaries |
| Visual/perf | declared desktop surfaces; ready-state image capture; wrap/reveal stability; no root rerender; no forced warm reindex; long-session growth |

Use unit tests for pure normalization/query/mapping/state transitions; property tests where they expose source/offset/transaction errors; integration tests for the vault/catalog/history; and real browser tests for input/layout/lifecycle. Test doubles do not validate browser selection or filesystem crash durability by themselves.

Generated API type tests must catch drift. Validate network/storage integers as safe and in range; `usize`/`u64` mapped to a TypeScript `number` is not permission to accept negative, fractional, unsafe, or non-finite values.

## 18. Final deliverables and agent report

Deliver working code in the existing Tansu2 checkout, without committing or pushing, plus:

- Updated architecture/API/editor/development/performance/migration/security/deployment documents.
- The vendored Ferrisearch and Atomic implementations, provenance manifests, licenses, and local-patch notes.
- A source-format/catalog migration with dry-run reporting and fixture-backed interruption tests.
- Desktop UI screenshots and traces for declared scenarios, a benchmark report, dependency/bundle/linkage reports, and the standalone packaging test evidence.
- A concise completion ledger mapping every stage to its test evidence and every remaining issue to an explicit severity/scope.

The final report must say what changed, which exact commands passed/failed, what was actually run, the tested revisions/browser versions, any source-semantic changes, migrations needed before using real data, and the exact development/packaging commands. Do not replace the evidence with a generic “all tests pass.”

Explicitly list deferred scope: iPhone/mobile UI, touch/virtual-keyboard refinement, installable PWA/service worker, full offline synchronization, collaboration/CRDTs, backlinks/automatic vault-wide link rewriting, arbitrary remote-asset localization, broader non-tag metadata editing, and codec-specific compatibility items not implemented. These are not required desktop gates. **Passkey capability, desktop draft recovery, safe existing asset addressing, and standalone vendoring are required gates.**

Do not end by asking whether to continue with the remaining in-scope stages. Complete them, or report a concrete blocker without claiming completion. Do not perform a real-vault migration or deployment as a way to demonstrate success.

## 19. Reference register

These sources informed the decisions; the executable contract is this document plus the current checkout. External release status is the research snapshot as of 2026-10-14, not a perpetual version claim. Local implementation should record exact dependency pins once and avoid opportunistic upgrades mid-campaign.

**[R1] Updated Tansu2 checkout and toolchain**  
`https://github.com/joshuarli/tansu2/commit/cf7a51274af7227a8be651080e4d911d80e393f2`  
`https://github.com/joshuarli/tansu2/blob/cf7a51274af7227a8be651080e4d911d80e393f2/package.json`  
`https://github.com/joshuarli/tansu2/blob/cf7a51274af7227a8be651080e4d911d80e393f2/deno.json`  
`https://github.com/joshuarli/tansu2/blob/cf7a51274af7227a8be651080e4d911d80e393f2/AGENTS.md`

**[R2] Tansu2 semantics and implementation inspected**  
`https://github.com/joshuarli/tansu2/blob/cf7a51274af7227a8be651080e4d911d80e393f2/docs/architecture.md`  
`https://github.com/joshuarli/tansu2/blob/cf7a51274af7227a8be651080e4d911d80e393f2/src/history.rs`  
`https://github.com/joshuarli/tansu2/blob/cf7a51274af7227a8be651080e4d911d80e393f2/src/vault.rs`  
Also inspect the current local `docs/editor.md`, `docs/api.md`, `src/reconcile.rs`, `src/search.rs`, and frontend session/cache modules; this campaign intentionally changes some of their old contracts.

**[R3] Atomic architecture and source**  
`https://github.com/kenforthewin/atomic-editor/tree/b6ed65f01bde4510031bc7a495520bc1a7688c66`  
`https://github.com/kenforthewin/atomic-editor/blob/b6ed65f01bde4510031bc7a495520bc1a7688c66/docs/architecture.md`

**[R4] Atomic exported factories and package boundary**  
`https://github.com/kenforthewin/atomic-editor/blob/b6ed65f01bde4510031bc7a495520bc1a7688c66/src/index.ts`  
`https://github.com/kenforthewin/atomic-editor/blob/b6ed65f01bde4510031bc7a495520bc1a7688c66/package.json`

**[R5] Atomic wrapper lifecycle, callback, and reading-mode behavior**  
`https://github.com/kenforthewin/atomic-editor/blob/b6ed65f01bde4510031bc7a495520bc1a7688c66/src/AtomicCodeMirrorEditor.tsx`

**[R6] Solid 2 release status**  
`https://github.com/solidjs/solid/releases`  
`https://www.solidjs.com/blog/solid-2-0-rc-the-big-reveal`

**[R7] Effect 4 stable release, September 30, 2026**  
`https://effect.website/blog/releases/effect/40`

**[R8] Ferrisearch repository license**  
`~/d/ferrisearch/LICENSE`  
`https://github.com/joshuarli/ferrisearch/blob/master/LICENSE`  
Repository file observed with blob SHA `0a041280bd00a9d068f503b8ee7ce35214bd24a1`; verify local per-file/crate notices and preserve the actual imported provenance.

**[R9] Ferrisearch native implementation**  
`~/d/ferrisearch/crates/ferrisearch-core/src/{index,schema,search,tokenizer,types}.rs`  
`https://github.com/joshuarli/ferrisearch/tree/master/crates/ferrisearch-core`  
Research snapshot blob SHAs: `index.rs` `33be1b17639b030ac16b0d777aac6072bb78c341`; `search.rs` `13d768e63678df6caa336d7c6b9ebd34f2955943`; `schema.rs` `fc5e0732538e4c47695925d4fefefc7cd0b7ccc7`. Use and record the actual local checkout, not a claim that `master` is immutable.

**[R10] Tantivy library / commit and reader model**  
`https://docs.rs/tantivy/latest/tantivy/`  
`https://docs.rs/tantivy/latest/src/tantivy/lib.rs.html`

**[R11] Ferrisearch benchmark method and recorded results**  
`~/d/ferrisearch/PERF.md`  
`https://github.com/joshuarli/ferrisearch/blob/master/PERF.md`

**[R12] Hyper HTTP/1 server composition**  
`https://hyper.rs/guides/1/server/hello-world/`

**[R13] Private Tailscale Serve deployment**  
`https://tailscale.com/docs/features/tailscale-serve`

**[R14] High-level WebAuthn/passkey server API**  
`https://docs.rs/webauthn-rs/latest/webauthn_rs/`  
`https://docs.rs/webauthn-rs/latest/webauthn_rs/struct.Webauthn.html`  
`https://docs.rs/webauthn-rs/latest/webauthn_rs/struct.WebauthnBuilder.html`

**[R15] Nucleo matching modes and offset representation**  
`https://docs.rs/nucleo-matcher/latest/nucleo_matcher/pattern/enum.AtomKind.html`  
`https://docs.rs/nucleo-matcher/latest/src/nucleo_matcher/utf32_str.rs.html`

**[R16] Browser lifecycle persistence limitations**  
`https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event`  
`https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event`

**[R17] Browser storage limits and eviction**  
`https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria`

**[R18] CodeMirror state, view, configuration, and reconfiguration**  
`https://codemirror.net/docs/ref/`  
`https://codemirror.net/examples/config/`  
`https://codemirror.net/docs/migration/`

## 20. Suggested initiating instruction

> Work in `~/d/tansu2`. Read and execute `TANSU2_DESKTOP_CAMPAIGN.md` completely, using the current working tree and preserving my recent TS/tooling changes. `~/d/ferrisearch` is available read-only for reference; vendor the required native core into Tansu2 so it remains standalone. Follow the prescribed plain-TypeScript, CodeMirror/Atomic, and Rust architecture; do not introduce SolidJS or Effect. Desktop first; mobile UI/PWA work is deferred. Complete the gated implementation, tests, visual inspection, and packaging verification. Do not commit, push, deploy, enroll real credentials, or touch my real vault/config/data. Report exact evidence and any genuine remaining blockers, not just a summary of edits.
