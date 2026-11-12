# Tansu TODO

Prefix: TNS
Next: 119

### TNS-109 · P1 · Browser windows silently overwrite each other's recovery drafts

- **Area:** Data
- **Where:** `web/ts/app/workspace-store.ts:855`, `web/ts/app/workspace-store.ts:1060`, `web/ts/app/workspace-store.ts:473`, `web/ts/app/workspace-store.ts:621`, `web/ts/app/document-session.ts:175`, `web/ts/app/document-session.ts:328`
- **Problem:** `createWorkspaceId` stores one ID in origin-wide localStorage, so independent browser windows share a note's IndexedDB draft key. Each `DocumentSession` starts an independent local revision counter, but `mergeDraftJournalRecords` compares those counters and lets equal revisions overwrite content. Two windows editing the same note before autosave completes, or while disconnected, can silently replace one window's only recovery copy. A probe using the real session, journal, hashing, and IndexedDB store code wrote different revision-1 drafts and confirmed both windows subsequently recovered only the second draft while both reported storage available. The storage boundary used fake-indexeddb; this was not a browser end-to-end run.
- **Recommendation:** Give each persisted workspace one writable owner before accepting edits, with secondary windows read-only until safe ownership transfer. Preserve the current recovery identity and existing records. If simultaneous independent editing is required, persist separate writer identities and discover every recoverable draft instead. Cover two windows editing one note, owner loss, reload, and stale-owner writes.
- **Fix with:** durable-state
- **Effort:** M
- **Design:** [Workspace write ownership](docs/rfc/TNS-109-workspace-write-ownership.md)

### TNS-112 · P2 · Local and setup requests bypass Host and Origin validation

- **Area:** Security
- **Where:** `src/http.rs:303`, `src/http.rs:1016`, `src/main.rs:66`, `src/auth.rs:124`, `src/api.rs:171`
- **Problem:** Normal local mode has no auth store, and setup uses default services. `authorize_request` immediately accepts either case without inspecting Host, Origin, or method. The existing `LoopbackDevelopment` policy has these checks but is not installed by those entry points. A compiled probe of the exact authorization function and real auth module accepted `PUT /api/v2/app/settings` with `Host: attacker.example:3000` and `Origin: http://attacker.example:3000`; applying the existing loopback policy rejected it and still accepted matching localhost headers. The missing gate is proven at the request boundary. Browser DNS-rebinding exploitation is unproven; its impact depends on a hostile hostname reaching loopback. Bootstrap supplies the identities needed for later vault requests, so identity headers are not an authorization substitute.
- **Recommendation:** Enforce an explicit request-origin policy in setup and normal local mode independently of session persistence. Require a loopback authority and matching local origin for local mutations. Reuse the existing policy and add transport cases for both entry points that reject foreign headers and accept legitimate local requests.
- **Fix with:** security
- **Effort:** S

### TNS-113 · P2 · Retrying a local create changes its payload under the same mutation ID

- **Area:** Data
- **Where:** `web/ts/app.ts:1511`, `web/ts/app.ts:1519`, `web/ts/app.ts:1547`, `web/ts/app.ts:1559`, `web/ts/app/local-draft-session.ts:146`, `src/vault.rs:1810`, `src/vault.rs:272`
- **Problem:** A pending local create checkpoints its mutation ID, source, title, and pending flag, but not its chosen path. Every retry recomputes `uniqueNotePath` from the current note list. If creation succeeds but its response or follow-up read fails, an SSE/bootstrap update can add that note before retry; the same mutation ID then carries a suffixed path and is rejected as `mutation_id_reuse`. The local draft remains pending and read-only, including after recovery. A probe of the actual promotion and event methods produced `meeting-notes.md` followed by `meeting-notes-2.md` under the same mutation ID. The current retry test keeps the note list unchanged and does not assert the whole request.
- **Recommendation:** Persist the complete immutable create request before first submission, including the selected path, and replay those fields through its terminal outcome. Version pending checkpoints explicitly and preserve source when an old checkpoint cannot reconstruct its request. Cover accepted creation with a lost response, then SSE/bootstrap, reload, and retry.
- **Fix with:** durable-state
- **Effort:** M

### TNS-114 · P2 · Reconciliation resurrects completed writes and rejects their exclusion

- **Area:** Data
- **Where:** `src/reconcile.rs:120`, `src/reconcile.rs:129`, `src/reconcile.rs:294`, `src/reconcile.rs:391`, `src/vault.rs:1351`, `src/vault.rs:1363`
- **Problem:** Missing-file recovery treats the latest user create/save/rename/import event as evidence of an unfinished write even when its mutation is already accepted. Deleting such a file externally recreates it. Excluding its folder omits the still-existing file from discovery, then attempts a no-clobber recreation and fails with `AlreadyExists`; settings were already committed, so later reconciliation keeps failing. An unchanged-module SQLite/filesystem probe completed a real save mutation, verified zero pending mutations, and reproduced both restoration after unlink and `File exists (os error 17)` after exclusion. A baseline-only deletion control correctly became a tombstone.
- **Recommendation:** Use explicit unfinished mutation state as the authority for materialization recovery. Distinguish excluded files from physically missing files; a completed user event or absence from the scan must not independently trigger creation. Preserve snapshots when tombstoning. Cover accepted save followed by external deletion and exclusion, alongside pending-save recovery.
- **Fix with:** durable-state
- **Effort:** M

