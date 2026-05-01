import type { Page } from "playwright";

import { setup, teardown } from "./setup.ts";

const TAB = '[data-ui="tab"]';
const ACTIVE_TAB = '[data-ui="tab"][data-active="true"]';
const NEW_TAB = '[data-ui="tab-new"]';
const TAB_CLOSE = '[data-ui="tab-close"]';
const TAB_DIRTY = '[data-ui="tab-dirty"]';

describe("e2e: tabs", () => {
  let page: Page;
  let baseUrl: string;

  beforeEach(async () => {
    const ctx = await setup();
    ({ page } = ctx);
    ({ baseUrl } = ctx);

    await page.goto(baseUrl);
    await page.waitForSelector("#tab-bar", { timeout: 5000 });
  }, 30_000);

  afterEach(async () => {
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

  async function createNote(name: string) {
    await page.click(NEW_TAB);
    await page.waitForSelector("#input-dialog-overlay:not([hidden])", { timeout: 2000 });
    await page.fill("#input-dialog-input", name);
    await page.keyboard.press("Enter");
    await page.waitForSelector(".editor-content", { timeout: 3000 });
    await page.waitForTimeout(200);
  }

  it("tab lifecycle: open, switch, dirty, close, empty state", async () => {
    const initialTabs = await page.$$eval(TAB, (els) => els.length);

    // Open first note
    await openNote("test");
    let tabs = await page.$$eval(TAB, (els) => els.length);
    expect(tabs).toBe(initialTabs + 1);

    // Open second note
    await openNote("second");
    tabs = await page.$$eval(TAB, (els) => els.length);
    expect(tabs).toBe(initialTabs + 2);

    // Second tab should be active
    expect(
      await page
        .locator(TAB)
        .nth(initialTabs + 1)
        .evaluate((el) => (el as HTMLElement).dataset["active"] === "true"),
    ).toBeTruthy();

    // Click first tab to switch
    await page.locator(TAB).nth(initialTabs).click();
    await page.waitForTimeout(300);
    expect(
      await page
        .locator(TAB)
        .nth(initialTabs)
        .evaluate((el) => (el as HTMLElement).dataset["active"] === "true"),
    ).toBeTruthy();

    // Reopen same note — should not create duplicate tab
    await openNote("test");
    tabs = await page.$$eval(TAB, (els) => els.length);
    expect(tabs).toBe(initialTabs + 2);

    // Dirty state
    await page.click(".editor-content");
    await page.keyboard.type("dirty edit");
    await page.waitForTimeout(200);
    await expect(page.isVisible(`${ACTIVE_TAB} ${TAB_DIRTY}`)).resolves.toBeTruthy();

    // Save clears dirty
    await page.keyboard.press("Meta+s");
    await page.waitForTimeout(500);
    await expect(page.isVisible(`${ACTIVE_TAB} ${TAB_DIRTY}`)).resolves.toBeFalsy();

    // + button opens new note via the custom input dialog
    const tabsBefore = await page.$$eval(TAB, (els) => els.length);
    await page.click(NEW_TAB);
    await page.waitForSelector("#input-dialog-overlay:not([hidden])", { timeout: 2000 });
    await page.fill("#input-dialog-input", "new-tab-note");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    const tabsAfter = await page.$$eval(TAB, (els) => els.length);
    expect(tabsAfter).toBe(tabsBefore + 1);

    // Close tab via close button
    const beforeClose = await page.$$eval(TAB, (els) => els.length);
    await page.locator(TAB_CLOSE).last().click();
    await page.waitForTimeout(300);
    const afterClose = await page.$$eval(TAB, (els) => els.length);
    expect(afterClose).toBe(beforeClose - 1);

    // Close all tabs → empty state
    while (true) {
      const count = await page.$$eval(TAB, (els) => els.length);
      if (count === 0) {
        break;
      }
      await page.locator(TAB_CLOSE).first().click();
      await page.waitForTimeout(200);
    }
    await expect(page.isVisible("#empty-state")).resolves.toBeTruthy();
  }, 30_000);

  it("tabs shrink to a minimum width without clipping the close control", async () => {
    await page.setViewportSize({ width: 720, height: 900 });

    for (const name of [
      "very-long-tab-name-one",
      "very-long-tab-name-two",
      "very-long-tab-name-three",
      "very-long-tab-name-four",
      "very-long-tab-name-five",
      "very-long-tab-name-six",
    ]) {
      await createNote(name);
    }

    const tabBarMetrics = await page.locator("#tab-bar").evaluate((el) => ({
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
    }));
    expect(tabBarMetrics.scrollWidth).toBeGreaterThan(tabBarMetrics.clientWidth);

    const tabCount = await page.$$eval(TAB, (els) => els.length);
    for (let i = 0; i < tabCount; i++) {
      const tab = page.locator(TAB).nth(i);
      const close = tab.locator(TAB_CLOSE);
      const [tabBox, closeBox] = await Promise.all([tab.boundingBox(), close.boundingBox()]);
      expect(tabBox).not.toBeNull();
      expect(closeBox).not.toBeNull();
      expect(closeBox!.x).toBeGreaterThanOrEqual(tabBox!.x - 1);
      expect(closeBox!.x + closeBox!.width).toBeLessThanOrEqual(tabBox!.x + tabBox!.width + 1);
    }
  }, 60_000);
});
