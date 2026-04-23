import type { Page } from "playwright";
import { describe, test, expect, beforeAll, afterAll } from "vitest";

import { setup, teardown } from "./setup.ts";

describe("e2e: tabs", () => {
  let page: Page;
  let baseUrl: string;

  beforeAll(async () => {
    const ctx = await setup();
    page = ctx.page;
    baseUrl = ctx.baseUrl;

    await page.goto(baseUrl);
    await page.waitForSelector("#tab-bar", { timeout: 5000 });
  }, 30_000);

  afterAll(async () => {
    await teardown();
  });

  async function openNote(name: string) {
    await page.keyboard.press("Meta+k");
    await page.waitForSelector("#search-input", { timeout: 2000 });
    await page.fill("#search-input", name);
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    await page.waitForSelector(".editor-content", { timeout: 3000 });
    await page.waitForTimeout(200);
  }

  test("tab lifecycle: open, switch, dirty, close, empty state", async () => {
    // Open first note
    await openNote("test");
    let tabs = await page.$$eval(".tab:not(.tab-new)", (els) => els.length);
    expect(tabs).toBe(1);

    // Open second note
    await openNote("second");
    tabs = await page.$$eval(".tab:not(.tab-new)", (els) => els.length);
    expect(tabs).toBe(2);

    // Second tab should be active
    let activeText = await page.$eval(".tab.active", (el) => el.textContent);
    expect(activeText).toContain("second");

    // Click first tab to switch
    await page.locator(".tab:not(.tab-new)").first().click();
    await page.waitForTimeout(300);
    activeText = await page.$eval(".tab.active", (el) => el.textContent);
    expect(activeText).toContain("test");

    // Editor content updates on switch
    let html = await page.$eval(".editor-content", (el) => el.innerHTML);
    expect(html).toContain("Hello");

    // Reopen same note — should not create duplicate tab
    await openNote("test");
    tabs = await page.$$eval(".tab:not(.tab-new)", (els) => els.length);
    expect(tabs).toBe(2);

    // Dirty state
    await page.click(".editor-content");
    await page.keyboard.type("dirty edit");
    await page.waitForTimeout(200);
    expect(await page.isVisible(".tab.active .dirty")).toBe(true);

    // Save clears dirty
    await page.keyboard.press("Meta+s");
    await page.waitForTimeout(500);
    expect(await page.isVisible(".tab.active .dirty")).toBe(false);

    // + button opens new note via the custom input dialog
    const tabsBefore = await page.$$eval(".tab:not(.tab-new)", (els) => els.length);
    await page.click(".tab-new");
    await page.waitForSelector("#input-dialog-overlay:not(.hidden)", { timeout: 2000 });
    await page.fill("#input-dialog-input", "new-tab-note");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    const tabsAfter = await page.$$eval(".tab:not(.tab-new)", (els) => els.length);
    expect(tabsAfter).toBe(tabsBefore + 1);

    // Close tab via close button
    const beforeClose = await page.$$eval(".tab:not(.tab-new)", (els) => els.length);
    await page.locator(".tab:not(.tab-new) .close").last().click();
    await page.waitForTimeout(300);
    const afterClose = await page.$$eval(".tab:not(.tab-new)", (els) => els.length);
    expect(afterClose).toBe(beforeClose - 1);

    // Close all tabs → empty state
    while (true) {
      const count = await page.$$eval(".tab:not(.tab-new)", (els) => els.length);
      if (count === 0) break;
      await page.locator(".tab:not(.tab-new) .close").first().click();
      await page.waitForTimeout(200);
    }
    expect(await page.isVisible("#empty-state")).toBe(true);
  }, 30_000);
});
