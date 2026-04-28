# Extensions

Extensions hook into the render and serialize pipeline to add custom inline or block syntax that the core markdown parser doesn't handle. Each extension is a plain object implementing any subset of the `MarkdownExtension` hooks.

## The interface

```ts
type MarkdownExtension = {
  // Inline render: called at each character the core doesn't claim.
  // Return { html, consumed } to take ownership, or null to fall through.
  renderInline?: (text: string, offset: number) => { html: string; consumed: number } | null;

  // Blockquote render: intercept `>` blocks (e.g. callouts).
  // renderLines renders an array of stripped blockquote lines using the same extensions.
  // Return an HTML string to override, or null for default <blockquote>.
  renderBlockquote?: (lines: string[], renderLines: (lines: string[]) => string) => string | null;

  // Inline serialize: called for each inline element during DOM→markdown.
  // Return markdown or null to fall through to core handling.
  serializeInline?: (el: HTMLElement) => string | null;

  // Block serialize: called for each block element during DOM→markdown.
  // serializeChildren serializes the element's block children using the same extensions.
  // Return { md, kind } or null to fall through to core handling.
  serializeBlock?: (
    el: HTMLElement,
    serializeChildren: (el: HTMLElement) => string,
  ) => { md: string; kind: BlockKind } | null;

  // Declare additional block-level elements (affects blank-line separation).
  isBlock?: (el: HTMLElement) => boolean;
};
```

`BlockKind` is one of: `"blank"` `"paragraph"` `"heading"` `"list"` `"blockquote"` `"code"` `"table"` `"hr"` `"other"`. It controls the blank-line separator that `domToMarkdown` emits between this block and its neighbours (see [architecture.md](architecture.md#block-separators)).

Extensions are tried in array order; the first non-null return wins. Core handling runs last.

### Passing extensions

```ts
import { renderMarkdown, domToMarkdown, createEditor } from "@joshuarli98/md-wysiwyg";

const opts = { extensions: [myExtension] };

// Standalone:
const html = renderMarkdown(md, opts);
const md = domToMarkdown(el, opts);

// Editor (threads extensions through all internal calls automatically):
const handle = createEditor(container, { extensions: [myExtension] });
```

---

## Built-in extensions

### `createWikiLinkExtension()`

Renders `[[Note Name]]` and `[[Note Name|Display Text]]` as anchor elements, and round-trips them back to wiki-link syntax.

**Render output:**

```html
<a class="wiki-link" data-target="Note Name">Note Name</a>
<a class="wiki-link" data-target="Note Name">Display Text</a>
```

**Serialize input:** any `<a>` with a `data-target` attribute → `[[target]]` or `[[target|display]]`.

```ts
import { createWikiLinkExtension } from "@joshuarli98/md-wysiwyg";
const ext = createWikiLinkExtension();
```

No configuration options.

---

### `createWikiImageExtension(opts)`

Renders `![[image.png]]` and `![[image.png|320]]` (optional pixel width) as `<img>` elements.

```ts
import { createWikiImageExtension } from "@joshuarli98/md-wysiwyg";

const ext = createWikiImageExtension({
  resolveUrl: (name) => `/files/${encodeURIComponent(name)}`,
});
```

| Option       | Type                       | Description                                                |
| ------------ | -------------------------- | ---------------------------------------------------------- |
| `resolveUrl` | `(name: string) => string` | Maps the bare image name to a URL for the `src` attribute. |

**Render output:**

```html
<img src="/files/image.png" alt="image.png" data-wiki-image="image.png" loading="lazy" />
<img
  src="/files/image.png"
  alt="image.png"
  data-wiki-image="image.png"
  width="320"
  loading="lazy"
/>
```

**Serialize input:** any `<img>` with a `data-wiki-image` attribute → `![[name]]` or `![[name|width]]`.

---

### `createCalloutExtension(opts?)`

Renders GitHub/Obsidian-style callout blocks:

```markdown
> [!warning] Watch out
> This will be rendered as a callout.
```

**Render output:**

```html
<div class="callout callout-warning" data-callout="warning">
  <div class="callout-title">⚠️ Watch out</div>
  <div class="callout-body"><p>This will be rendered as a callout.</p></div>
</div>
```

```ts
import { createCalloutExtension } from "@joshuarli98/md-wysiwyg";

const ext = createCalloutExtension(); // default icons
const ext = createCalloutExtension({ icons: { tip: "👉" } }); // override specific icons
```

| Option  | Type                     | Description                                                      |
| ------- | ------------------------ | ---------------------------------------------------------------- |
| `icons` | `Record<string, string>` | Override icons for specific callout types. Merged with defaults. |

Default type→icon mappings: `note 📝`, `info ℹ️`, `tip/hint 💡`, `important ❗`, `warning/caution ⚠️`, `danger 🚨`, `bug 🐛`, `example 📋`, `quote 💬`, `abstract/summary 📄`, `todo/success/check/done ✅`, `question/faq ❓`, `failure/fail/missing ❌`.

**Serialize input:** any `<div class="callout">` with `data-callout`, `.callout-title`, and optional `.callout-body` → `> [!type] Title\n> body…`.

---

## Writing a custom extension

A minimal extension that renders `::highlight::` as `<mark>`:

```ts
import type { MarkdownExtension } from "@joshuarli98/md-wysiwyg";

function createDoubleColonHighlight(): MarkdownExtension {
  return {
    renderInline(text, i) {
      if (text[i] !== ":" || text[i + 1] !== ":") return null;
      const end = text.indexOf("::", i + 2);
      if (end === -1) return null;
      const inner = text.slice(i + 2, end);
      return { html: `<mark>${inner}</mark>`, consumed: end + 2 - i };
    },

    serializeInline(el) {
      if (el.tagName !== "MARK") return null;
      return `::${el.textContent}::`;
    },
  };
}
```

A few rules for `renderInline`:

- `offset` is the current index into `text`. Check `text[offset]` first to short-circuit cheaply.
- `consumed` must be the number of characters consumed from `text` starting at `offset`, inclusive of any closing delimiter. The parser advances by `consumed` and continues.
- `html` is injected verbatim into the rendered output — escape user content with `escapeHtml`.

For block-level syntax (anything that lives in its own block element), implement `renderBlockquote` (for `>` blocks) or return an element from a transform. Use `serializeBlock` and `isBlock` to round-trip it back. See `callout.ts` for a complete block example.
