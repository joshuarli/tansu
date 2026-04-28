import {
  createWikiLinkExtension,
  createWikiImageExtension,
  createCalloutExtension,
} from "../src/index.ts";
import { renderMarkdown } from "../src/markdown.ts";

const wikiLinkOpts = { extensions: [createWikiLinkExtension()] };
const wikiImageOpts = {
  extensions: [createWikiImageExtension({ resolveUrl: (n) => `/z-images/${n}` })],
};
const calloutOpts = { extensions: [createCalloutExtension()] };

describe("headings", () => {
  it("h1", () => {
    expect(renderMarkdown("# Hello")).toContain("<h1>Hello</h1>");
  });
  it("h2", () => {
    expect(renderMarkdown("## Sub")).toContain("<h2>Sub</h2>");
  });
  it("h6", () => {
    expect(renderMarkdown("###### Deep")).toContain("<h6>Deep</h6>");
  });
});

describe("paragraphs", () => {
  it("paragraph", () => {
    expect(renderMarkdown("Hello world")).toContain("<p>Hello world</p>");
  });
  it("para 1", () => {
    expect(renderMarkdown("First\n\nSecond")).toContain("<p>First</p>");
  });
  it("para 2", () => {
    expect(renderMarkdown("First\n\nSecond")).toContain("<p>Second</p>");
  });
  it("extra blank line renders placeholder paragraph", () => {
    const html = renderMarkdown("First\n\n\nSecond");
    expect(html.match(/data-md-blank="true"/g) ?? []).toHaveLength(2);
  });
  it("leading and trailing blank lines render placeholders", () => {
    const html = renderMarkdown("\nFirst\n");
    expect(html.match(/data-md-blank="true"/g) ?? []).toHaveLength(2);
  });
});

describe("inline formatting", () => {
  it("bold", () => {
    expect(renderMarkdown("**bold**")).toContain("<strong>bold</strong>");
  });
  it("italic", () => {
    expect(renderMarkdown("*italic*")).toContain("<em>italic</em>");
  });
  it("inline code", () => {
    expect(renderMarkdown("use `foo` here")).toContain("<code>foo</code>");
  });
  it("strikethrough", () => {
    expect(renderMarkdown("~~deleted~~")).toContain("<del>deleted</del>");
  });
  it("highlight", () => {
    expect(renderMarkdown("==marked==")).toContain("<mark>marked</mark>");
  });
});

describe("wiki-links", () => {
  it("wiki-link class", () => {
    expect(renderMarkdown("See [[my note]]", wikiLinkOpts)).toContain('class="wiki-link"');
  });
  it("wiki-link target", () => {
    expect(renderMarkdown("See [[my note]]", wikiLinkOpts)).toContain('data-target="my note"');
  });
  it("wiki-link pipe target", () => {
    expect(renderMarkdown("See [[target|display]]", wikiLinkOpts)).toContain(
      'data-target="target"',
    );
  });
  it("wiki-link pipe display", () => {
    expect(renderMarkdown("See [[target|display]]", wikiLinkOpts)).toContain(">display</a>");
  });
});

describe("wiki-images", () => {
  it("wiki-image tag", () => {
    expect(renderMarkdown("![[photo.webp]]", wikiImageOpts)).toContain("<img");
  });
  it("wiki-image data", () => {
    expect(renderMarkdown("![[photo.webp]]", wikiImageOpts)).toContain(
      'data-wiki-image="photo.webp"',
    );
  });
  it("wiki-image src", () => {
    expect(renderMarkdown("![[photo.webp]]", wikiImageOpts)).toContain("/z-images/");
  });
});

describe("links and images", () => {
  it("link", () => {
    expect(renderMarkdown("[text](http://url)")).toContain('<a href="http://url">text</a>');
  });
  it("image", () => {
    expect(renderMarkdown("![alt](src.png)")).toContain("<img");
  });
  it("image alt", () => {
    expect(renderMarkdown("![alt](src.png)")).toContain('alt="alt"');
  });
});

