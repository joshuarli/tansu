/// Dedicated tests for the three built-in extension factories.

import {
  createWikiLinkExtension,
  createWikiImageExtension,
  createCalloutExtension,
} from "../src/index.ts";
import { renderMarkdown } from "../src/markdown.ts";
import { domToMarkdown } from "../src/serialize.ts";
import { setupDOM } from "./test-helper.ts";

const wikiLinkExt = createWikiLinkExtension();
const wikiImageExt = createWikiImageExtension({
  resolveUrl: (n) => `/files/${encodeURIComponent(n)}`,
});
const calloutExt = createCalloutExtension();

const linkOpts = { extensions: [wikiLinkExt] };
const imageOpts = { extensions: [wikiImageExt] };
const calloutOpts = { extensions: [calloutExt] };
const allOpts = { extensions: [wikiLinkExt, wikiImageExt, calloutExt] };

describe("createWikiLinkExtension — render", () => {
  it("plain wiki-link renders anchor with class", () => {
    expect(renderMarkdown("[[my note]]", linkOpts)).toContain('class="wiki-link"');
  });
  it("plain wiki-link sets data-target", () => {
    expect(renderMarkdown("[[my note]]", linkOpts)).toContain('data-target="my note"');
  });
  it("plain wiki-link uses title as text", () => {
    expect(renderMarkdown("[[my note]]", linkOpts)).toContain(">my note</a>");
  });
  it("piped wiki-link sets data-target to first part", () => {
    expect(renderMarkdown("[[target|display text]]", linkOpts)).toContain('data-target="target"');
  });
  it("piped wiki-link uses display as text", () => {
    expect(renderMarkdown("[[target|display text]]", linkOpts)).toContain(">display text</a>");
  });
  it("wiki-link mid-sentence", () => {
    const html = renderMarkdown("See [[note]] for details.", linkOpts);
    expect(html).toContain("See ");
    expect(html).toContain('data-target="note"');
    expect(html).toContain("for details.");
  });
  it("unclosed [[ is treated as literal text", () => {
    const html = renderMarkdown("[[not closed", linkOpts);
    expect(html).not.toContain('class="wiki-link"');
  });
  it("without extension, [[ is not parsed as wiki-link", () => {
    expect(renderMarkdown("[[note]]")).not.toContain('class="wiki-link"');
  });
});

describe("createWikiLinkExtension — serialize", () => {
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

  it("same display serializes as [[target]]", () => {
    expect(
      domToMarkdown(html('<p><a class="wiki-link" data-target="Note">Note</a></p>'), linkOpts),
    ).toBe("[[Note]]");
  });
  it("different display serializes as [[target|display]]", () => {
    expect(
      domToMarkdown(html('<p><a class="wiki-link" data-target="Note">display</a></p>'), linkOpts),
    ).toBe("[[Note|display]]");
  });
  it("regular anchor without data-target serializes as markdown link", () => {
    expect(domToMarkdown(html('<p><a href="http://x.com">x</a></p>'), linkOpts)).toBe(
      "[x](http://x.com)",
    );
  });
});

describe("createWikiLinkExtension — roundtrip", () => {
  let cleanup: () => void;
  let render: typeof renderMarkdown;
  let serialize: typeof domToMarkdown;

  function rt(md: string): string {
    const el = document.createElement("div");
    el.innerHTML = render(md, linkOpts);
    return serialize(el, linkOpts);
  }

  beforeAll(async () => {
    cleanup = setupDOM();
    render = (await import("../src/markdown.ts")).renderMarkdown;
    serialize = (await import("../src/serialize.ts")).domToMarkdown;
  });

  afterAll(() => {
    cleanup();
  });

  it("[[note]] roundtrips", () => {
    expect(rt("[[note]]")).toBe("[[note]]");
  });
  it("[[target|display]] roundtrips", () => {
    expect(rt("[[target|display]]")).toBe("[[target|display]]");
  });
  it("multiple wiki-links in one paragraph", () => {
    expect(rt("See [[a]] and [[b|B]].")).toBe("See [[a]] and [[b|B]].");
  });
});

