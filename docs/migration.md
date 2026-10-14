# Migration

Tansu2 scans Markdown files in a configured vault and assigns durable `noteId`s
in app-managed state. Back up both the vault and app data before the first run.

## Before the first run

1. Stop Tansu2 and back up the vault, app data directory, and config file.
2. Read [Configuration](configuration.md) and add the vault.
3. Check that the vault is not nested inside another configured vault.
4. Confirm Markdown files are UTF-8 and no paths differ only by letter case.
5. Keep existing `z-images/` assets in place.
6. Start Tansu2 and let startup reconciliation finish before editing.

## First scan

For each valid UTF-8 `.md` file, Tansu2 creates a generated `noteId`, metadata
for its path, title, and tags, and a baseline history snapshot. It also creates
a search document when indexing succeeds. Titles come from the first H1 or
filename stem. The parser reads tags from tags-only frontmatter. It leaves other
frontmatter in document content.

Tansu2 does not write hidden IDs into Markdown files. It stores the catalog and
revision snapshots under `tansu/vaults/<vaultId>/` in the configured data
directory. The search index is derived state. See
[Configuration](configuration.md) for the data path.

A baseline scan reads Markdown and writes app metadata. It does not rewrite
visible files or add hidden IDs.

On first startup, Tansu2 assigns a stable ID to each canonical vault root and
copies any prior app state into the new ID-based directory when needed. It also
copies legacy `.tansu/` state when that directory has a `vault.db` and no app
catalog exists. These copies do not remove the old state. Keep your backup until
you confirm the notes, history, and settings are present. This does not import
revision or settings formats from other note applications.

## Run the state migration

Stop Tansu2 before migrating. Preview the configured vaults and destination
with `tansu2 migrate --dry-run /path/to/config.toml`. When the report is correct,
run `tansu2 migrate /path/to/config.toml`. The command copies existing
application state to a unique sibling backup before creating the stable
vault-ID directories; it preserves the original state. Keep the backup until
you have confirmed the app opens the expected notes, history, and settings.
The migration command operates on the paths in the config, so run it as the
same local account that owns those files and do not run it concurrently with
other processes changing the config or app data.

The new catalog may not be readable by an older Tansu2 build. To roll back,
stop the server and restore the matching app data and config backup along with
the old binary. The Markdown files remain ordinary vault files, but restoring
only app data or only vault files can leave catalog and file contents out of
sync. Never point an older build at state changed by a newer build without a
verified backup.

## Unresolved files

Reconciliation records invalid UTF-8, case-colliding paths, corrupt or missing
snapshots, and catalog/file mismatches as unresolved. Unresolved files do not
appear in the normal note list, and the app has no UI to inspect or repair them.
It does not overwrite visible Markdown from a corrupt or missing snapshot.
Exact-hash moves preserve identity only when the match is unambiguous.
Moved-and-edited files become a delete plus a new note.

Importing other applications' revision formats remains deferred. See
[Deferred features](product-backlog.md).
