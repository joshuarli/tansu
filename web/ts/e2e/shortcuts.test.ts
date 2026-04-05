import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Page } from "playwright";
import { setup, teardown } from "./setup.ts";

describe("e2e: keyboard shortcuts", () => {
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

  test("Cmd+K opens search, Escape closes it", async () => {
    await page.keyboard.press("Meta+k");
    await page.waitForSelector("#search-overlay:not(.hidden)", { timeout: 2000 });
    expect(await page.isVisible("#search-overlay")).toBe(true);

    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    expect(await page.isHidden("#search-overlay")).toBe(true);
  });

  test("Cmd+K search, type, Enter opens note", async () => {
    await page.keyboard.press("Meta+k");
    await page.waitForSelector("#search-input", { timeout: 2000 });
    await page.fill("#search-input", "test");
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");

    await page.waitForSelector(".editor-content", { timeout: 3000 });
    const tabCount = await page.$$eval(".tab:not(.tab-new)", (els) => els.length);
    expect(tabCount).toBeGreaterThanOrEqual(1);
  });

  test("Cmd+T creates new note", async () => {
    // Mock the prompt dialog to return a note name
    await page.evaluate(() => {
      (window as any).__origPrompt = window.prompt;
      window.prompt = () => "shortcut-note";
    });

    const tabsBefore = await page.$$eval(".tab:not(.tab-new)", (els) => els.length);
    await page.keyboard.press("Meta+t");
    await page.waitForTimeout(500);

    const tabsAfter = await page.$$eval(".tab:not(.tab-new)", (els) => els.length);
    expect(tabsAfter).toBe(tabsBefore + 1);

    // Restore prompt
    await page.evaluate(() => {
      window.prompt = (window as any).__origPrompt;
    });
  });

  test("Cmd+W closes active tab", async () => {
    const tabsBefore = await page.$$eval(".tab:not(.tab-new)", (els) => els.length);
    expect(tabsBefore).toBeGreaterThanOrEqual(1);

    await page.keyboard.press("Meta+w");
    await page.waitForTimeout(300);

    const tabsAfter = await page.$$eval(".tab:not(.tab-new)", (els) => els.length);
    expect(tabsAfter).toBe(tabsBefore - 1);
  });

  test("Cmd+P opens command palette, Escape closes it", async () => {
    await page.keyboard.press("Meta+p");
    await page.waitForSelector("#palette-overlay:not(.hidden)", { timeout: 2000 });
    expect(await page.isVisible("#palette-overlay")).toBe(true);

    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    expect(await page.isHidden("#palette-overlay")).toBe(true);
  });
});
