/// Tests for renderer.ts helpers and an enforcement test that render functions
/// are only called from renderer.ts (not scattered across other source files).

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const webTsDir = join(import.meta.dirname, ".");

function sourceFiles(): string[] {
  return readdirSync(webTsDir).filter(
    (f) =>
      (f.endsWith(".ts") || f.endsWith(".tsx")) &&
      !f.endsWith(".test.ts") &&
      !f.endsWith(".test.tsx"),
  );
}

describe("renderer invariants", () => {
  it("renderMarkdown/renderMarkdownWithCursor/renderMarkdownWithSelection only called from renderer.ts", () => {
    const files = sourceFiles().filter((f) => f !== "renderer.ts");
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

  it("no source file sets document.body.innerHTML (unsupported-page exception lives in bootstrap.ts)", () => {
    // bootstrap.ts owns the unsupported-browser page and the unlock screen — both are
    // intentional static HTML replacements. All other source files must not touch body.innerHTML.
    const files = sourceFiles().filter((f) => f !== "bootstrap.ts");
    const pattern = /\bdocument\.body\.innerHTML\b/;

    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(join(webTsDir, file), "utf8");
      if (pattern.test(content)) {
        violations.push(file);
      }
    }

    expect(violations).toStrictEqual([]);
  });
});
