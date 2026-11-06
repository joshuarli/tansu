# Tansu TODO

Prefix: TNS
Next: 108

### TNS-085 · P1 · Pending materialization publishes a source hash the file does not have

- **Area:** Data
- **Where:** `src/catalog.rs:338`, `src/vault.rs:1746`, `src/vault.rs:1426`, `src/vault.rs:2722`, `src/vault.rs:486`, `src/app.rs:39`
- **Problem:** `accept_note_content_mutation` stores the submitted `content_hash` and leaves `visible_hash` at the pre-image, then sets the mutation to `pending_materialization`. If the visible write fails, or the file changes before replace, `v2_save_source` returns `pendingMaterialization` and does not roll the catalog back (`src/vault.rs:1746`). `v2_open_note` then reads the visible file in `read_visible_or_snapshot` and pairs those bytes with the new catalog hash (`src/vault.rs:1431`, `src/vault.rs:2726`). The response body is not the accepted source. The same window exists for create and rename: the catalog path is committed before the file move, so open can 404 a note that `v2_notes` still lists. Restart repair rewrites the file when the bytes still match the pre-image (`startup_repairs_pending_content_mutation_before_reconciliation`). If they do not, `repair_pending_mutation` returns `Error::Internal` and `VaultRuntime::open` fails (`startup_pending_repair_preserves_unexpected_external_bytes`). `App::from_config` opens vaults with `?`, so one vault stops the process (`src/app.rs:39`). Proof is the control flow above, not a new run: this checkout has no `target/` or `node_modules`, so the existing tests were not executed. Priority assumed.
- **Recommendation:** While a mutation is `pending_materialization`, content reads must return the snapshot bytes for that source hash, or a pending error, and must not return other bytes under that hash. On startup, unexpected visible bytes must not fail sibling vaults. Record the note unresolved or as a conflict and keep the snapshot. Do not overwrite bytes that are neither the pre-image nor the candidate.
- **Fix with:** durable-state
- **Effort:** M
- **Design:** [docs/rfc/TNS-085-pending-materialization.md](docs/rfc/TNS-085-pending-materialization.md)

### TNS-098 · P3 · Block drag moves the wrong block if the document changes mid-drag

- **Area:** Concurrency
- **Where:** `web/ts/editor/block-drag.ts:97-99`, `web/ts/editor/block-drag.ts:166`, `web/ts/editor/block-drag.ts:192-198`
- **Problem:** `pointerdown` on the grip stores `dragging = { index, gap }`. On `docChanged`, `update` hides the grip but leaves `dragging` set. On `pointerup`, `moveBlock(view, drag.index, drag.gap)` reads the current blocks, so if typing or a remote reload changed the document during the drag, it moves whatever block now sits at the old index. Priority assumed.
- **Recommendation:** End the drag in `update` when `docChanged`.
- **Fix with:** none
- **Effort:** S

### TNS-106 · P4 · Slash menu selection goes out of range when a cursor move shrinks the list

- **Area:** Types
- **Where:** `web/ts/editor/slash-menu.ts:105-128`, `web/ts/editor/slash-menu.ts:222`
- **Problem:** `selected` resets only on `docChanged`, and it is clamped only when a `moveSlash` effect applies. With text after the cursor (`/|head`), the user arrows down to item 3, and ArrowRight extends the query to `h` without changing the document. The list shrinks, `selected` stays 3, and no row is highlighted. `selectedBlock` then returns null, so Enter inserts a newline. Priority assumed.
- **Recommendation:** Reset or clamp `selected` whenever the filtered list changes, not only on `docChanged`.
- **Fix with:** none
- **Effort:** S
