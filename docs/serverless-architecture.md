# Portable core and serverless hosting proposal

**Status:** Proposed; no serverless host is implemented.
**Date:** 2026-10-26.
**Reference implementation:** the native `master` server and the V2 API contract in [API](api.md).
**Initial target:** one owner's approximately 300 MB Markdown/image vault on Cloudflare's free tier, subject to a measured feasibility gate.

## Decision

Support native and serverless deployment as *hosts* of the same application, not
as two implementations of note semantics. Extract a small, platform-neutral
Rust domain core and validate each host with a shared behavioral test suite.
Keep native Markdown files as ordinary files. For an optional Cloudflare host,
use private R2 objects for immutable source/asset/history bytes and
SQLite-backed Durable Objects for catalog, transaction coordination, and
per-vault events. The proposed deployment is **not** a replacement for local
hosting or a requirement for running Tansu.

Do not put a virtual POSIX filesystem over R2, copy the whole native
`VaultRuntime` to WebAssembly, or duplicate the domain layer in TypeScript.
Prefer narrow adapters at the actual persistence and runtime seams. No
Cloudflare SDK types or account assumptions belong in the shared domain core.

## Scope and invariants

Preserve these across both hosts:

- `noteId` is stable identity; `path` is mutable, unique vault-local metadata.
  Markdown remains source, not a serialization generated from a rich-text model.
  Never add hidden note IDs to the Markdown.
- Preserve the V2 API shapes, `serverInstanceId`/`vaultId` identities, source and
  disk hash formats, LF editor source, BOM/line-ending behavior, preconditions,
  delta validation, mutation-id idempotency, and accepted/conflict/pending
  outcomes. Protocol changes require explicit versioning and frontend tests.
- An accepted content mutation references a complete, durable, verified
  snapshot. Failed indexing, delivery, or asset prefetch cannot invalidate an
  accepted write. No stale write overwrites canonical content; rejected stale
  drafts remain recoverable as conflicts where the V2 contract requires it.
- Serialize the **commit point** of mutations within a vault. Do not infer
  serialization across `await`: external object-store I/O may interleave other
  requests. An idempotent retry has the original durable result, not a second
  revision or event.
- Search indexes and browser caches are derived. They may be rebuilt without
  changing note identity, history, or authored content. Source files and
  snapshots never depend on an index being healthy.
- Authenticated requests, images, search, revision bodies, and event streams
  remain private. Keep origin/RP checks, HTTP-only session cookie, CSRF checks,
  session revocation, and first-credential enrollment protections.
- Native users must retain external-file editing, watcher reconciliation,
  POSIX-safe paths, and the current recoverable filesystem write protocol.

**Not in scope:** offline synchronization or browser write queues, CRDTs,
multi-user permissions, encrypted-at-rest *from the provider* or end-to-end
encryption, generic object-storage backends, background AI, automatic related
notes, and emulating a filesystem in Workers. Do not add a second package
manager or lockfile to introduce Wrangler; if needed, use the existing pnpm
toolchain.

## Current code boundaries

| Existing code | Proposed responsibility |
| --- | --- |
| `crates/tansu-api-types` and `web/ts/app/v2-api.ts` | Keep one wire contract and unchanged client behavior. |
| `src/links.rs`, `src/tags.rs`, pure portions of `src/history.rs`, and note mutation validation | Extract reusable parsing, hashes, link resolution, conflict/precondition decisions, and result construction into small platform-neutral Rust crates/modules. |
| `crates/tansu-webauthn` | Reuse cryptographic/ceremony parsing logic *if* `wasm32-unknown-unknown` and the current `graviola` configuration pass an actual compile and runtime spike. |
| `src/vault.rs`, `src/catalog.rs`, `src/paths.rs`, `src/reconcile.rs` | Keep a native host backed by `rusqlite`, real files, a per-vault lock, recovery, and watcher reconciliation. Extract behavior incrementally, not via a giant trait rewrite. |
| `src/main.rs`, `src/http.rs`, `src/app.rs`, `src/auth.rs` | Native CLI, Hyper transport, process lifecycle, and native auth storage stay native. Separate host-neutral policy from OS-specific stores only where necessary. |
| `crates/tansu-search`, `src/search.rs` | Preserve native Tantivy; evaluate a cloud candidate-retrieval adapter separately and prove query/search-result parity. |
| `web/ts/app/workspace-store.ts` | Continue to own browser-scoped IndexedDB tabs, workspace, and draft checkpoints; no silent online/offline semantic change. |

