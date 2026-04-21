import { describe, test, expect } from "bun:test";

import { escapeHtml, relativeTime, stemFromPath } from "./util.ts";

describe("escapeHtml", () => {
  test("escape ampersand", () => {
    expect(escapeHtml("&")).toBe("&amp;");
  });
  test("escape lt", () => {
    expect(escapeHtml("<")).toBe("&lt;");
  });
  test("escape gt", () => {
    expect(escapeHtml(">")).toBe("&gt;");
  });
  test("escape quote", () => {
    expect(escapeHtml('"')).toBe("&quot;");
  });
  test("escape combined", () => {
    expect(escapeHtml('<script>"&"</script>')).toBe(
      "&lt;script&gt;&quot;&amp;&quot;&lt;/script&gt;",
    );
  });
  test("escape no-op", () => {
    expect(escapeHtml("hello")).toBe("hello");
  });
  test("escape empty", () => {
    expect(escapeHtml("")).toBe("");
  });
});

describe("stemFromPath", () => {
  test("stem basic", () => {
    expect(stemFromPath("notes/hello.md")).toBe("hello");
  });
  test("stem no dir", () => {
    expect(stemFromPath("hello.md")).toBe("hello");
  });
  test("stem deep", () => {
    expect(stemFromPath("deep/nested/path/note.md")).toBe("note");
  });
  test("stem case insensitive extension", () => {
    expect(stemFromPath("UPPER.MD")).toBe("UPPER");
  });
  test("stem no extension", () => {
    expect(stemFromPath("no-extension")).toBe("no-extension");
  });
  test("stem dots in name", () => {
    expect(stemFromPath("dots.in.name.md")).toBe("dots.in.name");
  });
});

describe("relativeTime", () => {
  // deterministic with explicit `now`
  const now = 1_700_000_000_000;
  test("time just now", () => {
    expect(relativeTime(now, now)).toBe("just now");
  });
  test("time 30s ago", () => {
    expect(relativeTime(now - 30_000, now)).toBe("just now");
  });
  test("time 2m ago", () => {
    expect(relativeTime(now - 120_000, now)).toBe("2m ago");
  });
  test("time 1h ago", () => {
    expect(relativeTime(now - 3600_000, now)).toBe("1h ago");
  });
  test("time 2h ago", () => {
    expect(relativeTime(now - 7200_000, now)).toBe("2h ago");
  });
  test("time 1d ago", () => {
    expect(relativeTime(now - 86400_000, now)).toBe("1d ago");
  });
  // >7 days returns locale date string — just check it's not "Xd ago"
  test("time >7d uses date", () => {
    const weekAgo = relativeTime(now - 700_000_000, now);
    expect(weekAgo.includes("d ago")).toBe(false);
  });
  // Still works without explicit now (backwards compat)
  test("default now works", () => {
    expect(typeof relativeTime(Date.now())).toBe("string");
  });
});
