/// Roundtrip tests: markdown → HTML → markdown.
/// Verifies that domToMarkdown(renderMarkdown(md)) produces equivalent output.

import type { MarkdownExtension } from "../src/extension.ts";
import {
  createWikiLinkExtension,
  createWikiImageExtension,
  createCalloutExtension,
} from "../src/index.ts";
import { setupDOM } from "./test-helper.ts";

const allExts = [
  createWikiLinkExtension(),
  createWikiImageExtension({ resolveUrl: (n) => `/z-images/${n}` }),
  createCalloutExtension(),
];

describe("roundtrip", () => {
  let cleanup: () => void;
  let renderMarkdown: (md: string, opts?: { extensions?: MarkdownExtension[] }) => string;
  let domToMarkdown: (el: HTMLElement, opts?: { extensions?: MarkdownExtension[] }) => string;

  function roundtrip(md: string, opts?: { extensions?: MarkdownExtension[] }): string {
    const el = document.createElement("div");
    el.innerHTML = renderMarkdown(md, opts);
    return domToMarkdown(el, opts);
  }

  beforeAll(async () => {
    cleanup = setupDOM();
    const mdMod = await import("../src/markdown.ts");
    const serMod = await import("../src/serialize.ts");
    ({ renderMarkdown } = mdMod);
    ({ domToMarkdown } = serMod);
  });

  afterAll(() => {
    cleanup();
  });

  it("h1 roundtrip", () => {
    expect(roundtrip("# Hello")).toBe("# Hello");
  });
  it("h2 roundtrip", () => {
    expect(roundtrip("## Sub")).toBe("## Sub");
  });
  it("h6 roundtrip", () => {
    expect(roundtrip("###### Deep")).toBe("###### Deep");
  });
  it("paragraph roundtrip", () => {
    expect(roundtrip("Hello world")).toBe("Hello world");
  });
  it("single newline is preserved", () => {
    expect(roundtrip("foo\nbar")).toBe("foo\nbar");
  });
  it("three consecutive lines", () => {
    expect(roundtrip("a\nb\nc")).toBe("a\nb\nc");
  });
  it("two paragraphs", () => {
    expect(roundtrip("First\n\nSecond")).toBe("First\n\nSecond");
  });
  it("single newline vs double newline are distinct", () => {
    const single = roundtrip("foo\nbar");
    const double = roundtrip("foo\n\nbar");
    expect(single).toBe("foo\nbar");
    expect(double).toBe("foo\n\nbar");
    expect(single).not.toBe(double);
  });
  it("mixed lines and blank lines", () => {
    expect(roundtrip("a\nb\n\nc\nd")).toBe("a\nb\n\nc\nd");
  });
  it("text before heading gains blank line on roundtrip", () => {
    // Serializer always puts \n\n between non-para block types
    expect(roundtrip("intro\n## Heading")).toBe("intro\n\n## Heading");
  });
  it("text after heading is stable", () => {
    expect(roundtrip("## Heading\n\ntext")).toBe("## Heading\n\ntext");
  });
  it("extra blank line between paragraphs", () => {
    expect(roundtrip("First\n\n\nSecond")).toBe("First\n\n\nSecond");
  });
  it("leading and trailing blank lines", () => {
    expect(roundtrip("\nFirst\n\nSecond\n")).toBe("\nFirst\n\nSecond\n");
  });
  it("multiple trailing blank lines", () => {
    expect(roundtrip("First\n\n\n")).toBe("First\n\n\n");
  });
  it("bold roundtrip", () => {
    expect(roundtrip("**bold**")).toBe("**bold**");
  });
  it("italic roundtrip", () => {
    expect(roundtrip("*italic*")).toBe("*italic*");
  });
  it("inline code roundtrip", () => {
    expect(roundtrip("use `foo` here")).toBe("use `foo` here");
  });
  it("strikethrough roundtrip", () => {
    expect(roundtrip("~~deleted~~")).toBe("~~deleted~~");
  });
  it("highlight roundtrip", () => {
    expect(roundtrip("==marked==")).toBe("==marked==");
  });
  it("link roundtrip", () => {
    expect(roundtrip("[text](http://url)")).toBe("[text](http://url)");
  });
  it("bare https url roundtrip", () => {
    expect(roundtrip("https://example.com")).toBe("https://example.com");
  });
  it("bare url in sentence roundtrip", () => {
    expect(roundtrip("Visit https://example.com today")).toBe("Visit https://example.com today");
  });
  it("wiki-link roundtrip", () => {
    expect(roundtrip("[[my note]]", { extensions: allExts })).toBe("[[my note]]");
  });
  it("wiki-link pipe roundtrip", () => {
    expect(roundtrip("[[target|display]]", { extensions: allExts })).toBe("[[target|display]]");
  });
  it("image roundtrip", () => {
    expect(roundtrip("![alt](src.png)")).toBe("![alt](src.png)");
  });
  it("wiki-image roundtrip", () => {
    expect(roundtrip("![[photo.webp]]", { extensions: allExts })).toBe("![[photo.webp]]");
  });
  it("hr roundtrip", () => {
    expect(roundtrip("---")).toBe("---");
  });
  it("ul roundtrip", () => {
    expect(roundtrip("- one\n- two\n- three")).toBe("- one\n- two\n- three");
  });
  it("paragraph followed by list stays tight", () => {
    expect(roundtrip("foo:\n- one")).toBe("foo:\n- one");
  });
  it("empty list item followed by paragraph stays tight", () => {
    expect(roundtrip("foo:\n- one\n-\ndsf")).toBe("foo:\n- one\n- \ndsf");
  });
  it("nested ul roundtrip", () => {
    expect(roundtrip("- parent\n  - child")).toBe("- parent\n  - child");
  });
  it("empty list item roundtrip", () => {
    expect(roundtrip("- one\n- ")).toBe("- one\n- ");
  });
  it("ol roundtrip", () => {
    expect(roundtrip("1. first\n2. second")).toBe("1. first\n2. second");
  });

  it("code block roundtrip", () => {
    expect(roundtrip("```js\nconst x = 1;\n```")).toBe("```js\nconst x = 1;\n```");
  });

  it("code block no lang roundtrip", () => {
    expect(roundtrip("```\nhello\n```")).toBe("```\nhello\n```");
  });

  it("blockquote roundtrip", () => {
    expect(roundtrip("> quoted text")).toBe("> quoted text");
  });

  it("table header roundtrip", () => {
    const table = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const rt = roundtrip(table);
    expect(rt).toContain("| A | B |");
  });

  it("table row roundtrip", () => {
    const table = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const rt = roundtrip(table);
    expect(rt).toContain("| 1 | 2 |");
  });

  it("table separator roundtrip", () => {
    const table = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const rt = roundtrip(table);
    expect(rt).toContain("---");
  });

  it("callout type roundtrip", () => {
    const callout = "> [!warning] Be careful\n> This is important";
    const rt = roundtrip(callout, { extensions: allExts });
    expect(rt).toContain("[!warning]");
  });

  it("callout title roundtrip", () => {
    const callout = "> [!warning] Be careful\n> This is important";
    const rt = roundtrip(callout, { extensions: allExts });
    expect(rt).toContain("Be careful");
  });

  it("callout body roundtrip", () => {
    const callout = "> [!warning] Be careful\n> This is important";
    const rt = roundtrip(callout, { extensions: allExts });
    expect(rt).toContain("This is important");
  });

  it("nested inline roundtrip", () => {
    expect(roundtrip("**bold *and italic***")).toBe("**bold *and italic***");
  });

  it("code block html entities roundtrip", () => {
    expect(roundtrip("```\n<div>test</div>\n```")).toBe("```\n<div>test</div>\n```");
  });

  it("heading + paragraph roundtrip", () => {
    expect(roundtrip("# Title\n\nBody text")).toBe("# Title\n\nBody text");
  });

  it("complex doc heading", () => {
    const doc =
      "# Title\n\nSome **bold** and *italic* text.\n\n- item 1\n- item 2\n\n```js\nconst x = 1;\n```\n\n> A quote";
    expect(roundtrip(doc)).toContain("# Title");
  });

  it("complex doc bold", () => {
    const doc =
      "# Title\n\nSome **bold** and *italic* text.\n\n- item 1\n- item 2\n\n```js\nconst x = 1;\n```\n\n> A quote";
    expect(roundtrip(doc)).toContain("**bold**");
  });

  it("complex doc italic", () => {
    const doc =
      "# Title\n\nSome **bold** and *italic* text.\n\n- item 1\n- item 2\n\n```js\nconst x = 1;\n```\n\n> A quote";
    expect(roundtrip(doc)).toContain("*italic*");
  });

  it("complex doc list", () => {
    const doc =
      "# Title\n\nSome **bold** and *italic* text.\n\n- item 1\n- item 2\n\n```js\nconst x = 1;\n```\n\n> A quote";
    expect(roundtrip(doc)).toContain("- item 1");
  });

  it("complex doc code", () => {
    const doc =
      "# Title\n\nSome **bold** and *italic* text.\n\n- item 1\n- item 2\n\n```js\nconst x = 1;\n```\n\n> A quote";
    expect(roundtrip(doc)).toContain("```js");
  });

  it("complex doc quote", () => {
    const doc =
      "# Title\n\nSome **bold** and *italic* text.\n\n- item 1\n- item 2\n\n```js\nconst x = 1;\n```\n\n> A quote";
    expect(roundtrip(doc)).toContain("> A quote");
  });
});

// Deterministic LCG pseudo-random number generator — no external dependency.
function lcg(seed: number): number {
  // eslint-disable-next-line unicorn/prefer-math-trunc -- >>> 0 wraps to uint32, Math.trunc() does not
  return (1_664_525 * seed + 1_013_904_223) >>> 0;
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
    ({ renderMarkdown } = mdMod);
    ({ domToMarkdown } = serMod);
  });

  afterAll(() => {
    cleanup();
  });

  it("paragraph-only sequences with single newlines", () => {
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

  it("paragraph-only sequences with double newlines", () => {
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

  it("paragraphs with inline formatting roundtrip", () => {
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

  it("heading followed by paragraphs", () => {
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

  it("two headings with paragraph between", () => {
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

  it("list followed by heading", () => {
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

  it("code block surrounded by paragraphs", () => {
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

  it("mixed blank lines in paragraph sequences", () => {
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
