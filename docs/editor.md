# Editor

`web/ts/editor` is Tansu's internal Markdown editor engine. It is not a
publishable package or compatibility boundary.

The app imports from `./editor/index.js` and mounts the editor through
`createEditor`. The engine owns Markdown rendering, DOM serialization, logical
selection, source mode, undo/redo, formatting, paste handling, image resizing,
and extension hooks. The app owns note lifecycle, persistence, vault assets,
settings, tabs, and session state.

Keep editor behavior inside `web/ts/editor`. Tansu-specific assumptions may live
there when they make the editor easier to reason about.

## Public Internal Surface

- `createEditor` wires the model-owned visual editor.
- `renderMarkdown` and `domToMarkdown` support read-only rendering, paste, and
  import compatibility paths.
- `createWikiLinkExtension`, `createWikiImageExtension`, and
  `createCalloutExtension` are the built-in Tansu Markdown extensions.
- `toggleBold`, `toggleItalic`, `toggleHeading`, `shiftIndent`, and related
  format operations are pure source-text transforms.

This index is internal to Tansu. Do not preserve API shape for hypothetical
external consumers.

## Model Ownership

The visual editor keeps Markdown body text in an explicit editor model. The DOM
is a projection of that model plus the active browser input surface; it is not
the canonical document state for normal editing, snapshots, autosave, or cursor
persistence.

The model uses lines as the lossless storage primitive:

| Markdown       | Model lines          |
| -------------- | -------------------- |
| `""`           | `[""]`               |
| `"foo"`        | `["foo"]`            |
| `"foo\n"`      | `["foo", ""]`        |
| `"foo\n\nbar"` | `["foo", "", "bar"]` |
| `"\n\nfoo"`    | `["", "", "foo"]`    |

Line endings are normalized to LF before entering the editor model. Converting
back to a platform-specific on-disk newline format is outside the editor engine.

`docToMarkdown(markdownToDoc(md))` must preserve normalized Markdown exactly,
including leading blank lines, trailing blank lines, and repeated blank lines.

## Blocks

Blocks are derived from model lines. They are addressable editing primitives,
not a replacement storage format.

The block index groups headings, paragraphs, lists, task lists, code fences,
tables, blockquotes or callouts, horizontal rules, and blank runs. Each rendered
block receives `data-md-block-id` and `data-md-block-kind`, and each editable
line host receives `data-md-line-id` and `data-md-line-index`.

Block ids may be regenerated after wholesale Markdown replacement. Editing logic
must treat block grouping as derived and disposable; Markdown lines remain the
source of truth. After native input reconciles a line into the model, block
metadata and gutter handle ids are refreshed on the existing DOM so each handle
addresses a block in the current model.

## Selection

Durable selection is logical:

- Text selection is stored as line and UTF-16 column positions.
- Block selection stores anchor and focus block ids.
- Snapshot offsets are computed from the model, not from full DOM serialization.

The editor renderer adds source-span metadata to inline leaves in visual editor
mode. For example, a rendered `strong` element from `**bold**` exposes the source
span for the whole Markdown construct and the content span for `bold`. This lets
DOM selections inside formatted text map back to Markdown source offsets without
inserting marker elements and serializing the whole editor.

Extension inline output that cannot expose internal source positions is treated
as atomic. Cursor mapping supports positions before and after the atomic source
span.

## Rendering

Rendering is deterministic from Markdown plus logical selection. The editor uses
the editor render path for visual editing and keeps the `renderMarkdown` /
`domToMarkdown` pair for non-editor rendering, import, paste, and compatibility
paths.

Full renders are used for document-wide state changes such as source-mode
transitions, undo/redo, formatting, paste, block selection replacement, and
structural edits that add/remove lines or need surrounding block context.
Single-line inline and block input transforms use a line-range render: the
renderer replaces the affected modeled line and then rebuilds metadata from the
new DOM. Ordinary typing does not render the document: the browser mutates the
active line host and the editor reconciles that one host back into the model.

Blank Markdown lines render as `data-md-blank="true"` lanes. A single blank line
between two content blocks is a structural separator and is not editable.
Repeated blank lines keep the first blank as the structural separator and make
the additional blank lanes editable. Leading/trailing single blank cursor lines
may be hidden until active, and hidden blank lanes are still model lines that
serialize through `docToMarkdown`.

## Input

Ordinary native text input is limited to the active editable line host. On input,
the editor reads that host, updates the corresponding model line, updates logical
selection from line metadata, and schedules change handling.

Structural editing is intercepted before the browser creates untracked document
state. Enter, Backspace, Delete, paste, and block-selection replacement apply
model transactions, render from the model, restore logical selection from line
and source-span metadata, and notify callers.

