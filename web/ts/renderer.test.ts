/// Tests for renderer.ts helpers and an enforcement test that render functions
/// are only called from renderer.ts (not scattered across other source files).

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

describe("renderer invariants", () => {
  it("renderMarkdown/renderMarkdownWithCursor/renderMarkdownWithSelection only imported in renderer.ts", () => {
    const webTsDir = join(import.meta.dirname, ".");
    const files = readdirSync(webTsDir).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "renderer.ts",
    );

    const renderFnPattern =
      /\b(renderMarkdown|renderMarkdownWithCursor|renderMarkdownWithSelection)\b/;

    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(join(webTsDir, file), "utf8");
      if (renderFnPattern.test(content)) {
        violations.push(file);
      }
    }

    expect(violations).toStrictEqual([]);
  });
});
