# Migration

Tansu scans Markdown files in each configured vault and assigns durable
`noteId`s in app-managed state. Back up both the vault and app data before the
first run.

## First run

1. Back up the vault and app data directory.
2. Start Tansu and add the vault in the first-run setup page.
3. Check that the vault is not nested inside another configured vault.
4. Confirm Markdown files are UTF-8 and no paths differ only by letter case.
5. Keep existing `z-images/` assets in place.
6. Let startup reconciliation finish before editing.

For each valid UTF-8 `.md` file, Tansu creates a generated `noteId`, metadata
for its path, title, and tags, and a baseline history snapshot. It also creates
a search document when indexing succeeds. Titles come from the first H1 or
filename stem. The parser reads tags from tags-only frontmatter and leaves
other frontmatter in document content.

Tansu does not write hidden IDs into Markdown files. It stores the catalog and
revision snapshots under `tansu/vaults/<vaultId>/` in the configured data
directory. The search index is derived state. See
[Configuration](configuration.md) for the data path.

On startup, Tansu assigns a stable ID to each canonical vault root and copies
prior app state into the ID-based directory when needed. It can also copy
legacy `.tansu/` state when that directory has a `vault.db` and the destination
is absent or empty. These copies preserve the old state. This does not import
`config.toml` or revision formats from other note applications. Existing
installations must add their vaults in the setup page or with
`tansu config init`.

The new catalog may not be readable by an older Tansu build. To roll back,
stop the server and restore the matching settings database, app data, and
vault backup with the old binary. Restoring only app data or only vault files
can leave catalog and file contents out of sync. Never point an older build at
state changed by a newer build without a verified backup.

## Unresolved files

Reconciliation records invalid UTF-8, case-colliding paths, corrupt or missing
snapshots, and catalog/file mismatches as unresolved. Unresolved files do not
appear in the normal note list, and the app has no UI to inspect or repair
them. It does not overwrite visible Markdown from a corrupt or missing
snapshot. Exact-hash moves preserve identity only when the match is
unambiguous. Moved-and-edited files become a delete plus a new note.

Importing other applications' revision formats remains deferred. See
[Deferred features](product-backlog.md).