describe("bare URL autolink", () => {
  it("https link rendered", () => {
    expect(renderMarkdown("https://example.com")).toContain(
      '<a href="https://example.com">https://example.com</a>',
    );
  });
  it("http link rendered", () => {
    expect(renderMarkdown("http://example.com")).toContain(
      '<a href="http://example.com">http://example.com</a>',
    );
  });
  it("trailing period stripped", () => {
    expect(renderMarkdown("See https://example.com.")).toContain('<a href="https://example.com">');
  });
  it("url mid-sentence", () => {
    expect(renderMarkdown("Visit https://example.com today")).toContain(
      '<a href="https://example.com">',
    );
  });
  it("markdown link not double-linked", () => {
    const out = renderMarkdown("[text](https://example.com)");
    expect(out).toContain('<a href="https://example.com">text</a>');
    expect(out.match(/<a /g) ?? []).toHaveLength(1);
  });
});

describe("code blocks", () => {
  it("code block lang", () => {
    const code = renderMarkdown("```js\nconst x = 1;\n```");
    expect(code).toContain('<pre><code class="language-js">');
  });
  it("code block has keyword", () => {
    const code = renderMarkdown("```js\nconst x = 1;\n```");
    expect(code).toContain("const");
  });
  it("code block has highlight class", () => {
    const code = renderMarkdown("```js\nconst x = 1;\n```");
    expect(code).toContain("hl-kw");
  });
  it("code no lang", () => {
    expect(renderMarkdown("```\nhello\n```")).toContain("<pre><code>");
  });
});

describe("lists", () => {
  it("ul tag", () => {
    expect(renderMarkdown("- one\n- two\n- three")).toContain("<ul>");
  });
  it("ul item", () => {
    expect(renderMarkdown("- one\n- two\n- three")).toContain("<li>one</li>");
  });
  it("ol tag", () => {
    expect(renderMarkdown("1. first\n2. second")).toContain("<ol>");
  });
  it("ol item", () => {
    expect(renderMarkdown("1. first\n2. second")).toContain("<li>first</li>");
  });
  it("task checkbox", () => {
    expect(renderMarkdown("- [ ] todo\n- [x] done")).toContain('type="checkbox"');
  });
  it("task checked", () => {
    expect(renderMarkdown("- [ ] todo\n- [x] done")).toContain("checked");
  });
  it("task checkbox is interactive", () => {
    expect(renderMarkdown("- [ ] todo\n- [x] done")).not.toContain("disabled");
  });
  it("task list hides bullets via class", () => {
    expect(renderMarkdown("- [ ] todo\n- [x] done")).toContain('class="task-list"');
  });
  it("task unchecked text", () => {
    expect(renderMarkdown("- [ ] todo\n- [x] done")).toContain("todo");
  });
  it("bare task line renders as an interactive checkbox", () => {
    const html = renderMarkdown("[ ] todo\n[x] done");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("todo");
    expect(html).not.toContain("disabled");
  });
  it("nested ul renders nested list", () => {
    const html = renderMarkdown("- parent\n  - child");
    expect((html.match(/<ul>/g) ?? []).length).toBeGreaterThan(1);
    expect(html).toContain("<li>child</li>");
  });
  it("nested ul handles tab indentation", () => {
    const html = renderMarkdown("- parent\n\t- child");
    expect(html).toContain("<li>child</li>");
  });
  it("empty list item renders with placeholder", () => {
    expect(renderMarkdown("- one\n- ")).toContain("<li><br></li>");
  });
  it("bare empty list marker renders as empty list item", () => {
    expect(renderMarkdown("- one\n-")).toContain("<li><br></li>");
  });
});

describe("blockquotes", () => {
  it("blockquote", () => {
    expect(renderMarkdown("> quoted text")).toContain("<blockquote>");
  });
  it("blockquote text", () => {
    expect(renderMarkdown("> quoted text")).toContain("quoted text");
  });
});

describe("callouts", () => {
  it("callout type", () => {
    expect(renderMarkdown("> [!warning] Be careful\n> This is important", calloutOpts)).toContain(
      "callout-warning",
    );
  });
  it("callout title", () => {
    expect(renderMarkdown("> [!warning] Be careful\n> This is important", calloutOpts)).toContain(
      "Be careful",
    );
  });
  it("callout body", () => {
    expect(renderMarkdown("> [!warning] Be careful\n> This is important", calloutOpts)).toContain(
      "This is important",
    );
  });
  it("callout default title", () => {
    expect(renderMarkdown("> [!note]\n> Body here", calloutOpts)).toContain("Note");
  });
});

