# Architecture

## The line-based DOM model

**Invariant: one `<p>` element per line of plain text.**

This aligns the DOM editing primitive (Enter creates a new `<p>`) with the markdown storage primitive (`\n` separates lines):

| Markdown     | DOM                                                    |
| ------------ | ------------------------------------------------------ |
| `foo\nbar`   | `<p>foo</p><p>bar</p>`                                 |
| `foo\n\nbar` | `<p>foo</p><p data-md-blank="true"><br></p><p>bar</p>` |

Enter in the content editor creates a new `<p>` (browser default), which round-trips to `\n`. No Enter interception is needed for plain text.

**Do not put `<br>` inside `<p>` elements for line breaks.** A `<br>` inside a `<p>` serializes as an inline `\n`, which would round-trip as two lines packed into one block, then duplicate the newline on the next save.

### Blank lines

A blank line (`\n\n`) renders as `<p data-md-blank="true"><br></p>`. This placeholder takes up one line of visual height (so `\n\n` and `\n` look visually distinct), serializes to zero characters (only contributing `\n` separators), and remains interactive in the editor so the cursor can be placed on it.

`isBlankLineBlock` also treats browser-created `<p><br></p>` (from Enter on an empty line) the same way.

### Block separators

`joinBlocks` controls the separator emitted between adjacent serialized blocks:

| previous → current                           | separator |
| -------------------------------------------- | --------- |
| either is blank sentinel                     | `\n`      |
| paragraph → paragraph                        | `\n`      |
| paragraph ↔ list                             | `\n`      |
| everything else (heading, code, blockquote…) | `\n\n`    |

The paragraph→paragraph `\n` is what makes the line model work. Text immediately before a heading (e.g. `intro\n## H`) gains a blank line on first round-trip (`intro\n\n## H`) because heading uses the `\n\n` default. This is stable after one save.

### Round-trip invariant

`renderMarkdown` and `domToMarkdown` must be exact inverses:

```
domToMarkdown(parse(renderMarkdown(md))) === md
```

Any gap between them is a latent bug: the same visible content produces different markdown depending on how it was created. The line-based model was specifically chosen because it keeps the editing primitive and the storage primitive in sync.

---

## Cursor preservation

When content is re-rendered (disk reload, tab switch from source back to content), the cursor position is preserved across a full DOM teardown and rebuild via a two-step sentinel approach.

### Saving the offset — `getCursorMarkdownOffset(contentEl, range)`

1. Inserts a temporary `<span data-md-cursor="true">` at the cursor position using `range.insertNode`.
2. Calls `domToMarkdown(contentEl)` — which emits the sentinel character `﷐` for `[data-md-cursor]` elements — and records the offset of that sentinel in the output string.
3. Removes the span, calls `parent.normalize()` to re-merge any text nodes that `insertNode` split, and restores the selection.

This is correct even when the cursor is **inside an inline element** like `<strong>`. A naive approach — clone the DOM up to the cursor, serialize, measure length — overcounts by the length of artificially-added closing markers (`**`, `~~`, etc.). The sentinel-insert approach avoids this entirely.

### Restoring the offset — `setValue(md, cursorOffset)`

1. `renderMarkdownWithCursor(md, offset)` inserts `﷐` at `offset` in the markdown string before rendering.
2. `inline()` converts `﷐` to `<span data-md-cursor="true">` at the correct rendered position.
3. The editor finds that span, places the cursor before it via a Range, and removes the span.

The sentinel `﷐` is a Unicode noncharacter permanently reserved as "not a character" — it cannot appear in valid user text.

### Selection preservation — `getSelectionOffsets()`

To round-trip a selection (start + end) through a re-render, two sentinels are inserted. The end marker is inserted first (higher DOM position) so that inserting the start marker doesn't shift the end's position. After serializing, the first `﷐` is start and the second is end − 1 (the first sentinel occupied one character before the second).

---

## Block transforms

Block transforms (`transforms.ts`) fire on Enter and input/space, converting markdown syntax typed into a `<p>` into the appropriate HTML element.

- **Enter-triggered** (`handleBlockTransform`): if the `<p>` text matches a pattern (`## foo`, `- item`, `---`, ` ``` `), the element is replaced and `setCursorStart` positions the cursor. `e.preventDefault()` suppresses browser Enter. If no pattern matches, browser default (new `<p>`) is used.
- **Input/space-triggered** (`checkBlockInputTransform`): converts `## ` or `- ` immediately on space. Also wraps bare text nodes (that the browser places directly in `contentEl`) in `<p>`.

Block transforms call `setCursorStart` directly and bypass the sentinel restore path. Autosave only writes to the server; `loadContent` (which uses sentinel restore) is only called on disk reload and tab switch.

## Inline transforms

Inline transforms (`inline-transforms.ts`) fire on every input event. When the user completes `**bold**`, the raw text is replaced with `<strong>bold</strong>` via `document.execCommand("insertHTML")`.

A zero-width space (`​`) is appended after most inline elements to keep the cursor outside the styled element. `domToMarkdown` strips all `​` from text nodes; they never appear in saved markdown. The stripping is symmetric (applied to both full serialization and the cursor-offset computation via the sentinel-insert approach), so `​` does not shift cursor offsets.

---

## Editor wiring layer — `createEditor`

`createEditor(container, config)` builds a self-contained WYSIWYG editor inside `container`. It creates two child elements:

- `contentEl` — `contenteditable` div; receives all keyboard/paste/input events.
- `sourceEl` — hidden `<textarea>`; shown in source mode.

### Undo stack

The editor maintains its own undo stack (`UndoEntry = { md, selStart, selEnd }`), capped at 200 entries. Entries are pushed:

- On every `setValue` call (initial load or programmatic update).
- On `applyFormat` (before applying the transform).
- Via a debounced typing checkpoint (1 s after the last input event with no formatting operation).
- At the start of `undo()` so the post-edit state is always recoverable via redo.

Redo works by moving the index forward; a new edit after undo truncates the tail.

### Image paste

When a clipboard item has an `image/*` MIME type, the editor converts it to WebP via `OffscreenCanvas` and calls `config.onImagePaste(blob)`. The callback is expected to upload the blob and return the HTML string to insert (e.g. `<img src="..." ...>`), or `null` to abort. The editor inserts the returned HTML via `execCommand("insertHTML")` so the operation participates in the browser's native undo stack.

### Source mode

`toggleSourceMode()` switches between the contenteditable view and the raw textarea. When entering source mode the textarea is set to `getValue()` (the current markdown body). When leaving, the textarea content is fed back through `renderMarkdown` into `contentEl`. Callers that need to inject frontmatter or other wrapper content should override `sourceEl.value` immediately after calling `toggleSourceMode()`.

### Extension threading

All render and serialize calls inside the editor pass `{ extensions }` through automatically. Callers do not need to thread extensions manually through `applyFormat`, `getSelectionOffsets`, or any other method.
