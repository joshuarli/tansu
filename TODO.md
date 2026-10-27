# Tansu TODO

Prefix: TNS
Next: 86

### TNS-085 · P1 · Pending materialization publishes a source hash the file does not have

- **Area:** Data
- **Where:** `src/catalog.rs:338`, `src/vault.rs:1746`, `src/vault.rs:1426`, `src/vault.rs:2722`, `src/vault.rs:486`, `src/app.rs:39`
- **Problem:** `accept_note_content_mutation` stores the submitted `content_hash` and leaves `visible_hash` at the pre-image, then sets the mutation to `pending_materialization`. If the visible write fails, or the file changes before replace, `v2_save_source` returns `pendingMaterialization` and does not roll the catalog back (`src/vault.rs:1746`). `v2_open_note` then reads the visible file in `read_visible_or_snapshot` and pairs those bytes with the new catalog hash (`src/vault.rs:1431`, `src/vault.rs:2726`). The response body is not the accepted source. The same window exists for create and rename: the catalog path is committed before the file move, so open can 404 a note that `v2_notes` still lists. Restart repair rewrites the file when the bytes still match the pre-image (`startup_repairs_pending_content_mutation_before_reconciliation`). If they do not, `repair_pending_mutation` returns `Error::Internal` and `VaultRuntime::open` fails (`startup_pending_repair_preserves_unexpected_external_bytes`). `App::from_config` opens vaults with `?`, so one vault stops the process (`src/app.rs:39`). Proof is the control flow above, not a new run: this checkout has no `target/` or `node_modules`, so the existing tests were not executed. Priority assumed.
- **Recommendation:** While a mutation is `pending_materialization`, content reads must return the snapshot bytes for that source hash, or a pending error, and must not return other bytes under that hash. On startup, unexpected visible bytes must not fail sibling vaults. Record the note unresolved or as a conflict and keep the snapshot. Do not overwrite bytes that are neither the pre-image nor the candidate.
- **Fix with:** durable-state
- **Effort:** M
- **Design:** [docs/rfc/TNS-085-pending-materialization.md](docs/rfc/TNS-085-pending-materialization.md)