describe("createWikiImageExtension — render", () => {
  it("renders an img tag", () => {
    expect(renderMarkdown("![[photo.webp]]", imageOpts)).toContain("<img");
  });
  it("sets data-wiki-image attribute", () => {
    expect(renderMarkdown("![[photo.webp]]", imageOpts)).toContain('data-wiki-image="photo.webp"');
  });
  it("resolveUrl callback determines src", () => {
    expect(renderMarkdown("![[photo.webp]]", imageOpts)).toContain('src="/files/photo.webp"');
  });
  it("alt matches image name", () => {
    expect(renderMarkdown("![[photo.webp]]", imageOpts)).toContain('alt="photo.webp"');
  });
  it("pipe syntax sets width attribute", () => {
    expect(renderMarkdown("![[photo.webp|300]]", imageOpts)).toContain('width="300"');
  });
  it("pipe non-numeric value does not set width", () => {
    expect(renderMarkdown("![[photo.webp|large]]", imageOpts)).not.toContain("width=");
  });
  it("without extension, ![[...]] is not parsed as wiki-image", () => {
    expect(renderMarkdown("![[photo.webp]]")).not.toContain("data-wiki-image");
  });
});

describe("createWikiImageExtension — serialize", () => {
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

  it("serializes back to ![[name]]", () => {
    expect(
      domToMarkdown(
        html('<p><img data-wiki-image="photo.webp" src="/files/photo.webp" alt="photo.webp"></p>'),
        imageOpts,
      ),
    ).toBe("![[photo.webp]]");
  });
  it("serializes width as pipe suffix", () => {
    expect(
      domToMarkdown(
        html(
          '<p><img data-wiki-image="photo.webp" src="/files/photo.webp" alt="photo.webp" width="300"></p>',
        ),
        imageOpts,
      ),
    ).toBe("![[photo.webp|300]]");
  });
  it("regular img without data-wiki-image serializes as ![alt](src)", () => {
    expect(domToMarkdown(html('<p><img src="photo.png" alt="desc"></p>'), imageOpts)).toBe(
      "![desc](photo.png)",
    );
  });
});

describe("createWikiImageExtension — roundtrip", () => {
  let cleanup: () => void;
  let render: typeof renderMarkdown;
  let serialize: typeof domToMarkdown;

  function rt(md: string): string {
    const el = document.createElement("div");
    el.innerHTML = render(md, imageOpts);
    return serialize(el, imageOpts);
  }

  beforeAll(async () => {
    cleanup = setupDOM();
    render = (await import("../src/markdown.ts")).renderMarkdown;
    serialize = (await import("../src/serialize.ts")).domToMarkdown;
  });

  afterAll(() => {
    cleanup();
  });

  it("![[photo.webp]] roundtrips", () => {
    expect(rt("![[photo.webp]]")).toBe("![[photo.webp]]");
  });
  it("![[photo.webp|300]] roundtrips", () => {
    expect(rt("![[photo.webp|300]]")).toBe("![[photo.webp|300]]");
  });
});

describe("createCalloutExtension — render", () => {
  it("renders callout div with type class", () => {
    expect(renderMarkdown("> [!warning] Heads up\n> Body text", calloutOpts)).toContain(
      'class="callout callout-warning"',
    );
  });
  it("renders data-callout attribute", () => {
    expect(renderMarkdown("> [!warning] Heads up\n> Body text", calloutOpts)).toContain(
      'data-callout="warning"',
    );
  });
  it("renders callout-title with custom title", () => {
    expect(renderMarkdown("> [!warning] Heads up\n> Body text", calloutOpts)).toContain("Heads up");
  });
  it("default title is capitalized type name", () => {
    expect(renderMarkdown("> [!note]\n> Body", calloutOpts)).toContain("Note");
  });
  it("renders callout-body with content", () => {
    expect(renderMarkdown("> [!info] Title\n> Body content", calloutOpts)).toContain(
      "Body content",
    );
  });
  it("callout without body has no callout-body div", () => {
    expect(renderMarkdown("> [!tip] Just a title", calloutOpts)).not.toContain("callout-body");
  });
  it("non-callout blockquote renders normally", () => {
    const html = renderMarkdown("> just a quote", calloutOpts);
    expect(html).toContain("<blockquote>");
    expect(html).not.toContain("callout");
  });
  it("without extension, callout syntax renders as plain blockquote", () => {
    const html = renderMarkdown("> [!warning] Heads up\n> Body");
    expect(html).toContain("<blockquote>");
    expect(html).not.toContain("callout");
  });
  it("custom icons override defaults", () => {
    const ext = createCalloutExtension({ icons: { note: "★" } });
    const html = renderMarkdown("> [!note]\n> Body", { extensions: [ext] });
    expect(html).toContain("★");
  });
});

