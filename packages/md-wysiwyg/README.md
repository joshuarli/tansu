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
