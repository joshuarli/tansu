import { describe, test, expect } from "vitest";

import { escapeHtml, stemFromPath } from "../src/util.ts";

describe("escapeHtml", () => {
  test("escapes ampersand", () => expect(escapeHtml("a&b")).toBe("a&amp;b"));
  test("escapes less-than", () => expect(escapeHtml("a<b")).toBe("a&lt;b"));
  test("escapes greater-than", () => expect(escapeHtml("a>b")).toBe("a&gt;b"));
  test("escapes double-quote", () => expect(escapeHtml('a"b')).toBe("a&quot;b"));
  test("leaves plain text unchanged", () => expect(escapeHtml("hello")).toBe("hello"));
  test("escapes multiple special chars", () =>
    expect(escapeHtml('<b class="x">foo & bar</b>')).toBe(
      "&lt;b class=&quot;x&quot;&gt;foo &amp; bar&lt;/b&gt;",
    ));
});

describe("stemFromPath", () => {
  test("strips .md extension", () => expect(stemFromPath("notes/foo.md")).toBe("foo"));
  test("strips .MD extension case-insensitively", () =>
    expect(stemFromPath("notes/foo.MD")).toBe("foo"));
  test("returns bare name when no directory", () => expect(stemFromPath("foo.md")).toBe("foo"));
  test("returns path as-is when no extension", () => expect(stemFromPath("foo")).toBe("foo"));
  test("handles multiple slashes", () => expect(stemFromPath("a/b/c/note.md")).toBe("note"));
});
