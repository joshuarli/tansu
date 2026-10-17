import { describe, expect, it } from "vitest";
import { titleFromSource } from "./note-title.ts";

describe("titleFromSource", () => {
  it("uses the first non-empty line without heading, quote, or list markers", () => {
    expect(titleFromSource("\n\n## Plan for May\nbody")).toBe("Plan for May");
    expect(titleFromSource("- [ ] buy milk")).toBe("buy milk");
    expect(titleFromSource("> quoted")).toBe("quoted");
  });

  it("skips frontmatter", () => {
    expect(titleFromSource("---\ntags: [a]\n---\n# Real title")).toBe("Real title");
  });

  it("falls back to Untitled and caps the length", () => {
    expect(titleFromSource("  \n#  \n")).toBe("Untitled");
    expect(titleFromSource("x".repeat(200))).toHaveLength(80);
  });
});
