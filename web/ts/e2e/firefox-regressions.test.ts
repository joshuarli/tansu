import type { Page } from "playwright";

import { setup, teardown } from "./setup.ts";

describe("e2e: firefox regressions", () => {
  let page: Page;
  let baseUrl: string;

  beforeEach(async () => {
    const ctx = await setup({ browserName: "firefox" });
    ({ page } = ctx);
    ({ baseUrl } = ctx);
  }, 30_000);

  afterEach(async () => {
    await teardown();
  });

  async function openTestNote() {
    await page.goto(baseUrl);
    await page.waitForSelector("#tab-bar", { timeout: 5000 });
    await page.keyboard.press("Meta+k");
    await page.waitForSelector("#search-input", { timeout: 2000 });
    await page.fill("#search-input", "test");
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    await page.waitForSelector(".editor-content", { timeout: 3000 });
  }

  async function setSource(content: string) {
    await page.click(".editor-toolbar-btn--source");
    await page.fill(".editor-source", content);
    await page.click(".editor-toolbar-btn--source");
    await page.waitForTimeout(100);
  }

  it("Backspace on empty nested bullet preserves markdown through autosave and reload", async () => {
    await openTestNote();
    await setSource("- one\n- two");

    // Indent second item, delete its text, then backspace again on the empty nested bullet.
    await page.evaluate(() => {
      const items = document.querySelectorAll(".editor-content li");
      const text = items[1]!.firstChild!;
      const sel = window.getSelection()!;
      const range = document.createRange();
      range.setStart(text, text.textContent!.length);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.keyboard.press("Tab");
    await page.evaluate(() => {
      const items = document.querySelectorAll(".editor-content li");
      const nested = items[1]!.firstChild!;
      const sel = window.getSelection()!;
      const range = document.createRange();
      range.setStart(nested, nested.textContent!.length);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(2000); // autosave debounce

    await page.click(".editor-toolbar-btn--source");
    await expect(page.$eval(".editor-source", (el: HTMLTextAreaElement) => el.value)).resolves.toBe(
      "- one\n  - ",
    );
    await page.click(".editor-toolbar-btn--source");

    await page.reload({ waitUntil: "load" });
    await page.waitForSelector(".editor-content", { timeout: 3000 });
    await page.click(".editor-toolbar-btn--source");
    await expect(page.$eval(".editor-source", (el: HTMLTextAreaElement) => el.value)).resolves.toBe(
      "- one\n  - ",
    );
  }, 30_000);

  it("Backspace on empty top-level bullet preserves list structure through autosave and reload", async () => {
    await openTestNote();
    await setSource("- a\n- b");

    await page.evaluate(() => {
      const items = document.querySelectorAll(".editor-content li");
      const text = items[1]!.firstChild!;
      const sel = window.getSelection()!;
      const range = document.createRange();
      range.setStart(text, text.textContent!.length);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.keyboard.press("Backspace");
    await page.evaluate(() => {
      const items = document.querySelectorAll(".editor-content li");
      const empty = items[1]!;
      const sel = window.getSelection()!;
      const range = document.createRange();
      range.setStart(empty, 0);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(2000);

    await page.click(".editor-toolbar-btn--source");
    await expect(page.$eval(".editor-source", (el: HTMLTextAreaElement) => el.value)).resolves.toBe(
      "- a",
    );
    await page.click(".editor-toolbar-btn--source");

    await page.reload({ waitUntil: "load" });
    await page.waitForSelector(".editor-content", { timeout: 3000 });
    await page.click(".editor-toolbar-btn--source");
    await expect(page.$eval(".editor-source", (el: HTMLTextAreaElement) => el.value)).resolves.toBe(
      "- a",
    );
  }, 30_000);

  it("autosave preserves repeated and edge blank lines", async () => {
    await openTestNote();

    const source = "\nline1\n\n\nline2\n";
    await setSource(source);
    await page.waitForTimeout(2000);

    await page.click(".editor-toolbar-btn--source");
    await expect(page.$eval(".editor-source", (el: HTMLTextAreaElement) => el.value)).resolves.toBe(
      source,
    );
    await page.click(".editor-toolbar-btn--source");

    await page.reload({ waitUntil: "load" });
    await page.waitForSelector(".editor-content", { timeout: 3000 });
    await page.click(".editor-toolbar-btn--source");
    await expect(page.$eval(".editor-source", (el: HTMLTextAreaElement) => el.value)).resolves.toBe(
      source,
    );
  }, 30_000);

  it("autosave preserves a tight paragraph-list boundary", async () => {
    await openTestNote();

    const source = "foo:\n- one";
    await setSource(source);
    await page.waitForTimeout(2000);

    await page.click(".editor-toolbar-btn--source");
    await expect(page.$eval(".editor-source", (el: HTMLTextAreaElement) => el.value)).resolves.toBe(
      source,
    );
    await page.click(".editor-toolbar-btn--source");

    await page.reload({ waitUntil: "load" });
    await page.waitForSelector(".editor-content", { timeout: 3000 });
    await page.click(".editor-toolbar-btn--source");
    await expect(page.$eval(".editor-source", (el: HTMLTextAreaElement) => el.value)).resolves.toBe(
      source,
    );
  }, 30_000);

  it("autosave preserves a tight empty-list-item paragraph boundary", async () => {
    await openTestNote();

    const source = "foo:\n- one\n- \ndsf";
    await setSource(source);
    await page.waitForTimeout(2000);

    await page.click(".editor-toolbar-btn--source");
    await expect(page.$eval(".editor-source", (el: HTMLTextAreaElement) => el.value)).resolves.toBe(
      source,
    );
    await page.click(".editor-toolbar-btn--source");

    await page.reload({ waitUntil: "load" });
    await page.waitForSelector(".editor-content", { timeout: 3000 });
    await page.click(".editor-toolbar-btn--source");
    await expect(page.$eval(".editor-source", (el: HTMLTextAreaElement) => el.value)).resolves.toBe(
      source,
    );
  }, 30_000);

  it("reload replaces the SSE connection instead of returning 409", async () => {
    const eventStatuses: number[] = [];
    page.on("response", (response) => {
      if (response.url().includes("/events")) {
        eventStatuses.push(response.status());
      }
    });

    await page.goto(baseUrl);
    await page.waitForSelector("#tab-bar", { timeout: 5000 });
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(1000);

    expect(eventStatuses.every((status) => status === 200)).toBeTruthy();
  }, 20_000);
});
