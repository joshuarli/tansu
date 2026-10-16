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
`getSnapshot()` reads the attached session. `getSessionSnapshot(session)` reads
any session of the editor, attached or not.
The change callback reports only the note ID, revision, and user-edit origin.
It fires for the session that changed, which is not always the attached one: an
image upload that finishes in a detached session reports that session. The app
reads the changed session's snapshot and does not assume the attached session
changed.

Attach and detach a session to switch notes without replacing the mounted view.
Each session keeps its own undo history. Selection and mode changes do not mark a
session dirty. Document changes do.

`undoStackMax` sets the history `minDepth`: each session keeps at least that many
undo steps, and CodeMirror trims in batches, so up to 20 more can remain.
`updateConfiguration({ undoStackMax })` applies to the active session at once and
to every other session when it is attached. It keeps the document and the
existing history; a lower value trims on the next edit.

`markSaved(session, revision)` clears dirty state only when that revision is
still current. `reloadIfClean(session, source)` refuses to replace a dirty
session. A clean reload replaces its `EditorState` and clears its undo history.

Source mode reconfigures the same document through a CodeMirror compartment. It
does not create a textarea or serialize the editor DOM.

The note title and tag controls render inside the scrolling editor header, in
that order before Markdown content. Live mode folds frontmatter by default.
The Frontmatter control appears before the tag controls and reveals the source
for editing. Source mode always shows the full document. The tag row follows
the active note and keeps its read-only state. Tag controls can update a
top-level `tags` field alongside other frontmatter fields. They preserve the
other fields and stay locked when the frontmatter is malformed or the tag
value uses unsupported syntax.

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
Editable live mode reveals syntax on the saved cursor line when focus moves to a
transient control. Read-only mode keeps margin notes rendered while selection
moves. Find highlights remain separate from the document selection and do not
change source or undo history.
Blank lines between Markdown paragraphs carry native paragraph spacing in the
rendered editor without changing source text.
CodeMirror measures wrapped lines without CSS pretty wrapping so rendered text
stays aligned with source positions. In editable live mode, hovering a Markdown
link shows a pill with its destination. The pill stays open briefly while the
pointer moves from the link, and remains open while the pointer is over it. Click
the pill to open the link through `onLinkClick`. Read-only links open directly
when you click them. The floating controls beside the vault selector toggle
reading mode and the light or dark theme; the theme choice persists in browser
storage.
The adapter shows a floating formatting toolbar centered above the selection
head. It hides the toolbar when the selection collapses or the session is
read-only.
Wiki links resolve against the configured active-vault notes. A leading `/`
selects a vault-root path. `./` and `../` paths resolve from the current note's
directory. A bare basename resolves only when it matches one note. Ambiguous
targets remain unresolved. Clicking a resolved wiki link opens its note. Link
labels and status refresh when a note is created, renamed, retitled, or deleted,
and when the current note's path changes.

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
In editable live mode, click a marker to reveal its source definition. In
read-only mode, click a marker to show or hide the rendered note text. Selection
does not reveal note source in read-only mode. Source mode shows the original
Markdown. Unmatched references, duplicate definitions, code blocks, and
frontmatter stay unchanged.

Copy and cut read the selected source ranges from CodeMirror's document. Plain
text paste goes through CodeMirror. Rich HTML paste passes through
`sanitizeHtmlToMarkdown`, which removes active elements, event attributes, and
unsafe URLs before converting supported HTML to Markdown.

When `uploadPastedImage` is configured, image paste keeps WebP clipboard bytes
as-is and converts other clipboard files to WebP at the configured
`imageWebpQuality` (0 to 1, read when each paste converts; a conversion without it
fails the paste). It passes the blob, note ID,
source revision, selection, and an abort signal to the upload callback. The
callback returns the server's `z-images/`
asset name and wiki-image Markdown. The adapter displays a local image preview
immediately in live and source mode, before conversion or upload begins. It
inserts the returned Markdown only into the captured session and selection
while the source revision is still current.
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
position and fades the highlight between headings. The outline and the
margin-note layout derive from the syntax tree once per document and tree
version and are reused across selection, scroll, and viewport updates; only a
document change or a newer syntax tree rebuilds them.
Tag updates edit the top-level `tags` field and leave all other frontmatter and
the Markdown body unchanged. Tansu reads only tag metadata from frontmatter.

## Dependencies and fixture

`package.json` pins the CodeMirror and Lezer packages used by the adapter.
`pnpm-lock.yaml` resolves one `@codemirror/state` instance. Tansu vendors the
Atomic source closure, CSS, and MIT license under
`web/ts/editor/vendor/atomic/`. `UPSTREAM.md` records the upstream commit and
local patches. The vendor tree omits Atomic's React component and language
packages. Tansu also vendors the non-SIMD encoder from
[`@jsquash/webp` 1.5.0](https://github.com/jamsinclair/jSquash) under
`web/ts/editor/vendor/jsquash-webp/`. Tansu's `encode.js` takes the quality as
its second argument. The JavaScript is Apache-2.0 licensed.
The libwebp codec is BSD-3-Clause licensed. The app serves its encoder and
281 KB WebAssembly file as separate immutable assets under a directory named
by a hash of their contents, so a changed encoder gets new URLs. It loads them
only when a pasted image needs conversion.

Build the fixture page with Vite 8:

```sh
node web/ts/editor/harness/build.mjs
```

The build fails if the fixture bundle contains React or more than one
`@codemirror/state` instance. The output goes to `.work/tmp/editor-harness/`.

Run the focused adapter tests with:

```sh
pnpm exec vitest run web/ts/editor/tests/editor-session.test.ts web/ts/editor/tests/editor-source-operations.test.ts web/ts/editor/tests/image-paste.test.ts
```
