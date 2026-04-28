# @joshuarli98/md-wysiwyg

Zero-dependency markdown rendering, WYSIWYG editor wiring, diff/merge, and syntax highlighting for browser-based editors.

## Installation

```
npm install @joshuarli98/md-wysiwyg
```

## Quick start

### Standalone render/serialize

```ts
import { renderMarkdown, domToMarkdown } from "@joshuarli98/md-wysiwyg";

const html = renderMarkdown("# Hello\n\nWorld");
document.getElementById("editor")!.innerHTML = html;

const md = domToMarkdown(document.getElementById("editor")!);
```

### Full editor

`createEditor` wires a complete WYSIWYG editor inside a container element — contenteditable pane, hidden source textarea, undo/redo, keyboard shortcuts, image paste, and inline/block transforms. All markdown-specific behaviour is delegated to the render/serialize modules; you configure extensions and callbacks.

```ts
import { createEditor, createWikiLinkExtension } from "@joshuarli98/md-wysiwyg";

const handle = createEditor(document.getElementById("mount")!, {
  extensions: [createWikiLinkExtension()],
  onChange: () => console.log(handle.getValue()),
  onImagePaste: async (blob) => {
    const url = await upload(blob);
    return url ? `<img src="${url}" alt="pasted">` : null;
  },
});

handle.setValue("# Hello");
handle.focus();
```

`EditorHandle` exposes: `getValue()`, `setValue(md, cursorOffset?)`, `getSelectionOffsets()`, `getCursorOffset()`, `applyFormat(op)`, `undo()`, `redo()`, `toggleSourceMode()`, `focus()`, `isSourceMode`, `contentEl`, `sourceEl`, `destroy()`.

### Extensions

Extensions hook into the render and serialize pipeline to add custom syntax:

```ts
import {
  createWikiLinkExtension, // [[Note Name]] and [[Note|Display]]
  createWikiImageExtension, // ![[image.png]] and ![[image.png|320]]
  createCalloutExtension, // > [!warning] text
} from "@joshuarli98/md-wysiwyg";

const extensions = [
  createWikiLinkExtension(),
  createWikiImageExtension({ resolveUrl: (name) => `/files/${encodeURIComponent(name)}` }),
  createCalloutExtension(),
];

const html = renderMarkdown(md, { extensions });
const back = domToMarkdown(el, { extensions });
```

See [docs/extensions.md](docs/extensions.md) for the full `MarkdownExtension` interface and how to write custom extensions.

## Other exports

- **`highlightCode(code, lang)`** — syntax highlighting, returns HTML with `<span class="hl-*">` tokens.
- **`computeDiff(a, b)` / `renderDiff(hunks)`** — line-based diff with compact HTML rendering.
- **`merge3(base, ours, theirs)`** — line-based 3-way merge; returns `null` on conflict.
- **`toggleBold` / `toggleItalic` / `toggleHeading` / `shiftIndent` / …** — pure source-text format operations (`FormatResult = { md, selStart, selEnd }`).
- **`checkBlockInputTransform(el)` / `handleBlockTransform(e, el, cb)`** — block-level WYSIWYG transforms (Enter → heading, space → list marker, etc.).
- **`checkInlineTransform()`** — inline transforms triggered by closing delimiters.
- **`escapeHtml(s)` / `stemFromPath(path)` / …** — utilities.

## Requirements

- ES2022+ runtime (`structuredClone`, `Array.at`, etc.)
- DOM environment (browser or compatible, e.g. happy-dom)
- No runtime dependencies

## Docs

- [docs/architecture.md](docs/architecture.md) — line-based DOM model, cursor preservation, block/inline transforms, and editor wiring.
- [docs/extensions.md](docs/extensions.md) — `MarkdownExtension` interface and built-in extensions.
