import {
  createWikiLinkExtension,
  createWikiImageExtension,
  createCalloutExtension,
} from "../src/index.ts";
import { domToMarkdown } from "../src/serialize.ts";
import { setupDOM } from "./test-helper.ts";

const wikiLinkOpts = { extensions: [createWikiLinkExtension()] };
const wikiImageOpts = {
  extensions: [createWikiImageExtension({ resolveUrl: (n) => `/z-images/${n}` })],
};
const calloutOpts = { extensions: [createCalloutExtension()] };

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

  it("h1", () => {
    expect(domToMarkdown(html("<h1>Title</h1>"))).toBe("# Title");
  });
  it("h2", () => {
    expect(domToMarkdown(html("<h2>Sub</h2>"))).toBe("## Sub");
  });
  it("h3", () => {
    expect(domToMarkdown(html("<h3>Deep</h3>"))).toBe("### Deep");
  });
  it("h6", () => {
    expect(domToMarkdown(html("<h6>H6</h6>"))).toBe("###### H6");
  });
  it("paragraph", () => {
    expect(domToMarkdown(html("<p>Hello world</p>"))).toBe("Hello world");
  });

  it("heading + paragraph", () => {
    expect(domToMarkdown(html("<h1>Title</h1><p>Body</p>"))).toBe("# Title\n\nBody");
  });

  it("two adjacent paragraphs use single newline", () => {
    expect(domToMarkdown(html("<p>foo</p><p>bar</p>"))).toBe("foo\nbar");
  });
  it("three adjacent paragraphs", () => {
    expect(domToMarkdown(html("<p>a</p><p>b</p><p>c</p>"))).toBe("a\nb\nc");
  });
  it("h2 + paragraph uses double newline", () => {
    expect(domToMarkdown(html("<h2>Title</h2><p>Body</p>"))).toBe("## Title\n\nBody");
  });
  it("paragraph + h2 uses double newline", () => {
    expect(domToMarkdown(html("<p>intro</p><h2>Title</h2>"))).toBe("intro\n\n## Title");
  });
  it("paragraph + code block uses double newline", () => {
    expect(domToMarkdown(html('<p>before</p><pre><code class="language-js">x</code></pre>'))).toBe(
      "before\n\n```js\nx\n```",
    );
  });

  it("bold", () => {
    expect(domToMarkdown(html("<p><strong>bold</strong></p>"))).toBe("**bold**");
  });
  it("b tag", () => {
    expect(domToMarkdown(html("<p><b>bold</b></p>"))).toBe("**bold**");
  });
  it("italic", () => {
    expect(domToMarkdown(html("<p><em>italic</em></p>"))).toBe("*italic*");
  });
  it("i tag", () => {
    expect(domToMarkdown(html("<p><i>italic</i></p>"))).toBe("*italic*");
  });
  it("strikethrough del", () => {
    expect(domToMarkdown(html("<p><del>deleted</del></p>"))).toBe("~~deleted~~");
  });
  it("strikethrough s", () => {
    expect(domToMarkdown(html("<p><s>deleted</s></p>"))).toBe("~~deleted~~");
  });
  it("highlight", () => {
    expect(domToMarkdown(html("<p><mark>marked</mark></p>"))).toBe("==marked==");
  });
  it("inline code", () => {
    expect(domToMarkdown(html("<p><code>code</code></p>"))).toBe("`code`");
  });

  it("link", () => {
    expect(domToMarkdown(html('<p><a href="http://example.com">click</a></p>'))).toBe(
      "[click](http://example.com)",
    );
  });

  it("wiki-link same display", () => {
    expect(
      domToMarkdown(
        html('<p><a class="wiki-link" data-target="My Note">My Note</a></p>'),
        wikiLinkOpts,
      ),
    ).toBe("[[My Note]]");
  });

  it("wiki-link different display", () => {
    expect(
      domToMarkdown(
        html('<p><a class="wiki-link" data-target="target">display</a></p>'),
        wikiLinkOpts,
      ),
    ).toBe("[[target|display]]");
  });

  it("image", () => {
    expect(domToMarkdown(html('<p><img src="photo.png" alt="desc"></p>'))).toBe(
      "![desc](photo.png)",
    );
  });

  it("wiki-image", () => {
    expect(
      domToMarkdown(
        html(
          '<p><img data-wiki-image="photo.webp" src="/z-images/photo.webp" alt="photo.webp"></p>',
        ),
        wikiImageOpts,
      ),
    ).toBe("![[photo.webp]]");
  });

  it("hr", () => {
    expect(domToMarkdown(html("<hr>"))).toBe("---");
  });
  it("ul", () => {
    expect(domToMarkdown(html("<ul><li>one</li><li>two</li></ul>"))).toBe("- one\n- two");
  });

  it("ol", () => {
    expect(domToMarkdown(html("<ol><li>first</li><li>second</li></ol>"))).toBe(
      "1. first\n2. second",
    );
  });

  it("nested ul", () => {
    expect(domToMarkdown(html("<ul><li>parent<ul><li>child</li></ul></li></ul>"))).toBe(
      "- parent\n  - child",
    );
  });

  it("browser-style sibling nested ul", () => {
    expect(domToMarkdown(html("<ul><li>parent</li><ul><li><br></li></ul></ul>"))).toBe(
      "- parent\n  - ",
    );
  });

  it("empty top-level list item", () => {
    expect(domToMarkdown(html("<ul><li>one</li><li><br></li></ul>"))).toBe("- one\n- ");
  });

  it("malformed paragraph wrapping a list", () => {
    expect(domToMarkdown(html("<p><ul><li>a</li></ul></p>"))).toBe("- a");
  });

  it("blank paragraph marker preserves extra blank line", () => {
    expect(domToMarkdown(html('<p>First</p><p data-md-blank="true"><br></p><p>Second</p>'))).toBe(
      "First\n\nSecond",
    );
  });

  it("blank paragraph marker preserves leading and trailing blank lines", () => {
    expect(
      domToMarkdown(
        html('<p data-md-blank="true"><br></p><p>First</p><p data-md-blank="true"><br></p>'),
      ),
    ).toBe("\nFirst\n");
  });

  it("paragraph followed by list uses a single newline", () => {
    expect(domToMarkdown(html("<p>foo:</p><ul><li>one</li></ul>"))).toBe("foo:\n- one");
  });

  it("list followed by paragraph uses a single newline", () => {
    expect(domToMarkdown(html("<ul><li>one</li><li><br></li></ul><p>dsf</p>"))).toBe(
      "- one\n- \ndsf",
    );
  });

  it("task list", () => {
    const root = document.createElement("div");
    const ul = document.createElement("ul");
    const li1 = document.createElement("li");
    const cb1 = document.createElement("input");
    cb1.type = "checkbox";
    li1.append(cb1);
    li1.append(document.createTextNode("todo"));
    const li2 = document.createElement("li");
    const cb2 = document.createElement("input");
    cb2.type = "checkbox";
    cb2.checked = true;
    li2.append(cb2);
    li2.append(document.createTextNode("done"));
    ul.append(li1, li2);
    root.append(ul);
    expect(domToMarkdown(root)).toBe("- [ ] todo\n- [x] done");
  });

  it("bare task line", () => {
    const root = html(
      '<ul class="task-list"><li class="task-item"><input type="checkbox"> todo</li><li class="task-item"><input type="checkbox" checked> done</li></ul>',
    );
    expect(domToMarkdown(root)).toBe("- [ ] todo\n- [x] done");
  });

  it("code block with lang", () => {
    expect(domToMarkdown(html('<pre><code class="language-js">const x = 1;</code></pre>'))).toBe(
      "```js\nconst x = 1;\n```",
    );
  });

  it("code block no lang", () => {
    expect(domToMarkdown(html("<pre><code>plain code</code></pre>"))).toBe("```\nplain code\n```");
  });

  it("blockquote", () => {
    expect(domToMarkdown(html("<blockquote><p>quoted</p></blockquote>"))).toContain("> quoted");
  });

  it("table header", () => {
    const tableHtml = "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>";
    expect(domToMarkdown(html(tableHtml))).toContain("| A | B |");
  });

  it("table separator", () => {
    const tableHtml = "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>";
    expect(domToMarkdown(html(tableHtml))).toContain("| --- | --- |");
  });

  it("table row", () => {
    const tableHtml = "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>";
    expect(domToMarkdown(html(tableHtml))).toContain("| 1 | 2 |");
  });

  it("callout type", () => {
    const calloutHtml = `<div class="callout callout-warning" data-callout="warning">
  <div class="callout-title">\u26A0\uFE0F Be careful</div>
  <div class="callout-body"><p>This is important</p></div>
</div>`;
    expect(domToMarkdown(html(calloutHtml), calloutOpts)).toContain("> [!warning]");
  });

  it("callout title", () => {
    const calloutHtml = `<div class="callout callout-warning" data-callout="warning">
  <div class="callout-title">\u26A0\uFE0F Be careful</div>
  <div class="callout-body"><p>This is important</p></div>
</div>`;
    expect(domToMarkdown(html(calloutHtml), calloutOpts)).toContain("Be careful");
  });

  it("callout body", () => {
    const calloutHtml = `<div class="callout callout-warning" data-callout="warning">
  <div class="callout-title">\u26A0\uFE0F Be careful</div>
  <div class="callout-body"><p>This is important</p></div>
</div>`;
    expect(domToMarkdown(html(calloutHtml), calloutOpts)).toContain("> This is important");
  });

  it("nbsp in plain text normalizes to space", () => {
    expect(domToMarkdown(html("<p>hello world</p>"))).toBe("hello world");
  });

  it("trailing nbsp normalizes to space", () => {
    expect(domToMarkdown(html("<p>hello </p>"))).toBe("hello ");
  });

  it("consecutive nbsp normalizes to spaces", () => {
    expect(domToMarkdown(html("<p>a  b</p>"))).toBe("a  b");
  });

  it("nbsp inside bold normalizes to space", () => {
    expect(domToMarkdown(html("<p><strong>foo bar</strong></p>"))).toBe("**foo bar**");
  });

  it("nbsp inside italic normalizes to space", () => {
    expect(domToMarkdown(html("<p><em>foo bar</em></p>"))).toBe("*foo bar*");
  });

  it("zero-width space is stripped", () => {
    expect(domToMarkdown(html("<p>foo​bar</p>"))).toBe("foobar");
  });

  it("mixed nbsp and zero-width space", () => {
    expect(domToMarkdown(html("<p>a​ b</p>"))).toBe("a b");
  });

  it("nested bold italic", () => {
    expect(domToMarkdown(html("<p><strong><em>bold italic</em></strong></p>"))).toBe(
      "***bold italic***",
    );
  });

  it("br to newline", () => {
    expect(domToMarkdown(html("<p>line1<br>line2</p>"))).toContain("line1\nline2");
  });

  it("empty", () => {
    expect(domToMarkdown(html(""))).toBe("");
  });
  it("div as paragraph", () => {
    expect(domToMarkdown(html("<div>text</div>"))).toBe("text");
  });
});
