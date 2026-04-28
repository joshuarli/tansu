/// Enforcement tests that markdown rendering and innerHTML assignments are
/// kept out of web/ts source files (all such work lives inside packages/md-wysiwyg).

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
  it("renderMarkdown/renderMarkdownWithCursor/renderMarkdownWithSelection not called from web/ts source files", () => {
    const files = sourceFiles();
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
    // bootstrap.ts owns the unsupported-browser page. All other source files
    // must not touch body.innerHTML.
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

  it("element.innerHTML assignments are only in bootstrap.ts and format-toolbar.ts", () => {
    // Markdown HTML is injected only by packages/md-wysiwyg (editor.ts); web/ts must not
    // assign .innerHTML directly except for the listed cases:
    // bootstrap.ts sets body.innerHTML for the unsupported-browser screen.
    // format-toolbar.ts sets innerHTML for SVG toolbar icons (not markdown).
    // All other files must use JSX innerHTML prop (which does not match "el.innerHTML =" pattern).
    const allowList = new Set(["bootstrap.ts", "format-toolbar.ts"]);
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
    const allowList = new Set(["main.tsx"]);
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

  it("source files do not discover controller root mounts by fixed IDs", () => {
    // App owns these roots and passes the elements down explicitly.
    const files = sourceFiles().filter((f) => f !== "main.tsx");
    const pattern =
      /document\.querySelector\s*\(\s*["'`]#(?:search-root|settings-root|palette-root|input-dialog-overlay|sidebar-tree|vault-switcher|sidebar-search|sidebar-collapse)["'`]/;

    const violations: string[] = [];
    for (const file of files) {
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
