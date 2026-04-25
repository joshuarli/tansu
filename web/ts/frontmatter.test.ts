import { buildFrontmatter, splitFrontmatter, withFrontmatter } from "./frontmatter.ts";

describe("frontmatter", () => {
  it("splits tags frontmatter from the body", () => {
    const parsed = splitFrontmatter("---\ntags: [Alpha, beta]\n---\n\n# Title");
    expect(parsed.hasFrontmatter).toBeTruthy();
    expect(parsed.tags).toStrictEqual(["alpha", "beta"]);
    expect(parsed.body).toBe("# Title");
  });

  it("returns the input when no frontmatter is present", () => {
    const parsed = splitFrontmatter("# Title\n\nBody");
    expect(parsed.hasFrontmatter).toBeFalsy();
    expect(parsed.tags).toStrictEqual([]);
    expect(parsed.body).toBe("# Title\n\nBody");
  });

  it("builds and prepends frontmatter when tags exist", () => {
    expect(buildFrontmatter(["alpha", "beta"])).toBe("---\ntags: [alpha, beta]\n---\n\n");
    expect(withFrontmatter("# Title", ["alpha"])).toBe("---\ntags: [alpha]\n---\n\n# Title");
  });
});
