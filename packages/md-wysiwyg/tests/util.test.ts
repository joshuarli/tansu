import { escapeHtml, stemFromPath } from "../src/util.ts";

describe("escapeHtml", () => {
  it("escapes ampersand", () => expect(escapeHtml("a&b")).toBe("a&amp;b"));
  it("escapes less-than", () => expect(escapeHtml("a<b")).toBe("a&lt;b"));
  it("escapes greater-than", () => expect(escapeHtml("a>b")).toBe("a&gt;b"));
  it("escapes double-quote", () => expect(escapeHtml('a"b')).toBe("a&quot;b"));
  it("leaves plain text unchanged", () => expect(escapeHtml("hello")).toBe("hello"));
  it("escapes multiple special chars", () =>
    expect(escapeHtml('<b class="x">foo & bar</b>')).toBe(
      "&lt;b class=&quot;x&quot;&gt;foo &amp; bar&lt;/b&gt;",
    ));
});

describe("stemFromPath", () => {
  it("strips .md extension", () => expect(stemFromPath("notes/foo.md")).toBe("foo"));
  it("strips .MD extension case-insensitively", () =>
    expect(stemFromPath("notes/foo.MD")).toBe("foo"));
  it("returns bare name when no directory", () => expect(stemFromPath("foo.md")).toBe("foo"));
  it("returns path as-is when no extension", () => expect(stemFromPath("foo")).toBe("foo"));
  it("handles multiple slashes", () => expect(stemFromPath("a/b/c/note.md")).toBe("note"));
});