Composition input keeps structural rerenders away from the active host until
composition ends, then reconciles the host back into the model.

## Undo And Redo

Undo entries store Markdown and selection offsets. Undo and redo restore the
model, render from Markdown, restore selection through line/source metadata, and
fire the editor change callback.

Typing checkpoints are debounced. Structural transactions checkpoint
synchronously before applying the model change.

## Source Mode

Source mode is a raw Markdown textarea over the same model. Entering source mode
syncs the visual host, writes `docToMarkdown(state.doc)` into the textarea, and
maps logical selection to textarea offsets. Leaving source mode reads the
textarea, normalizes line endings, rebuilds the model, renders the visual
editor, and restores selection.

Source mode must not add, remove, or collapse blank lines.

## Snapshots

`getSnapshot()` returns one coherent view of the editor state:

- Markdown from the model.
- Cursor and selection offsets from the same model revision.
- The current revision number.
- Current source-mode state.

App autosave and draft capture should prefer this snapshot over separate
`getValue()` and cursor reads, so saved content and cursor offsets cannot come
from different revisions.

## Gutter Selection

Each rendered block receives a focusable gutter handle with the accessible label
`Select block`. Clicking a handle creates a block selection; shift-click extends
the block range.

Copy, cut, Delete, Backspace, and typing while a block is selected operate on
the exact Markdown source span for the selected block range. Escape collapses
the selection to a text cursor at the start of the first selected block.

Drag, reorder, slash commands, and block action menus are intentionally outside
this editor core.

## Compatibility Boundaries

`domToMarkdown` remains available through the internal editor index and is still
used for HTML import/paste compatibility and other fallback paths. It must not
be the source of truth for visual editor snapshots, autosave, ordinary typing,
or cursor capture.

Legacy DOM mutation transform helpers have been removed. Visual editing uses
model transactions, inline pattern matching, renderer output, and DOM metadata
instead of direct DOM rewrites as source of truth.

Frontmatter remains app-owned. The editor receives and returns Markdown body
content only.

## Extensions

Extensions hook into the render and serialize pipeline to add custom inline or
block syntax that the core Markdown parser does not handle. Each extension is a
plain object implementing any subset of the `MarkdownExtension` hooks.

```ts
type MarkdownExtension = {
  renderInline?: (text: string, offset: number) => { html: string; consumed: number } | null;
  renderBlockquote?: (lines: string[], renderLines: (lines: string[]) => string) => string | null;
  serializeInline?: (el: HTMLElement) => string | null;
  serializeBlock?: (
    el: HTMLElement,
    serializeChildren: (el: HTMLElement) => string,
  ) => { md: string; kind: BlockKind } | null;
  isBlock?: (el: HTMLElement) => boolean;
};
```

`BlockKind` is one of: `blank`, `paragraph`, `heading`, `list`, `blockquote`,
`code`, `table`, `hr`, or `other`. It controls blank-line separation emitted by
`domToMarkdown`.

Extensions are tried in array order; the first non-null return wins. Core
handling runs last. The editor threads configured extensions through rendering,
paste, serialization, and model-backed editor flows.

## Built-In Extensions

`createWikiLinkExtension()` renders `[[Note Name]]` and
`[[Note Name|Display Text]]` as anchor elements and round-trips them back to
wiki-link syntax.

`createWikiImageExtension(opts)` renders `![[image.png]]` and
`![[image.png|320]]` as `<img>` elements. `opts.resolveUrl` maps the bare image
name to a URL for the `src` attribute.

`createCalloutExtension(opts?)` renders GitHub/Obsidian-style callout blocks:

```markdown
> [!warning] Watch out
> This will be rendered as a callout.
```

Callouts serialize from `<div class="callout">` elements with `data-callout`,
`.callout-title`, and optional `.callout-body`.

## Custom Extensions

A minimal extension that renders `::highlight::` as `<mark>`:

```ts
import { escapeHtml, type MarkdownExtension } from "./index.js";

function createDoubleColonHighlight(): MarkdownExtension {
  return {
    renderInline(text, i) {
      if (text[i] !== ":" || text[i + 1] !== ":") return null;
      const end = text.indexOf("::", i + 2);
      if (end === -1) return null;
      const inner = text.slice(i + 2, end);
      return { html: `<mark>${escapeHtml(inner)}</mark>`, consumed: end + 2 - i };
    },

    serializeInline(el) {
      if (el.tagName !== "MARK") return null;
      return `::${el.textContent ?? ""}::`;
    },
  };
}
```

For block-level syntax, implement `renderBlockquote` for `>` blocks, or add
rendering in the Markdown renderer and pair it with `serializeBlock` and
`isBlock`. See `web/ts/editor/callout.ts` for a complete block example.
