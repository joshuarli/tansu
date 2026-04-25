import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "playwright";

import { setup, teardown } from "./setup.ts";

describe("e2e: new file save regression", () => {
  let page: Page;
  let notesDir: string;
  let baseUrl: string;

  beforeAll(async () => {
    const ctx = await setup();
    ({ page, notesDir, baseUrl } = ctx);
    await page.goto(baseUrl);
    await page.waitForSelector("#tab-bar", { timeout: 5000 });
  }, 30_000);

  afterAll(async () => {
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

    // Type "foo"
    await page.click(".editor-content");
    await page.keyboard.type("foo");
    await page.waitForSelector(".tab.active .dirty", { timeout: 2000 });

    // First save
    await page.keyboard.press("Meta+s");
    await page.waitForTimeout(500);
    // Dirty indicator should be gone
    await expect(page.isVisible(".tab.active .dirty")).resolves.toBeFalsy();

    // Verify file has "foo"
    const filePath = join(notesDir, "regression-test-note.md");
    const after1 = readFileSync(filePath, "utf8");
    expect(after1).toBe("foo");

    // Press Enter, type "bar"
    await page.keyboard.press("Enter");
    await page.keyboard.type("bar");
    await page.waitForSelector(".tab.active .dirty", { timeout: 2000 });

    // Second save
    await page.keyboard.press("Meta+s");
    await page.waitForTimeout(500);
    await expect(page.isVisible(".tab.active .dirty")).resolves.toBeFalsy();

    // Verify file has "foo\nbar"
    const after2 = readFileSync(filePath, "utf8");
    expect(after2).toBe("foo\nbar");
  }, 30_000);
});
