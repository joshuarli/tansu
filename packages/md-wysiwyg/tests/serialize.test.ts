import { describe, test, expect, beforeAll, afterAll } from "vitest";

import { domToMarkdown } from "../src/serialize.ts";
import { setupDOM } from "./test-helper.ts";

describe("serialize", () => {
  let cleanup: () => void;

  function html(content: string): HTMLElement {
    const el = document.createElement("div");
    el.innerHTML = content;
    return el;
  }

  beforeAll(() => {
    cleanup = setupDOM();
  });

  afterAll(() => {
    cleanup();
  });

  test("h1", () => {
    expect(domToMarkdown(html("<h1>Title</h1>"))).toBe("# Title");
  });
  test("h2", () => {
    expect(domToMarkdown(html("<h2>Sub</h2>"))).toBe("## Sub");
  });
  test("h3", () => {
    expect(domToMarkdown(html("<h3>Deep</h3>"))).toBe("### Deep");
  });
  test("h6", () => {
    expect(domToMarkdown(html("<h6>H6</h6>"))).toBe("###### H6");
  });
  test("paragraph", () => {
    expect(domToMarkdown(html("<p>Hello world</p>"))).toBe("Hello world");
  });

  test("heading + paragraph", () => {
    expect(domToMarkdown(html("<h1>Title</h1><p>Body</p>"))).toBe("# Title\n\nBody");
  });

  test("two adjacent paragraphs use single newline", () => {
    expect(domToMarkdown(html("<p>foo</p><p>bar</p>"))).toBe("foo\nbar");
  });
  test("three adjacent paragraphs", () => {
    expect(domToMarkdown(html("<p>a</p><p>b</p><p>c</p>"))).toBe("a\nb\nc");
  });
  test("h2 + paragraph uses double newline", () => {
    expect(domToMarkdown(html("<h2>Title</h2><p>Body</p>"))).toBe("## Title\n\nBody");
  });
  test("paragraph + h2 uses double newline", () => {
    expect(domToMarkdown(html("<p>intro</p><h2>Title</h2>"))).toBe("intro\n\n## Title");
  });
  test("paragraph + code block uses double newline", () => {
    expect(domToMarkdown(html('<p>before</p><pre><code class="language-js">x</code></pre>'))).toBe(
      "before\n\n```js\nx\n```",
    );
  });

  test("bold", () => {
    expect(domToMarkdown(html("<p><strong>bold</strong></p>"))).toBe("**bold**");
  });
  test("b tag", () => {
    expect(domToMarkdown(html("<p><b>bold</b></p>"))).toBe("**bold**");
  });
  test("italic", () => {
    expect(domToMarkdown(html("<p><em>italic</em></p>"))).toBe("*italic*");
  });
  test("i tag", () => {
    expect(domToMarkdown(html("<p><i>italic</i></p>"))).toBe("*italic*");
  });
  test("strikethrough del", () => {
    expect(domToMarkdown(html("<p><del>deleted</del></p>"))).toBe("~~deleted~~");
  });
  test("strikethrough s", () => {
    expect(domToMarkdown(html("<p><s>deleted</s></p>"))).toBe("~~deleted~~");
  });
  test("highlight", () => {
    expect(domToMarkdown(html("<p><mark>marked</mark></p>"))).toBe("==marked==");
  });
  test("inline code", () => {
    expect(domToMarkdown(html("<p><code>code</code></p>"))).toBe("`code`");
  });

  test("link", () => {
    expect(domToMarkdown(html('<p><a href="http://example.com">click</a></p>'))).toBe(
      "[click](http://example.com)",
    );
  });

  test("wiki-link same display", () => {
    expect(
      domToMarkdown(html('<p><a class="wiki-link" data-target="My Note">My Note</a></p>')),
    ).toBe("[[My Note]]");
  });

  test("wiki-link different display", () => {
    expect(
      domToMarkdown(html('<p><a class="wiki-link" data-target="target">display</a></p>')),
    ).toBe("[[target|display]]");
  });

  test("image", () => {
    expect(domToMarkdown(html('<p><img src="photo.png" alt="desc"></p>'))).toBe(
      "![desc](photo.png)",
    );
  });

  test("wiki-image", () => {
    expect(
      domToMarkdown(
        html(
          '<p><img data-wiki-image="photo.webp" src="/z-images/photo.webp" alt="photo.webp"></p>',
        ),
      ),
    ).toBe("![[photo.webp]]");
  });

  test("hr", () => {
    expect(domToMarkdown(html("<hr>"))).toBe("---");
  });
  test("ul", () => {
    expect(domToMarkdown(html("<ul><li>one</li><li>two</li></ul>"))).toBe("- one\n- two");
  });

  test("ol", () => {
    expect(domToMarkdown(html("<ol><li>first</li><li>second</li></ol>"))).toBe(
      "1. first\n2. second",
    );
  });

  test("nested ul", () => {
    expect(domToMarkdown(html("<ul><li>parent<ul><li>child</li></ul></li></ul>"))).toBe(
      "- parent\n  - child",
    );
  });

  test("browser-style sibling nested ul", () => {
    expect(domToMarkdown(html("<ul><li>parent</li><ul><li><br></li></ul></ul>"))).toBe(
      "- parent\n  - ",
    );
  });

  test("empty top-level list item", () => {
    expect(domToMarkdown(html("<ul><li>one</li><li><br></li></ul>"))).toBe("- one\n- ");
  });

  test("malformed paragraph wrapping a list", () => {
    expect(domToMarkdown(html("<p><ul><li>a</li></ul></p>"))).toBe("- a");
  });

  test("blank paragraph marker preserves extra blank line", () => {
    expect(domToMarkdown(html('<p>First</p><p data-md-blank="true"><br></p><p>Second</p>'))).toBe(
      "First\n\nSecond",
    );
  });

  test("blank paragraph marker preserves leading and trailing blank lines", () => {
    expect(
      domToMarkdown(
        html('<p data-md-blank="true"><br></p><p>First</p><p data-md-blank="true"><br></p>'),
      ),
    ).toBe("\nFirst\n");
  });

  test("paragraph followed by list uses a single newline", () => {
    expect(domToMarkdown(html("<p>foo:</p><ul><li>one</li></ul>"))).toBe("foo:\n- one");
  });

  test("list followed by paragraph uses a single newline", () => {
    expect(domToMarkdown(html("<ul><li>one</li><li><br></li></ul><p>dsf</p>"))).toBe(
      "- one\n- \ndsf",
    );
  });

  test("task list", () => {
    const root = document.createElement("div");
    const ul = document.createElement("ul");
    const li1 = document.createElement("li");
    const cb1 = document.createElement("input");
    cb1.type = "checkbox";
    li1.appendChild(cb1);
    li1.appendChild(document.createTextNode("todo"));
    const li2 = document.createElement("li");
    const cb2 = document.createElement("input");
    cb2.type = "checkbox";
    cb2.checked = true;
    li2.appendChild(cb2);
    li2.appendChild(document.createTextNode("done"));
    ul.append(li1, li2);
    root.appendChild(ul);
    expect(domToMarkdown(root)).toBe("- [ ] todo\n- [x] done");
  });

  test("code block with lang", () => {
    expect(domToMarkdown(html('<pre><code class="language-js">const x = 1;</code></pre>'))).toBe(
      "```js\nconst x = 1;\n```",
    );
  });

  test("code block no lang", () => {
    expect(domToMarkdown(html("<pre><code>plain code</code></pre>"))).toBe("```\nplain code\n```");
  });

  test("blockquote", () => {
    expect(domToMarkdown(html("<blockquote><p>quoted</p></blockquote>"))).toContain("> quoted");
  });

  test("table header", () => {
    const tableHtml = "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>";
    expect(domToMarkdown(html(tableHtml))).toContain("| A | B |");
  });

  test("table separator", () => {
    const tableHtml = "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>";
    expect(domToMarkdown(html(tableHtml))).toContain("| --- | --- |");
  });

  test("table row", () => {
    const tableHtml = "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>";
    expect(domToMarkdown(html(tableHtml))).toContain("| 1 | 2 |");
  });

  test("callout type", () => {
    const calloutHtml = `<div class="callout callout-warning" data-callout="warning">
  <div class="callout-title">\u26a0\ufe0f Be careful</div>
  <div class="callout-body"><p>This is important</p></div>
</div>`;
    expect(domToMarkdown(html(calloutHtml))).toContain("> [!warning]");
  });

  test("callout title", () => {
    const calloutHtml = `<div class="callout callout-warning" data-callout="warning">
  <div class="callout-title">\u26a0\ufe0f Be careful</div>
  <div class="callout-body"><p>This is important</p></div>
</div>`;
    expect(domToMarkdown(html(calloutHtml))).toContain("Be careful");
  });

  test("callout body", () => {
    const calloutHtml = `<div class="callout callout-warning" data-callout="warning">
  <div class="callout-title">\u26a0\ufe0f Be careful</div>
  <div class="callout-body"><p>This is important</p></div>
</div>`;
    expect(domToMarkdown(html(calloutHtml))).toContain("> This is important");
  });

  test("nested bold italic", () => {
    expect(domToMarkdown(html("<p><strong><em>bold italic</em></strong></p>"))).toBe(
      "***bold italic***",
    );
  });

  test("br to newline", () => {
    expect(domToMarkdown(html("<p>line1<br>line2</p>"))).toContain("line1\nline2");
  });

  test("empty", () => {
    expect(domToMarkdown(html(""))).toBe("");
  });
  test("div as paragraph", () => {
    expect(domToMarkdown(html("<div>text</div>"))).toBe("text");
  });
});
