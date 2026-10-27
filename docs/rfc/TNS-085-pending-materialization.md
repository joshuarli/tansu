# TNS-085: Pending materialization reads and startup

Status: draft

## Summary

A save can commit the new source hash before the visible file matches it. Readers then see the old bytes under the new hash. If those bytes change before restart, opening that vault fails and the process does not start.

## Motivation

`accept_note_content_mutation` updates `content_hash` and marks the mutation `pending_materialization` before `write_visible_note_bytes_atomic`. A failed write returns `pendingMaterialization` without restoring the previous catalog row. `v2_open_note` reads the visible file and labels it with the catalog hash.

Restart finishes the write when the file is still the pre-image. `materialize_pending_file` returns `Error::Internal` when the bytes are neither the pre-image nor the candidate. `App::from_config` stops on the first vault that fails to open.

The accepted snapshot is still on disk. The failure mode throws away serving every vault, and the in-process read lies about which bytes that hash names.

## Design

Content reads for a note with `pending_materialization` return the snapshot for the mutation's source hash. They do not return the visible file unless its disk hash is the candidate hash.

Startup still materializes a pending write when the visible bytes are missing or equal the recorded pre-image. When the bytes are anything else, the note becomes unresolved, the snapshot stays, and the other vaults open. Unexpected bytes are not replaced.

## Alternatives considered

Leave the catalog unchanged until the visible write finishes. A crash after the write and before the catalog commit can leave a new file with the old catalog row. Reconciliation already treats that as an external edit, which can drop the accepted identity. The snapshot-first order exists to avoid that.

Fail the process, as today. That preserves unexpected bytes, and it also takes down every vault with no documented repair short of editing `vault.db` or restoring a backup.

Return the stale file and the old hash until materialization finishes. That matches the file, and it hides an accepted revision from clients that key off `sourceHash`.

## Open questions

Should unexpected bytes at startup be an unresolved note, or a conflict draft beside the accepted snapshot?

Should a read during pending return the snapshot document, or a dedicated pending error with no body?

## Decision

Not accepted. Recommendation: return the snapshot on read, and mark only that note unresolved when startup finds unexpected bytes.
