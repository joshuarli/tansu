import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "playwright";

import { setup, teardown } from "./setup.ts";

const ACTIVE_TAB_DIRTY = '[data-ui="tab"][data-active="true"] [data-ui="tab-dirty"]';

describe("e2e: new file save regression", () => {
  let page: Page;
  let notesDir: string;
  let baseUrl: string;

  beforeEach(async () => {
    const ctx = await setup();
    ({ page, notesDir, baseUrl } = ctx);
    await page.goto(baseUrl);
    await page.waitForSelector("#tab-bar", { timeout: 5000 });
  }, 30_000);

  afterEach(async () => {
    await teardown();
  });

  it("new file: type foo, save, enter, type bar, save — both saves persist", async () => {
    // Create a new note via search
    await page.keyboard.press("Meta+k");
    await page.waitForSelector("#search-input", { timeout: 2000 });
    await page.fill("#search-input", "regression-test-note");
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    await page.waitForSelector(".editor-content", { timeout: 3000 });
    await page.waitForTimeout(200);

    await page.click(".editor-toolbar-btn--source");
    await page.waitForSelector(".editor-source", { state: "visible", timeout: 3000 });

    // Type "foo" in the body after the generated H1.
    await page.fill(".editor-source", "# regression-test-note\n\nfoo");
    await page.waitForSelector(ACTIVE_TAB_DIRTY, { timeout: 2000 });

    // First save
    await page.keyboard.press("Meta+s");
    await page.waitForTimeout(500);
    // Dirty indicator should be gone
    await expect(page.isVisible(ACTIVE_TAB_DIRTY)).resolves.toBeFalsy();

    // Verify file has the generated title and "foo"
    const filePath = join(notesDir, "regression-test-note.md");
    const after1 = readFileSync(filePath, "utf8");
    expect(after1).toBe("# regression-test-note\n\nfoo");

    // Add "bar" on the next line.
    await page.fill(".editor-source", "# regression-test-note\n\nfoo\nbar");
    await page.waitForSelector(ACTIVE_TAB_DIRTY, { timeout: 2000 });

    // Second save
    await page.keyboard.press("Meta+s");
    await page.waitForTimeout(500);
    await expect(page.isVisible(ACTIVE_TAB_DIRTY)).resolves.toBeFalsy();

    // Verify file has the generated title and "foo\nbar"
    const after2 = readFileSync(filePath, "utf8");
    expect(after2).toBe("# regression-test-note\n\nfoo\nbar");
  }, 30_000);
});
