# TNS-085: Pending materialization reads and startup

Status: accepted

## Summary

A note mutation commits its catalog row before its visible file step finishes. If that step fails, the mutation stays `pending_materialization`. The note's per-note reads and writes did not account for that state. Startup aborted the vault when the visible bytes matched neither the pre-image nor the candidate.

## Motivation

`accept_note_content_mutation` stores the candidate `content_hash` and keeps `visible_hash` at the pre-image. Create and rename commit the new path before the file exists there.

Two reconcilers then disagreed about the same pending row. `reconcile_vault`, which runs on watcher events and at startup, rewrote the visible file from the accepted snapshot. `reconcile_note_before_write`, which runs before every per-note read and write, saw old bytes under the new hash and marked the note `file_catalog_mismatch`. It also tombstoned a pending create or rename because the visible path was missing. Opening a note during the pending window therefore destroyed it. A later replay materialized the file but left the note unresolved. An unresolved row also frees its path, so the next reconcile imported the file as a new note.

At startup, `materialize_pending_file` and `move_pending_file` returned `Error::Internal` for unexpected bytes, and `VaultRuntime::open` failed.

## Design

The pending repair is the only code that touches a note with a pending mutation, and it always ends the mutation.

Before any per-note reconcile, the server repairs that note's pending mutations, using the same repair as mutation replay. The repair publishes its event and updates search. A read during the pending window then returns the materialized document with a matching `diskHash`. If the visible write still fails with an I/O error, the request fails with `409 pending_materialization` and carries `noteId` and `operationId`. The catalog row is unchanged and the client keeps its pending state. Watcher reconciliation repairs every pending mutation before `reconcile_vault` runs.

Repair resolves each kind against the visible bytes:

| Kind | Visible state | Result |
| --- | --- | --- |
| any | accepted snapshot missing or corrupt | note unresolved (`missing_snapshot` or `corrupt_snapshot`) |
| save, save delta, restore | candidate, pre-image, or missing | candidate written; `accepted` |
| save, save delta, restore | other valid UTF-8 | external edit recorded; candidate kept as a conflict draft; `conflict` |
| save, save delta, restore | invalid UTF-8 | note unresolved (`invalid_utf8`) |
| create | candidate or missing | candidate written; `accepted` |
| create | other bytes | note unresolved (`file_catalog_mismatch`); reconcile imports the file as a separate note |
| rename | destination free or candidate | move finished; an externally edited source file is left in place; `accepted` |
| rename | destination occupied and source intact, or source edited and destination free | catalog path reverted to the source |
| rename | destination occupied and source not intact | note unresolved (`file_catalog_mismatch`) |
| delete | expected bytes or missing | file removed; `accepted` |
| delete | other bytes | file kept; `accepted`; reconcile imports it as a new note |

The conflict outcome is written in one catalog transaction: the external-edit revision, the conflict draft, the mutation state, and the vault event. The draft's base is the content revision before the accepted save. A replay of the mutation returns the same `conflict` response.

The unresolved and reverted-rename outcomes delete the mutation record in the same transaction that changes the note. A replay then runs as a new request. It fails with `unresolved_note` for an unresolved note and `path_collision` for a reverted rename.

A visible file that is missing during repair is written from the snapshot. This matches `reconcile_vault`, which restores a missing file whose last event came from the user.

## Alternatives considered

Leave the catalog unchanged until the visible write finishes. A crash after the write and before the catalog commit leaves a new file under the old catalog row, which reconciliation treats as an external edit. The snapshot-first order exists to avoid that.

Return the accepted snapshot as a normal document during the pending window. The document then carries a `diskHash` that names neither its bytes nor the visible file, which poisons the next save's `baseDiskHash`.

Mark the note unresolved on unexpected startup bytes. That hides the note from `v2_notes`, frees its path for import as a new note, and leaves the accepted revision reachable only by note ID. A conflict draft keeps identity and lets the user merge.

## Decision

Accepted as designed above.

Out of scope: an I/O failure while materializing at startup still fails that vault's open, and `App::from_config` still stops on the first vault that fails. Isolating vaults from each other needs a degraded-vault representation and is a separate design.
