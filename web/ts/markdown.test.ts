import { describe, test, expect } from "bun:test";

import { renderMarkdown } from "./markdown.ts";

describe("headings", () => {
  test("h1", () => {
    expect(renderMarkdown("# Hello")).toContain("<h1>Hello</h1>");
  });
  test("h2", () => {
    expect(renderMarkdown("## Sub")).toContain("<h2>Sub</h2>");
  });
  test("h6", () => {
    expect(renderMarkdown("###### Deep")).toContain("<h6>Deep</h6>");
  });
});

describe("paragraphs", () => {
  test("paragraph", () => {
    expect(renderMarkdown("Hello world")).toContain("<p>Hello world</p>");
  });
  test("para 1", () => {
    expect(renderMarkdown("First\n\nSecond")).toContain("<p>First</p>");
  });
  test("para 2", () => {
    expect(renderMarkdown("First\n\nSecond")).toContain("<p>Second</p>");
  });
});

describe("inline formatting", () => {
  test("bold", () => {
    expect(renderMarkdown("**bold**")).toContain("<strong>bold</strong>");
  });
  test("italic", () => {
    expect(renderMarkdown("*italic*")).toContain("<em>italic</em>");
  });
  test("inline code", () => {
    expect(renderMarkdown("use `foo` here")).toContain("<code>foo</code>");
  });
  test("strikethrough", () => {
    expect(renderMarkdown("~~deleted~~")).toContain("<del>deleted</del>");
  });
  test("highlight", () => {
    expect(renderMarkdown("==marked==")).toContain("<mark>marked</mark>");
  });
});

describe("wiki-links", () => {
  test("wiki-link class", () => {
    expect(renderMarkdown("See [[my note]]")).toContain('class="wiki-link"');
  });
  test("wiki-link target", () => {
    expect(renderMarkdown("See [[my note]]")).toContain('data-target="my note"');
  });
  test("wiki-link pipe target", () => {
    expect(renderMarkdown("See [[target|display]]")).toContain('data-target="target"');
  });
  test("wiki-link pipe display", () => {
    expect(renderMarkdown("See [[target|display]]")).toContain(">display</a>");
  });
});

describe("wiki-images", () => {
  test("wiki-image tag", () => {
    expect(renderMarkdown("![[photo.webp]]")).toContain("<img");
  });
  test("wiki-image data", () => {
    expect(renderMarkdown("![[photo.webp]]")).toContain('data-wiki-image="photo.webp"');
  });
  test("wiki-image src", () => {
    expect(renderMarkdown("![[photo.webp]]")).toContain("/z-images/");
  });
});

describe("links and images", () => {
  test("link", () => {
    expect(renderMarkdown("[text](http://url)")).toContain('<a href="http://url">text</a>');
  });
  test("image", () => {
    expect(renderMarkdown("![alt](src.png)")).toContain("<img");
  });
  test("image alt", () => {
    expect(renderMarkdown("![alt](src.png)")).toContain('alt="alt"');
  });
});

describe("code blocks", () => {
  test("code block lang", () => {
    const code = renderMarkdown("```js\nconst x = 1;\n```");
    expect(code).toContain('<pre><code class="language-js">');
  });
  test("code block has keyword", () => {
    const code = renderMarkdown("```js\nconst x = 1;\n```");
    expect(code).toContain("const");
  });
  test("code block has highlight class", () => {
    const code = renderMarkdown("```js\nconst x = 1;\n```");
    expect(code).toContain("hl-kw");
  });
  test("code no lang", () => {
    expect(renderMarkdown("```\nhello\n```")).toContain("<pre><code>");
  });
});

describe("lists", () => {
  test("ul tag", () => {
    expect(renderMarkdown("- one\n- two\n- three")).toContain("<ul>");
  });
  test("ul item", () => {
    expect(renderMarkdown("- one\n- two\n- three")).toContain("<li>one</li>");
  });
  test("ol tag", () => {
    expect(renderMarkdown("1. first\n2. second")).toContain("<ol>");
  });
  test("ol item", () => {
    expect(renderMarkdown("1. first\n2. second")).toContain("<li>first</li>");
  });
  test("task checkbox", () => {
    expect(renderMarkdown("- [ ] todo\n- [x] done")).toContain('type="checkbox"');
  });
  test("task checked", () => {
    expect(renderMarkdown("- [ ] todo\n- [x] done")).toContain("checked");
  });
  test("task unchecked text", () => {
    expect(renderMarkdown("- [ ] todo\n- [x] done")).toContain("todo");
  });
});

describe("blockquotes", () => {
  test("blockquote", () => {
    expect(renderMarkdown("> quoted text")).toContain("<blockquote>");
  });
  test("blockquote text", () => {
    expect(renderMarkdown("> quoted text")).toContain("quoted text");
  });
});

describe("callouts", () => {
  test("callout type", () => {
    expect(renderMarkdown("> [!warning] Be careful\n> This is important")).toContain(
      "callout-warning",
    );
  });
  test("callout title", () => {
    expect(renderMarkdown("> [!warning] Be careful\n> This is important")).toContain("Be careful");
  });
  test("callout body", () => {
    expect(renderMarkdown("> [!warning] Be careful\n> This is important")).toContain(
      "This is important",
    );
  });
  test("callout default title", () => {
    expect(renderMarkdown("> [!note]\n> Body here")).toContain("Note");
  });
});

describe("tables", () => {
  test("table", () => {
    expect(renderMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |")).toContain("<table>");
  });
  test("table header", () => {
    expect(renderMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |")).toContain("<th>A</th>");
  });
  test("table cell", () => {
    expect(renderMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |")).toContain("<td>1</td>");
  });
});

describe("horizontal rules", () => {
  test("hr dashes", () => {
    expect(renderMarkdown("---")).toContain("<hr>");
  });
  test("hr stars", () => {
    expect(renderMarkdown("***")).toContain("<hr>");
  });
});

describe("escaping", () => {
  test("escaped not italic", () => {
    expect(renderMarkdown("\\*not italic\\*")).not.toContain("<em>");
  });
  test("escaped shows literal", () => {
    expect(renderMarkdown("\\*not italic\\*")).toContain("*");
  });
});

describe("nested inline", () => {
  test("nested bold", () => {
    expect(renderMarkdown("**bold *and italic***")).toContain("<strong>");
  });
});

describe("HTML escaping", () => {
  test("no raw script tag", () => {
    expect(renderMarkdown('<script>alert("xss")</script>')).not.toContain("<script>");
  });
  test("escaped script", () => {
    expect(renderMarkdown('<script>alert("xss")</script>')).toContain("&lt;script&gt;");
  });
});

describe("line breaks", () => {
  test("line break", () => {
    expect(renderMarkdown("line1\nline2")).toContain("<br>");
  });
});

describe("edge cases", () => {
  test("empty input", () => {
    expect(renderMarkdown("")).toBe("");
  });
  test("code escapes html", () => {
    expect(renderMarkdown("```\n<div>test</div>\n```")).toContain("&lt;div&gt;");
  });
});
