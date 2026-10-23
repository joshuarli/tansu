# Markdown editor

`web/ts/editor/codemirror-adapter.ts` defines Tansu's CodeMirror adapter. The
editor source is the full Markdown document, including frontmatter, with LF
line endings. CodeMirror owns that source; the rendered DOM is never saved.

## Sessions and source

The mounted editor view keeps a separate state and undo history for each open
note. Selection, mode, and scroll state belong to the session. Document edits
make it dirty; selection and mode changes do not. The app marks a session saved
only when the saved revision is still current. Clean reloads replace the state
and clear its undo history; dirty sessions are not replaced.

Source mode shows Markdown source in the same editor. Live mode renders Markdown
decorations without changing source. Frontmatter stays folded and cannot be
created or edited through the editor in either mode. The UI does not display
frontmatter-derived tags. Tansu preserves frontmatter in the Markdown source and
continues to read tags from it.

Click the note title to edit its name in place. Leaving the field attempts the
rename; failures show a notification and restore the prior name. Successful
renames update the tab and briefly flash the title green.
For a new note, Enter submits the title and creates the note.

Clicking rendered Markdown link text opens the destination in a new tab without
moving the editor cursor into the link. Shift-click selects the visible link
label without opening it or selecting the destination URL.

Read-only sessions reject every document-changing transaction, including
extension-dispatched changes, while allowing selection changes. Editor controls
also check the read-only state before dispatching edits.

## Markdown behavior

The live editor reveals Markdown syntax on the active line. It supports a
selection toolbar and a `/` block menu for headings, lists, quotes, callouts,
code blocks, tables, and dividers. Dividers use `***` so a divider at the start
of a document cannot be read as an opening frontmatter delimiter. Moving a
top-level block rewrites its full source span as one undoable edit; frontmatter
cannot be moved.

Inline preview caches decoration-relevant syntax nodes for the current parse
tree. Selection changes reuse that list while recalculating active-line and link
visibility. Document edits and parser growth build a new list.

Wiki links resolve against notes in the active vault. `/` starts at the vault
root; `./` and `../` resolve from the current note's directory. A bare basename
resolves only when it matches one note. Ambiguous links remain unresolved.
Renaming a note preserves its `noteId` and does not rewrite Markdown links that
mention its old path. The [API link rules](api.md#links-and-previews) use the
same resolution behavior.

When configured with `loadNotePreview`, hovering a resolved wiki link loads a
preview. Leaving the link aborts a pending load. Unresolved links and failed
loads show no preview. The adapter receives a callback and does not import app
code.

Wiki images use `![[name]]` or `![[name|width]]`. Local Markdown images can be
resized and are rewritten as wiki-image syntax; remote HTTP images cannot be
resized. A resize preview does not change source until release, which writes
one undoable edit. Cancellation leaves source unchanged.

Image paste keeps WebP clipboard bytes and converts other image files to WebP
using the configured quality. It previews the image immediately and passes an
abort signal to the upload callback. Returned Markdown is inserted only into
the captured session while its source revision remains current. Edits, reloads,
read-only changes, and editor disposal invalidate the upload. The preview URL
is revoked when the operation ends or the editor is disposed.

Copy and cut use selected source ranges. Plain text paste goes through
CodeMirror. Rich HTML paste passes through `sanitizeHtmlToMarkdown`, which
removes active elements, event attributes, and unsafe URLs before conversion.

Callouts use `> [!type] Title`; malformed headers remain authored Markdown.
Margin notes use a footnote reference and a matching top-level definition on
one line. Duplicate labels and references inside code or frontmatter remain
unchanged. A bare HTTP(S) URL renders as a card in live mode without adding a
marker to the source. Find highlights literal text without changing selection
or undo history. The outline reads headings from the Markdown syntax tree.

## Source and tests

The editor boundary owns Markdown rendering, selection, source mode, undo,
formatting, paste handling, and editor extensions. The app owns note lifecycle,
persistence, assets, and session state. Focused adapter tests are listed in
[Testing](testing.md); they live under `web/ts/editor/tests/`.

Vendored editor code and licenses live under `web/ts/editor/vendor/`. Read the
upstream and license files there before changing a vendored dependency.