### TNS-115 · P2 · Case-only external renames strand the original note identity

- **Area:** Data
- **Where:** `src/reconcile.rs:73`, `src/reconcile.rs:200`, `src/reconcile.rs:450`, `src/paths.rs:50`
- **Problem:** On a case-sensitive filesystem, `old.md` renamed externally to `Old.md` matches the original row by lowercase path key. Reconciliation consumes the file without updating its stored path. A subsequent note read/write preflight looks for nonexistent `old.md` and tombstones the original ID; the next scan imports `Old.md` under a new ID. Content survives, but tabs and revision history remain attached to the old identity. The real SQLite/filesystem probe reproduced all three steps for a unique file, without a case-collision pair.
- **Recommendation:** Separate the collision key from the observed path. Persist a unique case-only path change as an external rename before reconciling content. On a case-sensitive filesystem, verify repeated reconciliation and reopen preserve the original note ID and history.
- **Fix with:** durable-state
- **Effort:** S

### TNS-116 · P2 · Loupe enforces image byte limits after buffering the data

- **Area:** Security
- **Where:** `extension-loupe/src/tansu-import.ts:175`, `extension-loupe/src/tansu-import.ts:180`, `extension-loupe/src/tansu-import.ts:193`, `extension-loupe/src/tansu-import.ts:232`
- **Problem:** `fetchTansuImage` checks declared Content-Length but buffers the entire response before checking its actual size. Missing or misleading lengths defeat the 10 MiB resource bound. `prepareTansuImport` also retains every downloaded outcome before applying the 40 MiB aggregate cap. A real-module stream probe consumed all 20 MiB before returning `too-large`, without cancellation; a six-image article downloaded and retained six 10 MiB outcomes before selecting four. A hostile image server or image-heavy page can exhaust extension-worker memory before either limit takes effect. No actual out-of-memory crash was induced.
- **Recommendation:** Count bytes while streaming and cancel immediately at the per-image limit. Bound retained bytes as downloads complete while preserving deterministic source-order selection. Cancel rejected/retried response bodies and enforce image-count limits before starting downloads. Assert early cancellation and bounded retained bytes, not only final classification.
- **Fix with:** lifecycle-concurrency
- **Effort:** M

### TNS-117 · P2 · Search truncates candidates before filtering stale and overlaid notes

- **Area:** Data
- **Where:** `crates/tansu-search/src/search.rs:80`, `crates/tansu-search/src/search.rs:116`, `crates/tansu-search/src/service.rs:125`, `crates/tansu-search/src/service.rs:130`, `crates/tansu-search/src/service.rs:164`
- **Problem:** `search::execute` truncates to the requested limit before the service removes stale identities or canonical notes covered by dirty overlays. No later candidate is fetched to fill the vacated slots. Valid matching notes can therefore disappear, including a false empty result. A compiled probe against the actual search crate and vendored engine indexed two matching notes, requested one hit, and replaced the top note with a nonmatching overlay. The result was empty although the second note still matched. Excluding the top indexed identity from the current catalog produced the same empty result.
- **Recommendation:** Apply canonical eligibility and overlay suppression before the final result cap, or continue collecting candidates until enough eligible results exist or candidates are exhausted. Keep query, result, and resource bounds. Add both stale-top-hit and nonmatching-overlay cases with a lower-ranked valid match.
- **Fix with:** none
- **Effort:** M

### TNS-118 · P2 · Accepted uppercase Markdown extensions break reconciliation

- **Area:** Data
- **Where:** `src/paths.rs:44`, `src/reconcile.rs:305`, `src/reconcile.rs:129`, `src/vault.rs:1807`, `src/vault.rs:1904`
- **Problem:** Creation and rename accept `.MD` and `.Md` through `normalize_note_path`, while discovery includes only exactly lowercase `.md`. A valid uppercase-extension note is omitted from the next scan; the missing-file heuristic then attempts to recreate its existing path and fails with `AlreadyExists`. An unchanged-module probe validated `UPPER.MD`, wrote its real snapshot and file, inserted the live user-create row, and reproduced `File exists (os error 17)` during reconciliation. Fixing the missing-file heuristic alone would instead let these accepted notes disappear from the live catalog.
- **Recommendation:** Use one extension predicate for create, rename, and discovery, preserving already accepted spellings. Cover `.md`, `.Md`, and `.MD` through creation/rename, reconciliation, and reopen.
- **Fix with:** single-source-of-truth
- **Effort:** S

