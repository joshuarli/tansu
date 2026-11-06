# Tansu TODO

Prefix: TNS
Next: 109

### TNS-108 · P2 · One vault that fails to open stops every vault

- **Area:** Operability
- **Where:** `src/app.rs:39`, `src/vault.rs:982`, `src/vault.rs:451`
- **Problem:** `App::from_config` opens vaults with `?`, so the first `VaultRuntime::open` error aborts the process and no vault is served. Startup pending repair now resolves unexpected bytes per note, but an I/O error while materializing a pending write (`repair_pending_mutations` → `write_visible_note_bytes_*`) still fails that vault's open. So does any other open error: catalog open, owner lock, reconcile. A disk problem under one vault takes down unrelated vaults. Reached by control flow, not reproduced.
- **Recommendation:** Open each vault independently and keep the failed ones as an explicit degraded entry (vault ID, name, error) that bootstrap lists and vault routes reject with a typed error, instead of skipping them silently. Leave a pending mutation whose write fails at startup pending, rather than failing the open, once reconcile skips notes that a pending mutation owns.
- **Fix with:** error-model
- **Effort:** M
