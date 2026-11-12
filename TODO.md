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

