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

### TNS-113 · P2 · Retrying a local create changes its payload under the same mutation ID

- **Area:** Data
- **Where:** `web/ts/app.ts:1511`, `web/ts/app.ts:1519`, `web/ts/app.ts:1547`, `web/ts/app.ts:1559`, `web/ts/app/local-draft-session.ts:146`, `src/vault.rs:1810`, `src/vault.rs:272`
- **Problem:** A pending local create checkpoints its mutation ID, source, title, and pending flag, but not its chosen path. Every retry recomputes `uniqueNotePath` from the current note list. If creation succeeds but its response or follow-up read fails, an SSE/bootstrap update can add that note before retry; the same mutation ID then carries a suffixed path and is rejected as `mutation_id_reuse`. The local draft remains pending and read-only, including after recovery. A probe of the actual promotion and event methods produced `meeting-notes.md` followed by `meeting-notes-2.md` under the same mutation ID. The current retry test keeps the note list unchanged and does not assert the whole request.
- **Recommendation:** Persist the complete immutable create request before first submission, including the selected path, and replay those fields through its terminal outcome. Version pending checkpoints explicitly and preserve source when an old checkpoint cannot reconstruct its request. Cover accepted creation with a lost response, then SSE/bootstrap, reload, and retry.
- **Fix with:** durable-state
- **Effort:** M

### TNS-116 · P2 · Loupe enforces image byte limits after buffering the data

- **Area:** Security
- **Where:** `extension-loupe/src/tansu-import.ts:175`, `extension-loupe/src/tansu-import.ts:180`, `extension-loupe/src/tansu-import.ts:193`, `extension-loupe/src/tansu-import.ts:232`
- **Problem:** `fetchTansuImage` checks declared Content-Length but buffers the entire response before checking its actual size. Missing or misleading lengths defeat the 10 MiB resource bound. `prepareTansuImport` also retains every downloaded outcome before applying the 40 MiB aggregate cap. A real-module stream probe consumed all 20 MiB before returning `too-large`, without cancellation; a six-image article downloaded and retained six 10 MiB outcomes before selecting four. A hostile image server or image-heavy page can exhaust extension-worker memory before either limit takes effect. No actual out-of-memory crash was induced.
- **Recommendation:** Count bytes while streaming and cancel immediately at the per-image limit. Bound retained bytes as downloads complete while preserving deterministic source-order selection. Cancel rejected/retried response bodies and enforce image-count limits before starting downloads. Assert early cancellation and bounded retained bytes, not only final classification.
- **Fix with:** lifecycle-concurrency
- **Effort:** M


