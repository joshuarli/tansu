/// Roundtrip tests: markdown → HTML → markdown.
/// Verifies that domToMarkdown(renderMarkdown(md)) produces equivalent output.

import { setupDOM, assertEqual, assertContains } from "./test-helper.ts";
const cleanup = setupDOM();

const { renderMarkdown } = await import("./markdown.ts");
const { domToMarkdown } = await import("./serialize.ts");

function roundtrip(md: string): string {
  const el = document.createElement("div");
  el.innerHTML = renderMarkdown(md);
  return domToMarkdown(el);
}

// Headings
assertEqual(roundtrip("# Hello"), "# Hello", "h1 roundtrip");
assertEqual(roundtrip("## Sub"), "## Sub", "h2 roundtrip");
assertEqual(roundtrip("###### Deep"), "###### Deep", "h6 roundtrip");

// Paragraphs
assertEqual(roundtrip("Hello world"), "Hello world", "paragraph roundtrip");

// Multiple paragraphs
assertEqual(roundtrip("First\n\nSecond"), "First\n\nSecond", "two paragraphs");

// Bold
assertEqual(roundtrip("**bold**"), "**bold**", "bold roundtrip");

// Italic
assertEqual(roundtrip("*italic*"), "*italic*", "italic roundtrip");

// Inline code
assertEqual(roundtrip("use `foo` here"), "use `foo` here", "inline code roundtrip");

// Strikethrough
assertEqual(roundtrip("~~deleted~~"), "~~deleted~~", "strikethrough roundtrip");

// Highlight
assertEqual(roundtrip("==marked=="), "==marked==", "highlight roundtrip");

// Links
assertEqual(roundtrip("[text](http://url)"), "[text](http://url)", "link roundtrip");

// Wiki-links
assertEqual(roundtrip("[[my note]]"), "[[my note]]", "wiki-link roundtrip");
assertEqual(roundtrip("[[target|display]]"), "[[target|display]]", "wiki-link pipe roundtrip");

// Images
assertEqual(roundtrip("![alt](src.png)"), "![alt](src.png)", "image roundtrip");

// Wiki-images
assertEqual(roundtrip("![[photo.webp]]"), "![[photo.webp]]", "wiki-image roundtrip");

// HR
assertEqual(roundtrip("---"), "---", "hr roundtrip");

// Unordered list
assertEqual(roundtrip("- one\n- two\n- three"), "- one\n- two\n- three", "ul roundtrip");

// Ordered list
assertEqual(roundtrip("1. first\n2. second"), "1. first\n2. second", "ol roundtrip");

// Fenced code block (with language)
assertEqual(
  roundtrip("```js\nconst x = 1;\n```"),
  "```js\nconst x = 1;\n```",
  "code block roundtrip",
);

// Fenced code block (no language)
assertEqual(roundtrip("```\nhello\n```"), "```\nhello\n```", "code block no lang roundtrip");

// Blockquote
assertEqual(roundtrip("> quoted text"), "> quoted text", "blockquote roundtrip");

// Table
{
  const table = "| A | B |\n| --- | --- |\n| 1 | 2 |";
  const rt = roundtrip(table);
  assertContains(rt, "| A | B |", "table header roundtrip");
  assertContains(rt, "| 1 | 2 |", "table row roundtrip");
  assertContains(rt, "---", "table separator roundtrip");
}

// Callout
{
  const callout = "> [!warning] Be careful\n> This is important";
  const rt = roundtrip(callout);
  assertContains(rt, "[!warning]", "callout type roundtrip");
  assertContains(rt, "Be careful", "callout title roundtrip");
  assertContains(rt, "This is important", "callout body roundtrip");
}

// Nested inline — nesting structure is preserved through the DOM
assertEqual(roundtrip("**bold *and italic***"), "**bold *and italic***", "nested inline roundtrip");

// Code block with HTML entities
assertEqual(
  roundtrip("```\n<div>test</div>\n```"),
  "```\n<div>test</div>\n```",
  "code block html entities roundtrip",
);

// Heading + paragraph
assertEqual(
  roundtrip("# Title\n\nBody text"),
  "# Title\n\nBody text",
  "heading + paragraph roundtrip",
);

// Complex document
{
  const doc =
    "# Title\n\nSome **bold** and *italic* text.\n\n- item 1\n- item 2\n\n```js\nconst x = 1;\n```\n\n> A quote";
  const rt = roundtrip(doc);
  assertContains(rt, "# Title", "complex doc heading");
  assertContains(rt, "**bold**", "complex doc bold");
  assertContains(rt, "*italic*", "complex doc italic");
  assertContains(rt, "- item 1", "complex doc list");
  assertContains(rt, "```js", "complex doc code");
  assertContains(rt, "> A quote", "complex doc quote");
}

cleanup();
console.log("All roundtrip tests passed");
