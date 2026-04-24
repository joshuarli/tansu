import { escapeHtml, stemFromPath } from "@joshuarli98/md-wysiwyg";

import { relativeTime } from "./util.ts";

describe("escapeHtml", () => {
  it("escape ampersand", () => {
    expect(escapeHtml("&")).toBe("&amp;");
  });
  it("escape lt", () => {
    expect(escapeHtml("<")).toBe("&lt;");
  });
  it("escape gt", () => {
    expect(escapeHtml(">")).toBe("&gt;");
  });
  it("escape quote", () => {
    expect(escapeHtml('"')).toBe("&quot;");
  });
  it("escape combined", () => {
    expect(escapeHtml('<script>"&"</script>')).toBe(
      "&lt;script&gt;&quot;&amp;&quot;&lt;/script&gt;",
    );
  });
  it("escape no-op", () => {
    expect(escapeHtml("hello")).toBe("hello");
  });
  it("escape empty", () => {
    expect(escapeHtml("")).toBe("");
  });
});

describe("stemFromPath", () => {
  it("stem basic", () => {
    expect(stemFromPath("notes/hello.md")).toBe("hello");
  });
  it("stem no dir", () => {
    expect(stemFromPath("hello.md")).toBe("hello");
  });
  it("stem deep", () => {
    expect(stemFromPath("deep/nested/path/note.md")).toBe("note");
  });
  it("stem case insensitive extension", () => {
    expect(stemFromPath("UPPER.MD")).toBe("UPPER");
  });
  it("stem no extension", () => {
    expect(stemFromPath("no-extension")).toBe("no-extension");
  });
  it("stem dots in name", () => {
    expect(stemFromPath("dots.in.name.md")).toBe("dots.in.name");
  });
});

describe("relativeTime", () => {
  // deterministic with explicit `now`
  const now = 1_700_000_000_000;
  it("time just now", () => {
    expect(relativeTime(now, now)).toBe("just now");
  });
  it("time 30s ago", () => {
    expect(relativeTime(now - 30_000, now)).toBe("just now");
  });
  it("time 2m ago", () => {
    expect(relativeTime(now - 120_000, now)).toBe("2m ago");
  });
  it("time 1h ago", () => {
    expect(relativeTime(now - 3_600_000, now)).toBe("1h ago");
  });
  it("time 2h ago", () => {
    expect(relativeTime(now - 7_200_000, now)).toBe("2h ago");
  });
  it("time 1d ago", () => {
    expect(relativeTime(now - 86_400_000, now)).toBe("1d ago");
  });
  // >7 days returns locale date string — just check it's not "Xd ago"
  it("time >7d uses date", () => {
    const weekAgo = relativeTime(now - 700_000_000, now);
    expect(weekAgo).not.toContain("d ago");
  });
  // Still works without explicit now (backwards compat)
  it("default now works", () => {
    expectTypeOf(relativeTime(Date.now())).toBeString();
  });
});
