# Markdown editor

`web/ts/editor/codemirror-adapter.ts` defines Tansu's CodeMirror adapter.
`createCodeMirrorEditor` mounts one `EditorView` and creates a separate
`EditorState` for each open note. CodeMirror owns the Markdown source and
transactions. The DOM is a view and never supplies saved source.

The app still imports `web/ts/editor/index.ts`. That entry point keeps current
app callers working while they move to the CodeMirror adapter. Keep the old
engine and its tests until the app cutover and test review are complete.

## Source and sessions

Each session stores the full LF source, including frontmatter. CodeMirror
selection offsets use UTF-16 units. The adapter returns source, revision,
selection, mode, scroll position, read-only state, and dirty state in one
snapshot. It materializes the source string on demand and caches it by revision.
The change callback reports only the note ID, revision, and user-edit origin.

Attach and detach a session to switch notes without replacing the mounted view.
Each session keeps its own undo history. Selection and mode changes do not mark a
session dirty. Document changes do.

`markSaved(session, revision)` clears dirty state only when that revision is
still current. `reloadIfClean(session, source)` refuses to replace a dirty
session. A clean reload replaces its `EditorState` and clears its undo history.

Source mode reconfigures the same document through a CodeMirror compartment. It
does not create a textarea or serialize the editor DOM.

## Read-only sessions

Read-only sessions use both `EditorState.readOnly` and a transaction filter.
The filter rejects every document-changing transaction while allowing selection
changes. Tansu also checks the read-only facet before its task, table, and image
controls dispatch edits. This blocks extension dispatches that bypass
`EditorState.readOnly`.

## Markdown behavior

The adapter keeps authored source while CodeMirror renders live decorations.
Enable wiki links with `createWikiLinkExtension()`. Wiki links resolve against
the configured active-vault notes. A leading `/`
selects a vault-root path. `./` and `../` paths resolve from the current note's
directory. A bare basename resolves only when it matches one note. Ambiguous
targets remain unresolved.

Wiki images use `![[name]]` or `![[name|320]]`. The configured URL resolver
maps an opaque vault-local asset name to a URL. Dragging the resize handle
replaces only that image construct in one undoable transaction. Widths stay
between 48 and 2,400 pixels.

Callouts use `> [!type] Title`. The adapter decorates valid headers and leaves
malformed syntax as authored Markdown. Frontmatter remains in the document.

Copy and cut read the selected source ranges from CodeMirror's document. Plain
text paste goes through CodeMirror. Rich HTML paste passes through
`sanitizeHtmlToMarkdown`, which removes active elements, event attributes, and
unsafe URLs before converting supported HTML to Markdown.

Atomic table edits resolve the current syntax-tree range for the edited cell.
They replace only that cell's source span. Find treats the query as literal
text, uses smart case, and returns UTF-16 source ranges. The outline reads
headings from the Markdown syntax tree and skips frontmatter and fenced code.
Tag updates edit only tags-only frontmatter. They leave the body and all other
source unchanged.

## Dependencies and fixture

`package.json` pins the CodeMirror and Lezer packages used by the adapter.
`pnpm-lock.yaml` resolves one `@codemirror/state` instance. Tansu vendors the
Atomic source closure, CSS, and MIT license under
`web/ts/editor/vendor/atomic/`. `UPSTREAM.md` records the upstream commit and
local patches. The vendor tree omits Atomic's React component and language
packages.

Build the fixture page with the same esbuild dependency used by the app:

```sh
node web/ts/editor/harness/build.mjs
```

The build fails if the fixture bundle contains React or more than one
`@codemirror/state` instance. The output goes to `.work/tmp/editor-harness/`.

Run the focused adapter tests with:

```sh
pnpm exec vitest run web/ts/editor/tests/editor-session.test.ts web/ts/editor/tests/editor-source-operations.test.ts
```
