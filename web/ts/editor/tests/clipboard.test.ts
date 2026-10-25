import { describe, expect, it } from "vitest";

import { sanitizeHtmlToMarkdown } from "../clipboard.ts";

describe("HTML clipboard conversion", () => {
  it("removes executable elements, event handlers, and unsafe links", () => {
    expect(sanitizeHtmlToMarkdown(`
      <script>alert(1)</script>
      <style>.hidden { display: none }</style>
      <p onclick="run()" style="color:red" srcdoc="bad">Safe
        <a href="javascript:alert(1)">link</a>
        <img src="data:text/html,bad" alt="image">
      </p>
    `)).toBe("Safe\n        link\n        image");
  });

  it("converts common block, inline, list, table, and code markup", () => {
    const markdown = sanitizeHtmlToMarkdown(`
      <h1>Heading</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6>
      <p><b>bold</b> <strong>strong</strong> <i>italic</i> <em>emphasis</em> <s>strike</s> <del>delete</del></p>
      <div>first<br>second</div><section>section</section><article>article</article>
      <blockquote><p>quoted</p></blockquote>
      <ul><li>one</li><span>skip</span><li>two</li></ul>
      <ol><li>first</li><li>second</li></ol>
      <pre><code>one&#10;&#96;&#96;&#96;&#96;two</code></pre>
      <p><code>a&#96;b</code></p>
      <table><tr><th>A|B</th><th>C</th></tr><tr><td>one</td></tr></table>
      <hr>
    `);
    expect(markdown).toContain("# Heading\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six");
    expect(markdown).toContain("**bold** **strong** *italic* *emphasis* ~~strike~~ ~~delete~~");
    expect(markdown).toContain("first\nsecond\n\nsection\n\narticle");
    expect(markdown).toContain("> quoted");
    expect(markdown).toContain("- one\n- two");
    expect(markdown).toContain("1. first\n2. second");
    expect(markdown).toContain("`````\none\n````two\n`````\n\n");
    expect(markdown).toContain("`a\\`b`");
    expect(markdown).toMatch(/\| A\\\|B \| C \|\n\s*\| --- \| --- \|\n\s*\| one \| {2}\|\n\s*---/);
  });

  it("preserves safe URL forms and falls back to text when a target is removed", () => {
    const markdown = sanitizeHtmlToMarkdown(`
      <p>
        <a href="#heading">hash</a>
        <a href="/root">root</a>
        <a href="./relative">relative</a>
        <a href="../parent">parent</a>
        <a href="https://example.test">https</a>
        <a href="http://example.test">http</a>
        <a href="mailto:a@example.test">mail</a>
        <a href="tel:+123">phone</a>
        <a href="javascript:alert(1)">plain</a>
        <img src="/image.png" alt="safe image">
        <img src="javascript:alert(1)" alt="plain image">
      </p>
    `);
    expect(markdown).toContain("[hash](#heading)");
    expect(markdown).toContain("[root](/root)");
    expect(markdown).toContain("[relative](./relative)");
    expect(markdown).toContain("[parent](../parent)");
    expect(markdown).toContain("[https](https://example.test)");
    expect(markdown).toContain("[http](http://example.test)");
    expect(markdown).toContain("[mail](mailto:a@example.test)");
    expect(markdown).toContain("[phone](tel:+123)");
    expect(markdown).toContain("plain");
    expect(markdown).toContain("![safe image](/image.png)");
    expect(markdown).toContain("plain image");
  });
});