**Design rule:** abstract operations and consistency guarantees, not
`std::fs` method names. Define small ports only after extracting a real
shared mutation path. Avoid pervasive generics and host conditionals in every
core function. Keep one Rust implementation of the domain state transition,
plus host-specific transaction/storage mechanics.

## Proposed Cloudflare mapping

```text
Browser (existing static editor/UI)
  -> HTTPS Worker (static assets, authenticated V2 HTTP gateway)
       -> application/identity Durable Object (settings, vault registry,
          passkey ceremonies, credentials, sessions, enrollment capabilities)
       -> per-vault SQLite Durable Object (catalog, revisions, idempotency,
          event log, search metadata/index, exclusive commit authority)
            <-> private R2 (immutable Markdown bytes and compressed history,
                             conflict drafts, WebP assets)
```

A named Durable Object is the sole catalog writer for a given cloud vault; all
deployments and requests must resolve that vault to the same object identity.
An application-level Durable Object is a simple starting point for the
cross-vault registry and auth. Avoid introducing D1 or KV until benchmarks show
a requirement. An actual Worker can be implemented with `workers-rs`, which
supports SQLite Durable Object bindings. A *minimal*, audited JavaScript
interop shim is acceptable only if needed for a missing runtime API; it must not
implement a second Tansu domain model.

The cloud catalog, not R2 listings or object names, is authoritative for
current notes and revisions. R2 objects are private; no public bucket website,
unsigned public asset links, or client-side direct access to raw backups.
An exported .md file is still ordinary Markdown. A cloud object key is an
internal storage mechanism, not a user-visible file path.

Native keeps filesystem reconciliation for non-Tansu writers. The cloud host
has no filesystem watcher and no promise to notice external R2 mutations.
Cloud writes occur only through the same validated V2 mutation API. A separate
explicit import/export path provides portability.

### Durable write algorithm

For a content-changing operation, including creation, saving, importing,
restoring, and conflict preservation:

1. Authenticate/authorize, validate the request, hashes, path, note identity,
   size, mutation ID, and any precondition with shared policy.
2. Read the current catalog state and quickly return a stored outcome for an
   identical mutation ID. A different payload under the same ID fails.
3. Materialize the complete candidate from the exact base snapshot (including
   deltas) where applicable. Validate both the canonical LF `sourceHash` and
   exact-byte `diskHash`. Encode/store the immutable content under a
   vault-scoped, content-addressed R2 key (for example
   `vaults/{vaultId}/blobs/{diskHash}`). Use an immutable/versioned encoding;
   verify reads by hash. Do not publish a new canonical pointer yet.
4. After R2 succeeds, execute a **synchronous, atomic SQLite commit** in the
   vault Durable Object. Re-read the mutation ID, current revision, path
   uniqueness, and precondition *inside* that transaction. Commit a new
   revision pointer, history event, durable idempotency outcome, and a
   monotonically increasing event version together. If the precondition
   changed during R2 I/O, preserve the submitted draft as a conflict rather
   than overwriting the winning revision.
5. Return `accepted` only after the catalog transaction is durable and the
   referenced R2 bytes are readable. Deliver SSE notifications after commit;
   failures to notify do not undo the write.

R2 and SQLite are **not** one transaction. Never hold an SQL transaction or
`blockConcurrencyWhile` across R2 I/O. Account for concurrency interleaving
after `await` even in a single Durable Object. Conditional object creation or
idempotent same-byte writes prevent accidental replacement of committed
content. Rename/delete-only operations need an appropriate atomic catalog
transaction and must retain necessary history content.

| Interruption | Required durable result |
| --- | --- |
| Before/during R2 upload | No accepted revision; retry is safe. |
| R2 upload succeeded, SQLite not committed | Prior revision remains authoritative; unused R2 object is an orphan. |
| SQLite committed, HTTP response lost | Retry returns the exact stored result; no duplicate revision or event. |
| Two clients race to save one revision | At most one wins; loser receives conflict with preserved draft. |
| Search/event delivery failed | Accepted content stays available; index rebuild/resync recovers. |

Do **not** eagerly garbage-collect objects. Only remove bytes proven unreachable
from *all* live revisions, tombstones, retained history, conflict drafts,
in-flight operations, and pinned export generations, after a safety grace
period. Test failures during collection. Never prune committed history to
make a free-tier budget without a separately approved retention policy.

