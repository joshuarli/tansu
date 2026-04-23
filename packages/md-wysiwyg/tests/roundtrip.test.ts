/// Roundtrip tests: markdown → HTML → markdown.
/// Verifies that domToMarkdown(renderMarkdown(md)) produces equivalent output.

import { describe, test, expect, beforeAll, afterAll } from "vitest";

import { setupDOM } from "./test-helper.ts";

describe("roundtrip", () => {
  let cleanup: () => void;
  let renderMarkdown: (md: string) => string;
  let domToMarkdown: (el: HTMLElement) => string;

  function roundtrip(md: string): string {
    const el = document.createElement("div");
    el.innerHTML = renderMarkdown(md);
    return domToMarkdown(el);
  }

  beforeAll(async () => {
    cleanup = setupDOM();
    const mdMod = await import("../src/markdown.ts");
    const serMod = await import("../src/serialize.ts");
    renderMarkdown = mdMod.renderMarkdown;
    domToMarkdown = serMod.domToMarkdown;
  });

  afterAll(() => {
    cleanup();
  });

  test("h1 roundtrip", () => {
    expect(roundtrip("# Hello")).toBe("# Hello");
  });
  test("h2 roundtrip", () => {
    expect(roundtrip("## Sub")).toBe("## Sub");
  });
  test("h6 roundtrip", () => {
    expect(roundtrip("###### Deep")).toBe("###### Deep");
  });
  test("paragraph roundtrip", () => {
    expect(roundtrip("Hello world")).toBe("Hello world");
  });
  test("single newline is preserved", () => {
    expect(roundtrip("foo\nbar")).toBe("foo\nbar");
  });
  test("three consecutive lines", () => {
    expect(roundtrip("a\nb\nc")).toBe("a\nb\nc");
  });
  test("two paragraphs", () => {
    expect(roundtrip("First\n\nSecond")).toBe("First\n\nSecond");
  });
  test("single newline vs double newline are distinct", () => {
    const single = roundtrip("foo\nbar");
    const double = roundtrip("foo\n\nbar");
    expect(single).toBe("foo\nbar");
    expect(double).toBe("foo\n\nbar");
    expect(single).not.toBe(double);
  });
  test("mixed lines and blank lines", () => {
    expect(roundtrip("a\nb\n\nc\nd")).toBe("a\nb\n\nc\nd");
  });
  test("text before heading gains blank line on roundtrip", () => {
    // Serializer always puts \n\n between non-para block types
    expect(roundtrip("intro\n## Heading")).toBe("intro\n\n## Heading");
  });
  test("text after heading is stable", () => {
    expect(roundtrip("## Heading\n\ntext")).toBe("## Heading\n\ntext");
  });
  test("extra blank line between paragraphs", () => {
    expect(roundtrip("First\n\n\nSecond")).toBe("First\n\n\nSecond");
  });
  test("leading and trailing blank lines", () => {
    expect(roundtrip("\nFirst\n\nSecond\n")).toBe("\nFirst\n\nSecond\n");
  });
  test("multiple trailing blank lines", () => {
    expect(roundtrip("First\n\n\n")).toBe("First\n\n\n");
  });
  test("bold roundtrip", () => {
    expect(roundtrip("**bold**")).toBe("**bold**");
  });
  test("italic roundtrip", () => {
    expect(roundtrip("*italic*")).toBe("*italic*");
  });
  test("inline code roundtrip", () => {
    expect(roundtrip("use `foo` here")).toBe("use `foo` here");
  });
  test("strikethrough roundtrip", () => {
    expect(roundtrip("~~deleted~~")).toBe("~~deleted~~");
  });
  test("highlight roundtrip", () => {
    expect(roundtrip("==marked==")).toBe("==marked==");
  });
  test("link roundtrip", () => {
    expect(roundtrip("[text](http://url)")).toBe("[text](http://url)");
  });
  test("bare https url roundtrip", () => {
    expect(roundtrip("https://example.com")).toBe("https://example.com");
  });
  test("bare url in sentence roundtrip", () => {
    expect(roundtrip("Visit https://example.com today")).toBe("Visit https://example.com today");
  });
  test("wiki-link roundtrip", () => {
    expect(roundtrip("[[my note]]")).toBe("[[my note]]");
  });
  test("wiki-link pipe roundtrip", () => {
    expect(roundtrip("[[target|display]]")).toBe("[[target|display]]");
  });
  test("image roundtrip", () => {
    expect(roundtrip("![alt](src.png)")).toBe("![alt](src.png)");
  });
  test("wiki-image roundtrip", () => {
    expect(roundtrip("![[photo.webp]]")).toBe("![[photo.webp]]");
  });
  test("hr roundtrip", () => {
    expect(roundtrip("---")).toBe("---");
  });
  test("ul roundtrip", () => {
    expect(roundtrip("- one\n- two\n- three")).toBe("- one\n- two\n- three");
  });
  test("paragraph followed by list stays tight", () => {
    expect(roundtrip("foo:\n- one")).toBe("foo:\n- one");
  });
  test("empty list item followed by paragraph stays tight", () => {
    expect(roundtrip("foo:\n- one\n-\ndsf")).toBe("foo:\n- one\n- \ndsf");
  });
  test("nested ul roundtrip", () => {
    expect(roundtrip("- parent\n  - child")).toBe("- parent\n  - child");
  });
  test("empty list item roundtrip", () => {
    expect(roundtrip("- one\n- ")).toBe("- one\n- ");
  });
  test("ol roundtrip", () => {
    expect(roundtrip("1. first\n2. second")).toBe("1. first\n2. second");
  });

  test("code block roundtrip", () => {
    expect(roundtrip("```js\nconst x = 1;\n```")).toBe("```js\nconst x = 1;\n```");
  });

  test("code block no lang roundtrip", () => {
    expect(roundtrip("```\nhello\n```")).toBe("```\nhello\n```");
  });

  test("blockquote roundtrip", () => {
    expect(roundtrip("> quoted text")).toBe("> quoted text");
  });

  test("table header roundtrip", () => {
    const table = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const rt = roundtrip(table);
    expect(rt).toContain("| A | B |");
  });

  test("table row roundtrip", () => {
    const table = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const rt = roundtrip(table);
    expect(rt).toContain("| 1 | 2 |");
  });

  test("table separator roundtrip", () => {
    const table = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const rt = roundtrip(table);
    expect(rt).toContain("---");
  });

  test("callout type roundtrip", () => {
    const callout = "> [!warning] Be careful\n> This is important";
    const rt = roundtrip(callout);
    expect(rt).toContain("[!warning]");
  });

  test("callout title roundtrip", () => {
    const callout = "> [!warning] Be careful\n> This is important";
    const rt = roundtrip(callout);
    expect(rt).toContain("Be careful");
  });

  test("callout body roundtrip", () => {
    const callout = "> [!warning] Be careful\n> This is important";
    const rt = roundtrip(callout);
    expect(rt).toContain("This is important");
  });

  test("nested inline roundtrip", () => {
    expect(roundtrip("**bold *and italic***")).toBe("**bold *and italic***");
  });

  test("code block html entities roundtrip", () => {
    expect(roundtrip("```\n<div>test</div>\n```")).toBe("```\n<div>test</div>\n```");
  });

  test("heading + paragraph roundtrip", () => {
    expect(roundtrip("# Title\n\nBody text")).toBe("# Title\n\nBody text");
  });

  test("complex doc heading", () => {
    const doc =
      "# Title\n\nSome **bold** and *italic* text.\n\n- item 1\n- item 2\n\n```js\nconst x = 1;\n```\n\n> A quote";
    expect(roundtrip(doc)).toContain("# Title");
  });

  test("complex doc bold", () => {
    const doc =
      "# Title\n\nSome **bold** and *italic* text.\n\n- item 1\n- item 2\n\n```js\nconst x = 1;\n```\n\n> A quote";
    expect(roundtrip(doc)).toContain("**bold**");
  });

  test("complex doc italic", () => {
    const doc =
      "# Title\n\nSome **bold** and *italic* text.\n\n- item 1\n- item 2\n\n```js\nconst x = 1;\n```\n\n> A quote";
    expect(roundtrip(doc)).toContain("*italic*");
  });

  test("complex doc list", () => {
    const doc =
      "# Title\n\nSome **bold** and *italic* text.\n\n- item 1\n- item 2\n\n```js\nconst x = 1;\n```\n\n> A quote";
    expect(roundtrip(doc)).toContain("- item 1");
  });

  test("complex doc code", () => {
    const doc =
      "# Title\n\nSome **bold** and *italic* text.\n\n- item 1\n- item 2\n\n```js\nconst x = 1;\n```\n\n> A quote";
    expect(roundtrip(doc)).toContain("```js");
  });

  test("complex doc quote", () => {
    const doc =
      "# Title\n\nSome **bold** and *italic* text.\n\n- item 1\n- item 2\n\n```js\nconst x = 1;\n```\n\n> A quote";
    expect(roundtrip(doc)).toContain("> A quote");
  });
});