describe("createCalloutExtension — serialize", () => {
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

  it("serializes callout type", () => {
    const calloutHtml = `<div class="callout callout-warning" data-callout="warning"><div class="callout-title">⚠️ Heads up</div><div class="callout-body"><p>Body text</p></div></div>`;
    expect(domToMarkdown(html(calloutHtml), calloutOpts)).toContain("> [!warning]");
  });
  it("serializes default title (type matches title, omit from output)", () => {
    const calloutHtml = `<div class="callout callout-note" data-callout="note"><div class="callout-title">📝 Note</div><div class="callout-body"><p>body</p></div></div>`;
    const md = domToMarkdown(html(calloutHtml), calloutOpts);
    expect(md).toContain("> [!note]");
    expect(md).not.toMatch(/\[!note\] Note/);
  });
  it("serializes custom title inline", () => {
    const calloutHtml = `<div class="callout callout-warning" data-callout="warning"><div class="callout-title">W Custom title</div><div class="callout-body"><p>body</p></div></div>`;
    expect(domToMarkdown(html(calloutHtml), calloutOpts)).toContain("> [!warning] Custom title");
  });
  it("serializes body lines with > prefix", () => {
    const calloutHtml = `<div class="callout callout-info" data-callout="info"><div class="callout-title">ℹ️ Info</div><div class="callout-body"><p>Some info</p></div></div>`;
    expect(domToMarkdown(html(calloutHtml), calloutOpts)).toContain("> Some info");
  });
});

describe("createCalloutExtension — roundtrip", () => {
  let cleanup: () => void;
  let render: typeof renderMarkdown;
  let serialize: typeof domToMarkdown;

  function rt(md: string): string {
    const el = document.createElement("div");
    el.innerHTML = render(md, calloutOpts);
    return serialize(el, calloutOpts);
  }

  beforeAll(async () => {
    cleanup = setupDOM();
    render = (await import("../src/markdown.ts")).renderMarkdown;
    serialize = (await import("../src/serialize.ts")).domToMarkdown;
  });

  afterAll(() => {
    cleanup();
  });

  it("callout with body roundtrips type", () => {
    expect(rt("> [!warning] Be careful\n> This is important")).toContain("[!warning]");
  });
  it("callout with body roundtrips title", () => {
    expect(rt("> [!warning] Be careful\n> This is important")).toContain("Be careful");
  });
  it("callout with body roundtrips body", () => {
    expect(rt("> [!warning] Be careful\n> This is important")).toContain("This is important");
  });
  it("callout default title roundtrips", () => {
    const rt2 = rt("> [!note]\n> Body here");
    expect(rt2).toContain("[!note]");
    expect(rt2).toContain("Body here");
  });
});

describe("all extensions together", () => {
  let cleanup: () => void;
  let render: typeof renderMarkdown;
  let serialize: typeof domToMarkdown;

  function rt(md: string): string {
    const el = document.createElement("div");
    el.innerHTML = render(md, allOpts);
    return serialize(el, allOpts);
  }

  beforeAll(async () => {
    cleanup = setupDOM();
    render = (await import("../src/markdown.ts")).renderMarkdown;
    serialize = (await import("../src/serialize.ts")).domToMarkdown;
  });

  afterAll(() => {
    cleanup();
  });

  it("wiki-link roundtrips with all extensions active", () => {
    expect(rt("[[my note]]")).toBe("[[my note]]");
  });
  it("wiki-image roundtrips with all extensions active", () => {
    expect(rt("![[photo.webp]]")).toBe("![[photo.webp]]");
  });
  it("callout roundtrips with all extensions active", () => {
    expect(rt("> [!note] Title\n> body")).toContain("[!note]");
  });
  it("standard markdown unaffected by extensions", () => {
    expect(rt("**bold** and *italic*")).toBe("**bold** and *italic*");
  });
  it("wiki-image inside callout body roundtrips", () => {
    const md = "> [!note] Gallery\n> ![[photo.webp]]";
    const result = rt(md);
    expect(result).toContain("[!note]");
    expect(result).toContain("![[photo.webp]]");
  });
});