describe("tables", () => {
  it("table", () => {
    expect(renderMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |")).toContain("<table>");
  });
  it("table header", () => {
    expect(renderMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |")).toContain("<th>A</th>");
  });
  it("table cell", () => {
    expect(renderMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |")).toContain("<td>1</td>");
  });
});

describe("horizontal rules", () => {
  it("hr dashes", () => {
    expect(renderMarkdown("---")).toContain("<hr>");
  });
  it("hr stars", () => {
    expect(renderMarkdown("***")).toContain("<hr>");
  });
});

describe("escaping", () => {
  it("escaped not italic", () => {
    expect(renderMarkdown(String.raw`\*not italic\*`)).not.toContain("<em>");
  });
  it("escaped shows literal", () => {
    expect(renderMarkdown(String.raw`\*not italic\*`)).toContain("*");
  });
});

describe("nested inline", () => {
  it("nested bold", () => {
    expect(renderMarkdown("**bold *and italic***")).toContain("<strong>");
  });
});

describe("HTML escaping", () => {
  it("no raw script tag", () => {
    expect(renderMarkdown('<script>alert("xss")</script>')).not.toContain("<script>");
  });
  it("escaped script", () => {
    expect(renderMarkdown('<script>alert("xss")</script>')).toContain("&lt;script&gt;");
  });
});

describe("line model", () => {
  it("adjacent lines render as separate paragraphs", () => {
    const html = renderMarkdown("line1\nline2");
    expect(html).toContain("<p>line1</p>");
    expect(html).toContain("<p>line2</p>");
  });
  it("adjacent lines do not produce a br", () => {
    expect(renderMarkdown("line1\nline2")).not.toContain("<br>");
  });
  it("three consecutive lines become three paragraphs", () => {
    const html = renderMarkdown("a\nb\nc");
    expect(html).toContain("<p>a</p>");
    expect(html).toContain("<p>b</p>");
    expect(html).toContain("<p>c</p>");
  });
  it("blank line between paragraphs renders placeholder", () => {
    expect(renderMarkdown("foo\n\nbar")).toContain('data-md-blank="true"');
  });
  it("blank line placeholder has br inside", () => {
    expect(renderMarkdown("foo\n\nbar")).toContain('data-md-blank="true"><br>');
  });
  it("two blank lines produce two placeholders", () => {
    const html = renderMarkdown("foo\n\n\nbar");
    expect(html.match(/data-md-blank/g) ?? []).toHaveLength(2);
  });
  it("text before heading becomes its own paragraph", () => {
    const html = renderMarkdown("intro\n## Heading");
    expect(html).toContain("<p>intro</p>");
    expect(html).toContain("<h2>Heading</h2>");
  });
});

describe("inline branches", () => {
  it("escaped characters prevent formatting", () => {
    const html = renderMarkdown(String.raw`\*not bold\*`);
    expect(html).not.toContain("<strong>");
    expect(html).not.toContain("<em>");
    expect(html).toContain("*");
  });

  it("wiki-image renders img tag with src", () => {
    const html = renderMarkdown("![[image.png]]", wikiImageOpts);
    expect(html).toContain("<img");
    expect(html).toContain('data-wiki-image="image.png"');
    expect(html).toContain("/z-images/image.png");
  });

  it("highlight renders mark tag", () => {
    const html = renderMarkdown("==highlighted==");
    expect(html).toContain("<mark>highlighted</mark>");
  });

  it("strikethrough renders del tag", () => {
    const html = renderMarkdown("~~struck~~");
    expect(html).toContain("<del>struck</del>");
  });

  it("standard image renders img tag", () => {
    const html = renderMarkdown("![alt text](http://example.com/img.png)");
    expect(html).toContain("<img");
    expect(html).toContain('alt="alt text"');
    expect(html).toContain('src="http://example.com/img.png"');
  });

  it("standard link renders anchor tag", () => {
    const html = renderMarkdown("[click here](http://example.com)");
    expect(html).toContain('<a href="http://example.com">click here</a>');
  });

  it("table renders with headers and cells", () => {
    const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<th>b</th>");
    expect(html).toContain("<td>1</td>");
    expect(html).toContain("<td>2</td>");
  });

  it("inline code inside link text", () => {
    const html = renderMarkdown("[`code`](http://url)");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('<a href="http://url">');
  });

  it("ampersand is escaped", () => {
    const html = renderMarkdown("a & b");
    expect(html).toContain("&amp;");
  });
});

describe("edge cases", () => {
  it("empty input", () => {
    expect(renderMarkdown("")).toBe("");
  });
  it("code escapes html", () => {
    expect(renderMarkdown("```\n<div>test</div>\n```")).toContain("&lt;div&gt;");
  });
});
