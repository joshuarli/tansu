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

  it("element.innerHTML assignments are only in renderer.ts, bootstrap.ts, and filenav.tsx", () => {
    // Markdown HTML must only be injected via renderer.ts.
    // bootstrap.ts sets body.innerHTML for the unlock/unsupported-browser screens.
    // filenav.tsx sets innerHTML for the collapse-button glyph (not markdown).
    // format-toolbar.ts sets innerHTML for SVG toolbar icons (not markdown).
    // All other files must use renderer helpers or JSX innerHTML prop (which does not
    // match the "el.innerHTML =" DOM pattern).
    const allowList = new Set(["renderer.ts", "bootstrap.ts", "filenav.tsx", "format-toolbar.ts"]);
    const files = sourceFiles().filter((f) => !allowList.has(f));
    // Match DOM assignment "el.innerHTML =" but not JSX attribute "innerHTML={"
    const pattern = /[^{]\.innerHTML\s*=/;

    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(join(webTsDir, file), "utf8");
      if (pattern.test(content)) {
        violations.push(file);
      }
    }

    expect(violations).toStrictEqual([]);
  });

  it("converted SolidJS components do not query broad app-layout roots", () => {
    // SolidJS components should receive their DOM context via props or refs,
    // not by traversing fixed app-root IDs like #app or #editor-area.
    // main.tsx mounts the app and legitimately queries #app.
    // app.tsx owns the app lifecycle and queries #app for the unlock screen.
    // filenav.tsx accesses #app for the sidebar-collapse toggle.
    const allowList = new Set(["main.tsx", "app.tsx", "filenav.tsx"]);
    const tsxFiles = sourceFiles().filter((f) => f.endsWith(".tsx") && !allowList.has(f));
    const pattern = /document\.querySelector\s*\(\s*["'`]#(?:app|app-main|editor-area)["'`]/;

    const violations: string[] = [];
    for (const file of tsxFiles) {
      const content = readFileSync(join(webTsDir, file), "utf8");
      if (pattern.test(content)) {
        violations.push(file);
      }
    }

    expect(violations).toStrictEqual([]);
  });

  it("converted .tsx components have no module-level document/window.addEventListener", () => {
    // All DOM listeners in Solid components must live inside onMount/createEffect with onCleanup.
    // Module-level listeners are unowned and never cleaned up.
    const tsxFiles = sourceFiles().filter((f) => f.endsWith(".tsx") && f !== "main.tsx");
    // Matches top-level (unindented) addEventListener calls; indented ones are inside functions.
    const pattern = /^(?:document|window)\.addEventListener\b/m;

    const violations: string[] = [];
    for (const file of tsxFiles) {
      const content = readFileSync(join(webTsDir, file), "utf8");
      if (pattern.test(content)) {
        violations.push(file);
      }
    }

    expect(violations).toStrictEqual([]);
  });
});
