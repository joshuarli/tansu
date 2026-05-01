import type { Page } from "playwright";

import { setup, teardown } from "./setup.ts";

describe("e2e: webkit regressions", () => {
  let page: Page;
  let baseUrl: string;

  beforeEach(async () => {
    const ctx = await setup({ browserName: "webkit" });
    ({ page } = ctx);
    ({ baseUrl } = ctx);
  }, 60_000);

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

  it("Enter after h1 preserves a single newline in source mode", async () => {
    await openTestNote();
    await setSource("# foo");

    await page.locator(".editor-content h1").click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("bar");

    await page.click(".editor-toolbar-btn--source");
    await expect(page.$eval(".editor-source", (el: HTMLTextAreaElement) => el.value)).resolves.toBe(
      "# foo\nbar",
    );
  }, 60_000);
});
