# Migration

Tansu2 scans Markdown files in a configured vault and assigns durable `noteId`s
in app-managed state. Back up an existing vault before the first run.

## Before the first run

1. Back up the vault.
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

Tansu2 does not write hidden IDs into Markdown files. It stores catalog, history,
and search state in the configured data directory. See
[Configuration](configuration.md) for the path.

If the vault contains earlier Tansu2 state in `.tansu/` and app-managed state
has no `vault.db`, startup copies that state to the app data directory. This
does not import revision or settings formats from other note applications.

## Unresolved files

Reconciliation records invalid UTF-8, case-colliding paths, corrupt or missing
snapshots, and catalog/file mismatches as unresolved. Unresolved files do not
appear in the normal note list, and the app has no UI to inspect or repair them.
It does not overwrite visible Markdown from a corrupt or missing snapshot.
Exact-hash moves preserve identity only when the match is unambiguous.
Moved-and-edited files become a delete plus a new note.

Importing other applications' revision formats remains deferred. See
[Deferred features](product-backlog.md).