## Search is the principal behavioral risk

Native uses Tantivy, custom tokenization/diacritic handling, weighted fields,
phrase and prefix matching, one-edit fuzzy fallback, excerpts with UTF-16
ranges, and dirty-note overlays. Cloudflare's SQLite Durable Object supports
FTS5, but the default tokenizer, candidate ranking, typo behavior, and phrase
semantics are *not equivalent* to the native implementation.

Prototype the smallest FTS5-backed candidate retrieval mechanism, with a
shared query policy and final result formatting/ranking where feasible. Index
large documents in bounded chunks because a Durable Object SQLite row or BLOB
has a 2 MB limit; do not silently omit content. Do not index image binaries.

Before deciding this architecture is production-viable, run native/cloud
search goldens against the fixtures and a realistic corpus. Cover terms,
diacritics, camelCase, quoted/repeated phrases, prefixes, typo-only, ties,
search weights, recency, overlays, deleted notes, excerpts, and highlight/source
ranges. FTS5 alone is not evidence of parity. If parity and free-tier CPU cost
cannot be met, stop and reconsider the search backend rather than hiding
different behavior behind the same API.

Search index corruption, version mismatches, or partial builds must have a
defined restart/rebuild path and must not turn an accepted write into failure.

## Identity, authentication, and security

- Keep Tansu's WebAuthn verification, short-lived first enrollment capability,
  recently verified enrollment for further credentials, session binding,
  signature-counter policy, origin/RP validation, CSRF, and same-site cookies.
  Cloudflare Access can be *additional* perimeter authentication, not an
  undocumented replacement for Tansu's owner model.
- Implement cloud credential/ceremony/session storage transactionally in the
  application Durable Object. Native `auth.rs` keeps filesystem locks and its
  current backup/restore protections. Do not persist bearer cookies or
  enrollment secrets in logs or caches.
- First-user enrollment requires a secure out-of-band deployment/bootstrap
  procedure using an expiring single-use capability; there is no unauthenticated
  public setup page that can claim the first credential.
- Use one stable HTTPS origin for browser and APIs; preserve exact Host/Origin
  checks (including trusted-proxy handling), strict CSRF handling, content
  security policy, `no-store` for private responses, and auth on image/event/
  revision endpoints. Include extension import, OPTIONS/CORS rejection,
  request-size ceilings, rate limiting, and abuse probes in tests.
- A new hostname/RP ID is not a transparent credential migration. Require
  deliberate credential re-enrollment or an approved same-RP migration
  procedure. Changing origin must not silently clear the only recoverable
  credential set without an explicit recovery path.
- Plaintext Markdown in R2/DO is readable to the provider and sufficiently
  privileged cloud-account principals. Cloudflare-managed storage encryption
  is not end-to-end encryption; document this threat model clearly.
- Defend against accidental exposure through `workers.dev` preview origins,
  default bucket endpoints, asset caching, error logs, backups, and
  misconfigured Access rules. Treat all content as private even when a bucket
  name or note ID is guessed.

## Events, limits, and portability

Preserve monotonic per-vault `eventVersion`, bounded replay, `after` cursor,
and `resyncRequired` semantics. A cloud SSE connection may have a bounded
lifetime and reconnect, but must not consume unbounded active Durable Object
duration. If long-lived streams are not viable on the free tier, first
measure/justify a client-compatible alternative; do not quietly disable
multi-tab freshness.

A user's 300 MB disk corpus is a *starting input*, not a storage budget:
measure Markdown versus WebP distribution, note count, largest notes, revision
multipliers, FTS5 index size, write amplification, R2 Class A/B operations,
SQLite rows read/written, active duration, request CPU, and cold starts.
Cloudflare free limits change. As of 2026-10, investigate at least the
Workers Free CPU/request budget, Durable Object request/row quotas and 5 GB
account-wide SQLite allowance, R2's 10 GB-month Standard allowance, 2 MB SQL
row/BLOB limit, and upload/request-size limits. Treat exceeding a hard free-tier
limit as an explicit user-visible error, not a silent partial save. Check current
official pricing and limits before deployment.

Offer **two** explicit export levels:

1. Plain Markdown plus `z-images/`: usable by any editor, but does not promise
   to retain note IDs, history, event versions, or credentials.
