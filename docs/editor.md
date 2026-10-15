# Markdown editor

`web/ts/editor/codemirror-adapter.ts` defines Tansu's CodeMirror adapter.
`createCodeMirrorEditor` mounts one `EditorView` and creates a separate
`EditorState` for each open note. CodeMirror owns the Markdown source and
transactions. The DOM is a view and never supplies saved source.

The app imports the CodeMirror adapter directly. The fixture large-note
benchmark uses the same adapter.

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

The note title and tag controls render inside the scrolling editor header, in
that order before Markdown content. Live mode folds frontmatter by default.
The Frontmatter control appears before the tag controls and reveals the source
for editing. Source mode always shows the full document. The tag row follows
the active note and keeps its read-only and frontmatter-lock states.

## Read-only sessions

Read-only sessions use both `EditorState.readOnly` and a transaction filter.
The filter rejects every document-changing transaction while allowing selection
changes. Tansu also checks the read-only facet before its task, table, and image
controls dispatch edits. This blocks extension dispatches that bypass
`EditorState.readOnly`.

## Markdown behavior

The adapter keeps authored source while CodeMirror renders live decorations.
Decorations cover the full document, including content outside the viewport.
Word edits and caret moves in plain paragraphs map existing decorations; edits
that can affect Markdown syntax rebuild them from the syntax tree.
Syntax on the saved cursor line stays revealed when focus moves to a transient
control. Find highlights remain separate from the document selection and do not
change source or undo history.
Blank lines between Markdown paragraphs carry native paragraph spacing in the
rendered editor without changing source text.
The adapter shows a floating formatting toolbar centered above the selection
head. It hides the toolbar when the selection collapses or the session is
read-only.
Enable wiki links with `createWikiLinkExtension()`. Wiki links resolve against
the configured active-vault notes. A leading `/`
selects a vault-root path. `./` and `../` paths resolve from the current note's
directory. A bare basename resolves only when it matches one note. Ambiguous
targets remain unresolved.

Renaming a note changes its path and keeps its `noteId`. Tansu2 does not rewrite
Markdown links that mention the old path.

Wiki images use `![[name]]` or `![[name|320]]`; this is the only width syntax.
Vault images written as standard Markdown can be resized with the same handle
or pinch gesture. Resizing one rewrites its source to wiki-image syntax.
HTTP and HTTPS image URLs remain remote and cannot be resized.
The editor previews the width without changing Markdown during the gesture.
Release writes one undoable source edit in the canonical wiki-image form.
Cancellation leaves Markdown unchanged. Widths stay between 48 and 2,400 pixels
or the editor content width, whichever is smaller.

The editor shares the shell's system font and color tokens. Wide Markdown tables
keep each cell on one line and scroll horizontally inside the editor.

Callouts use `> [!type] Title`. The adapter decorates valid headers and leaves
malformed syntax as authored Markdown. Frontmatter remains in the document.

Margin notes use a footnote reference and a matching top-level definition on one
line: `Text[^label]` and `[^label]: Note text`. Labels are case-insensitive and
must be unique. Live mode shows a numbered marker and the note beside its first
reference at viewport widths of 1440 pixels or more. Narrower screens place the
note under the reference.
Click a marker to reveal its source definition. Source mode shows the original
Markdown. The note body is displayed as plain text. Unmatched references,
duplicate definitions, code blocks, and frontmatter stay unchanged.

Copy and cut read the selected source ranges from CodeMirror's document. Plain
text paste goes through CodeMirror. Rich HTML paste passes through
`sanitizeHtmlToMarkdown`, which removes active elements, event attributes, and
unsafe URLs before converting supported HTML to Markdown.

When `uploadPastedImage` is configured, image paste keeps WebP clipboard bytes
as-is and converts other clipboard files to WebP. It passes the blob, note ID,
source revision, selection, and an abort signal to the upload callback. The
callback returns the server's `z-images/`
asset name and wiki-image Markdown. The adapter displays a temporary image
preview while the upload runs. It inserts the returned Markdown only into the
captured session and selection while the source revision is still current.
An intervening edit, clean reload, or read-only change aborts the request and
reports it as stale. The state callback reports uploading, inserted, stale,
and failed states. Its preview object URL is revoked on every terminal state
and when the editor is disposed; upload callbacks must honor the abort signal to
stop their request on invalidation or disposal.

Atomic table edits resolve the current syntax-tree range for the edited cell.
They replace only that cell's source span. Find treats the query as literal
text, uses smart case, and returns UTF-16 source ranges. The outline reads
headings from the Markdown syntax tree and skips frontmatter and fenced code.
As the editor scrolls, the outline highlights the heading at the reading
position and fades the highlight between headings.
Tag updates edit only tags-only frontmatter. They leave the body and all other
source unchanged.

## Dependencies and fixture

`package.json` pins the CodeMirror and Lezer packages used by the adapter.
`pnpm-lock.yaml` resolves one `@codemirror/state` instance. Tansu vendors the
Atomic source closure, CSS, and MIT license under
`web/ts/editor/vendor/atomic/`. `UPSTREAM.md` records the upstream commit and
local patches. The vendor tree omits Atomic's React component and language
packages. Tansu also vendors the non-SIMD encoder from
[`@jsquash/webp` 1.5.0](https://github.com/jamsinclair/jSquash) under
`web/ts/editor/vendor/jsquash-webp/`. The JavaScript is Apache-2.0 licensed.
The libwebp codec is BSD-3-Clause licensed. The app serves its encoder and
281 KB WebAssembly file as separate assets and loads them only when a pasted
image needs conversion.

Build the fixture page with the same esbuild dependency used by the app:

```sh
node web/ts/editor/harness/build.mjs
```

The build fails if the fixture bundle contains React or more than one
`@codemirror/state` instance. The output goes to `.work/tmp/editor-harness/`.

Run the focused adapter tests with:

```sh
pnpm exec vitest run web/ts/editor/tests/editor-session.test.ts web/ts/editor/tests/editor-source-operations.test.ts web/ts/editor/tests/image-paste.test.ts
```
