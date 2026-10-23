import { describe, expect, it } from "vitest";
import { readNoteTags } from "../tags.js";

describe("note tag parsing", () => {
  it("reads scalar, inline-list, block-list, and BOM-prefixed tags", () => {
    expect(readNoteTags("---\ntags: alpha, beta\n---\n")).toStrictEqual(["alpha", "beta"]);
    expect(readNoteTags("---\ntags: [one, two]\n---\n")).toStrictEqual(["one", "two"]);
    expect(readNoteTags("---\ntags: [[alpha]]\n---\n")).toStrictEqual(["alpha"]);
    expect(readNoteTags("---\ntags: ['\"alpha\"']\n---\n")).toStrictEqual(['"alpha"']);
    expect(readNoteTags("\uFEFF---\ntags:\n  - 'alpha'\n  - \"beta\"\n---\n")).toStrictEqual([
      "alpha",
      "beta",
    ]);
  });

  it("reads tags alongside unrelated fields and returns no tags for malformed frontmatter", () => {
    expect(readNoteTags("---\nauthor: Jane\ntags: [alpha]\n---\nbody\n")).toStrictEqual(["alpha"]);
    expect(readNoteTags("---\ntags: [alpha]\n# Body\n")).toStrictEqual([]);
    expect(readNoteTags("---\ntags: [alpha]\ntags: [beta]\n---\n")).toStrictEqual([]);
    expect(readNoteTags("---\ntags: [alpha\n---\n")).toStrictEqual([]);
  });

  it("returns an empty list when the source has no frontmatter", () => {
    expect(readNoteTags("# Body\n")).toStrictEqual([]);
  });
});