2. Full Tansu snapshot: versioned manifest, `serverInstanceId` and vault/note
   IDs, metadata, revision events, conflict drafts, settings, and **every**
   referenced content/asset blob. Take a stable metadata snapshot and pin its
   reachable objects until export completes; independently verify hashes.
   Auth state needs separately protected export/recovery and retains RP
   constraints. Do not assume Durable Object PITR also restores R2.

Import must be idempotent, reject incomplete/corrupt blobs, validate path and
identity collisions, rebuild derived search state, and support a native-to-cloud
round trip without covertly resetting history. Provide a rehearsal restore
before describing cloud hosting as safe for irreplaceable notes.

## Implementation campaign (gated)

### P0 — Feasibility before refactor

- Build a tiny `wasm32-unknown-unknown` Rust Worker with an actual
  SQLite-backed Durable Object, private R2 PUT/GET, and one transaction; test
  `workers-rs` API gaps and target-specific cryptography (especially
  `tansu-webauthn`/`graviola`). Measure wasm binary and hot/cold CPU cost.
- Run a 300 MB-class representative mixed Markdown/WebP corpus through a
  prototype FTS5 index/search path; compare against Tantivy fixtures.
  Verify cost ceilings using actual provider counters and free-tier limits.
- Deliver a short go/no-go ADR: precise blockers, search fidelity delta, CPU
  and storage numbers, upload-size handling, and whether Rust can own the
  complete domain layer. No native rewrite until this is credible.

### P1 — Extract the portable domain core

- Extract one operation/policy at a time with existing tests unchanged.
  Start with pure note revision/precondition/hash/link operations.
- Add dual-host contract fixtures for create/save/delta/rename/delete/restore,
  identical/different mutation ID retries, stale conflicts, path collisions,
  LF/BOM/disk hashes, cross-vault isolation, and crash recovery.
- Keep native FS behavior and benchmark budgets green; do not introduce an
  abstract `Filesystem` facade or premature asynchronous storage traits.

### P2 — Cloud write/read backend

- Implement app-identity/vault Durable Objects and R2 object conventions.
  Implement list/open/create/save first, using the failure-safe commit algorithm.
- Add import/image/revision/conflict/rename/delete/restore and event version
  persistence. Inject R2 4xx/5xx, SQL failure, process restart, timeout,
  concurrent requests, orphan GC, and lost HTTP response.
- Protect every private endpoint from the first deploy; no temporarily public
  vault used to accelerate development.

### P3 — Product parity and operations

- Port/pass test WebAuthn auth, first enrollment/recovery, search conformance,
  event replay/resync, settings, extension import, and browser end-to-end tests.
- Provide deterministic build/deploy config and safe secrets handling using
  the repository's existing pnpm tooling. Ship no real notes in fixtures.
- Implement verified exports, cold restore, native/cloud round-trip,
  observability without content leakage, budget alarms, and an explicit
  incident/rollback plan.

## Acceptance gates

Do not describe serverless as supported until all of these hold:

- All relevant existing native tests and performance gates still pass; native
  binaries, CLI, watcher, file ownership, and offline local operation are
  unchanged.
- One shared V2/domain conformance suite passes on native and cloud, including
  multi-client conflicts, idempotency across restarts, complete history, and
  every injected crash window.
- Search parity is measured, documented, and accepted for the supported query
  corpus; arbitrary note content is not silently dropped from the index.
- A new cloud vault cannot be hijacked at enrollment; all private routes and
  objects are protected; cookies and CSRF remain correct; origin changes and
  stolen/expired sessions are tested.
- A full native-to-cloud-to-native migration restores Markdown bytes, assets,
  identities, revisions, and conflict data with hash verification, and a
  disaster-recovery drill works with a fresh cloud deployment.
- The actual representative corpus (including history and indexes) fits
  current free quotas with ample headroom; batch imports, cold search,
  frequent saves, and idle SSE connections do not hit CPU or usage limits.
  Record measurements, not marketing-tier assumptions.

## References

- [Tansu architecture](architecture.md), [API](api.md),
  [deployment](deployment.md), [security](security.md), and
  [product scope](product-backlog.md).
- [Cloudflare Workers Rust](https://developers.cloudflare.com/workers/languages/rust/),
  [workers-rs](https://github.com/cloudflare/workers-rs),
  [SQLite Durable Object API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
  [Durable Object concurrency rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/).
- [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/),
  [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
  [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
  [R2 pricing](https://developers.cloudflare.com/r2/pricing/),
  [Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/).