// Deterministic LCG pseudo-random number generator — no external dependency.
function lcg(seed: number): number {
  return ((1664525 * seed + 1013904223) >>> 0);
}
function pick<T>(arr: readonly T[], seed: number): T {
  return arr[seed % arr.length]!;
}

const WORDS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"] as const;
const INLINES = [
  "plain text",
  "**bold text**",
  "*italic text*",
  "~~struck text~~",
  "==marked text==",
] as const;

describe("fuzz roundtrip", () => {
  let cleanup: () => void;
  let renderMarkdown: (md: string) => string;
  let domToMarkdown: (el: HTMLElement) => string;

  function roundtrip(md: string): string {
    const el = document.createElement("div");
    el.innerHTML = renderMarkdown(md);
    return domToMarkdown(el);
  }

  beforeAll(async () => {
    cleanup = setupDOM();
    const mdMod = await import("../src/markdown.ts");
    const serMod = await import("../src/serialize.ts");
    renderMarkdown = mdMod.renderMarkdown;
    domToMarkdown = serMod.domToMarkdown;
  });

  afterAll(() => {
    cleanup();
  });

  test("paragraph-only sequences with single newlines", () => {
    for (let i = 0; i < 60; i++) {
      let seed = lcg(i + 1);
      const count = 2 + (seed % 4);
      const lines: string[] = [];
      for (let j = 0; j < count; j++) {
        seed = lcg(seed);
        lines.push(pick(WORDS, seed));
      }
      const md = lines.join("\n");
      expect(roundtrip(md), `iteration ${i}: ${JSON.stringify(md)}`).toBe(md);
    }
  });

  test("paragraph-only sequences with double newlines", () => {
    for (let i = 0; i < 60; i++) {
      let seed = lcg(i + 100);
      const count = 2 + (seed % 3);
      const paras: string[] = [];
      for (let j = 0; j < count; j++) {
        seed = lcg(seed);
        paras.push(pick(WORDS, seed));
      }
      const md = paras.join("\n\n");
      expect(roundtrip(md), `iteration ${i}: ${JSON.stringify(md)}`).toBe(md);
    }
  });

  test("paragraphs with inline formatting roundtrip", () => {
    for (let i = 0; i < 40; i++) {
      let seed = lcg(i + 200);
      const count = 2 + (seed % 3);
      const lines: string[] = [];
      for (let j = 0; j < count; j++) {
        seed = lcg(seed);
        lines.push(pick(INLINES, seed));
      }
      const md = lines.join("\n");
      expect(roundtrip(md), `iteration ${i}: ${JSON.stringify(md)}`).toBe(md);
    }
  });

  test("heading followed by paragraphs", () => {
    const levels = [1, 2, 3, 4, 5, 6] as const;
    for (let i = 0; i < 30; i++) {
      let seed = lcg(i + 300);
      const level = pick(levels, seed);
      const hashes = "#".repeat(level);
      seed = lcg(seed);
      const title = pick(WORDS, seed);
      seed = lcg(seed);
      const body = pick(WORDS, seed);
      seed = lcg(seed);
      const body2 = pick(WORDS, seed);
      const md = `${hashes} ${title}\n\n${body}\n${body2}`;
      expect(roundtrip(md), `iteration ${i}: ${JSON.stringify(md)}`).toBe(md);
    }
  });

  test("two headings with paragraph between", () => {
    for (let i = 0; i < 20; i++) {
      let seed = lcg(i + 400);
      const w1 = pick(WORDS, seed);
      seed = lcg(seed);
      const w2 = pick(WORDS, seed);
      seed = lcg(seed);
      const w3 = pick(WORDS, seed);
      const md = `## ${w1}\n\n${w2}\n\n## ${w3}`;
      expect(roundtrip(md), `iteration ${i}: ${JSON.stringify(md)}`).toBe(md);
    }
  });

  test("list followed by heading", () => {
    for (let i = 0; i < 20; i++) {
      let seed = lcg(i + 500);
      const item1 = pick(WORDS, seed);
      seed = lcg(seed);
      const item2 = pick(WORDS, seed);
      seed = lcg(seed);
      const title = pick(WORDS, seed);
      const md = `- ${item1}\n- ${item2}\n\n## ${title}`;
      expect(roundtrip(md), `iteration ${i}: ${JSON.stringify(md)}`).toBe(md);
    }
  });

  test("code block surrounded by paragraphs", () => {
    for (let i = 0; i < 20; i++) {
      let seed = lcg(i + 600);
      const before = pick(WORDS, seed);
      seed = lcg(seed);
      const lang = pick(["js", "ts", "py", ""], seed);
      seed = lcg(seed);
      const code = pick(WORDS, seed);
      seed = lcg(seed);
      const after = pick(WORDS, seed);
      const md = `${before}\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n${after}`;
      expect(roundtrip(md), `iteration ${i}: ${JSON.stringify(md)}`).toBe(md);
    }
  });

  test("mixed blank lines in paragraph sequences", () => {
    // Patterns: single \n, double \n\n, and triple \n\n\n all roundtrip
    for (let i = 0; i < 30; i++) {
      let seed = lcg(i + 700);
      const w1 = pick(WORDS, seed);
      seed = lcg(seed);
      const w2 = pick(WORDS, seed);
      seed = lcg(seed);
      const w3 = pick(WORDS, seed);
      // Two blank lines between paragraphs (three newlines total)
      const md = `${w1}\n\n\n${w2}\n${w3}`;
      expect(roundtrip(md), `iteration ${i}: ${JSON.stringify(md)}`).toBe(md);
    }
  });
});
