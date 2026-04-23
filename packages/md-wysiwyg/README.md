# @joshuarli98/md-wysiwyg

Zero-dependency markdown rendering, WYSIWYG DOM serialization, diff/merge, and syntax highlighting for browser-based editors.

## Features

- **`renderMarkdown(md)`** — converts Markdown to HTML. Supports headings, paragraphs, lists (ul/ol/task), blockquotes, callouts, fenced code blocks, tables, HR, and inline formatting (bold, italic, strikethrough, code, highlights, wiki-links, standard links/images).
- **`highlightCode(code, lang)`** — syntax highlighting for common languages. Returns an HTML string with `<span class="hl-*">` tokens. No external dependency.
- **`domToMarkdown(el)`** — serializes a `contenteditable` DOM tree back to Markdown. Round-trips with `renderMarkdown`.
- **`handleBlockTransform(e, el, onDirty?)`** / **`checkBlockInputTransform(e, el)`** — block-level WYSIWYG transforms on Enter/Space: typing `## ` converts to H2, `- ` to UL, ` ``` ` to code block, `---` to HR, etc.
- **`checkInlineTransform`** and related — inline formatting transforms triggered by closing delimiters (`**`, `_`, `` ` ``, `~~`, `==`).
- **`computeDiff(a, b)`** / **`renderDiff(hunks)`** — line-based diff with compact HTML rendering (like `git diff`).
- **`merge3(base, ours, theirs)`** — line-based 3-way merge. Returns merged string or `null` on conflict.
- **`escapeHtml(s)`** — escapes `&`, `<`, `>`, `"`.
- **`stemFromPath(path)`** — returns the filename stem from a path.

## Usage

```ts
import { renderMarkdown, domToMarkdown, merge3 } from "@joshuarli98/md-wysiwyg";

const html = renderMarkdown("# Hello\n\nWorld");
const md = domToMarkdown(document.getElementById("editor")!);
const merged = merge3(base, ours, theirs); // null on conflict
```

## Requirements

- ES2022+ runtime (uses `structuredClone`, `at()`, etc.)
- DOM environment (browser or compatible, e.g. happy-dom)
- No runtime dependencies

---

## Architecture

### The line-based DOM model

**Invariant: one `<p>` element per line of plain text.**

This aligns the DOM editing primitive (Enter creates a new `<p>`) with the markdown storage primitive (`\n` separates lines):

| Markdown | DOM |
|---|---|
| `foo\nbar` | `<p>foo</p><p>bar</p>` |
| `foo\n\nbar` | `<p>foo</p><p data-md-blank="true"><br></p><p>bar</p>` |

Enter in the content editor creates a new `<p>` (browser default), which round-trips to `\n`. No Enter interception is needed for plain text.

**Do not put `<br>` inside `<p>` elements for line breaks.** A `<br>` inside a `<p>` serializes as an inline `\n`, which would round-trip as two lines packed into one block, then duplicate the newline on the next save.

### Blank lines

A blank line (`\n\n`) renders as `<p data-md-blank="true"><br></p>`. This placeholder takes up one line of visual height (so `\n\n` and `\n` look visually distinct), serializes to zero characters (only contributing `\n` separators), and remains interactive in the editor so the cursor can be placed on it.

`isBlankLineBlock` also treats browser-created `<p><br></p>` (from Enter on an empty line) the same way.

### Block separators

`joinBlocks` controls the separator emitted between adjacent serialized blocks:

| previous → current | separator |
|---|---|
| either is blank sentinel | `\n` |
| paragraph → paragraph | `\n` |
| paragraph ↔ list | `\n` |
| everything else (heading, code, blockquote…) | `\n\n` |

The paragraph→paragraph `\n` is what makes the line model work. Text immediately before a heading (e.g. `intro\n## H`) gains a blank line on first round-trip (`intro\n\n## H`) because heading uses the `\n\n` default. This is stable after one save.

### Round-trip invariant

`renderMarkdown` and `domToMarkdown` must be exact inverses:

```
domToMarkdown(parse(renderMarkdown(md))) === md
```

Any gap between them is a latent bug: the same visible content produces different markdown depending on how it was created. The line-based model was specifically chosen because it keeps the editing primitive and the storage primitive in sync.

---

### Cursor preservation

When content is re-rendered (disk reload, tab switch from source back to content), the cursor position is preserved across a full DOM teardown and rebuild via a two-step sentinel approach.

#### Saving the offset — `getCursorMarkdownOffset(contentEl, range)`

1. Inserts a temporary `<span data-md-cursor="true">` at the cursor position using `range.insertNode`.
2. Calls `domToMarkdown(contentEl)` — which emits the sentinel character `﷐` for `[data-md-cursor]` elements — and records the offset of that sentinel in the output string.
3. Removes the span, calls `parent.normalize()` to re-merge any text nodes that `insertNode` split, and restores the selection.

This is correct even when the cursor is **inside an inline element** like `<strong>`. A naive approach — clone the DOM up to the cursor, serialize, measure length — overcounts by the length of artificially-added closing markers (`**`, `~~`, etc.). The sentinel-insert approach avoids this entirely.

#### Restoring the offset — `restoreCursorOffset(offset, markdown)`

1. `renderMarkdownWithCursor(markdown, offset)` inserts `﷐` at `offset` in the markdown string before rendering.
2. `inline()` converts `﷐` to `<span data-md-cursor="true">` at the correct rendered position.
3. `restoreCursorMarker` finds that span, places the cursor before it via a Range, and removes the span.

The sentinel `﷐` is a Unicode noncharacter permanently reserved as "not a character" — it cannot appear in valid user text.

---

### Block transforms

Block transforms (`transforms.ts`) fire on Enter and input/space, converting markdown syntax typed into a `<p>` into the appropriate HTML element.

- **Enter-triggered** (`handleBlockTransform`): if the `<p>` text matches a pattern (`## foo`, `- item`, `---`, `` ``` ``), the element is replaced and `setCursorStart` positions the cursor. `e.preventDefault()` suppresses browser Enter. If no pattern matches, browser default (new `<p>`) is used.
- **Input/space-triggered** (`checkBlockInputTransform`): converts `## ` or `- ` immediately on space. Also wraps bare text nodes (that the browser places directly in `contentEl`) in `<p>`.

Block transforms call `setCursorStart` directly and bypass the sentinel restore path. Autosave only writes to the server; `loadContent` (which uses sentinel restore) is only called on disk reload and tab switch.

### Inline transforms

Inline transforms (`inline-transforms.ts`) fire on every input event. When the user completes `**bold**`, the raw text is replaced with `<strong>bold</strong>` via `document.execCommand("insertHTML")`.

A zero-width space (`​`) is appended after most inline elements to keep the cursor outside the styled element. `domToMarkdown` strips all `​` from text nodes; they never appear in saved markdown. The stripping is symmetric (applied to both full serialization and the cursor-offset computation via the sentinel-insert approach), so `​` does not shift cursor offsets.
