import type { Page } from "playwright";
import { describe, test, expect, beforeAll, afterAll } from "vitest";

import { setup, teardown } from "./setup.ts";

describe("e2e: save deduplication", () => {
  let page: Page;
  let baseUrl: string;

  beforeAll(async () => {
    const ctx = await setup();
    page = ctx.page;
    baseUrl = ctx.baseUrl;

    // Open test.md
    await page.goto(baseUrl);
    await page.waitForSelector("#tab-bar", { timeout: 5000 });
    await page.keyboard.press("Meta+k");
    await page.waitForSelector("#search-input", { timeout: 2000 });
    await page.fill("#search-input", "test");
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    await page.waitForSelector(".editor-content", { timeout: 3000 });
  }, 30_000);

  afterAll(async () => {
    await teardown();
  });

  // Count PUT /api/note requests fired during a callback, waiting for them to settle.
  async function countPuts(
    fn: () => Promise<void>,
  ): Promise<{ count: number; statuses: number[] }> {
    const statuses: number[] = [];
    const handler = (response: import("playwright").Response) => {
      if (response.request().method() === "PUT" && response.url().includes("/api/note")) {
        statuses.push(response.status());
      }
    };
    page.on("response", handler);
    await fn();
    // Wait long enough for any concurrent/cascading requests to land.
    await page.waitForTimeout(800);
    page.off("response", handler);
    return { count: statuses.length, statuses };
  }

  test("Cmd+S on unmodified note sends exactly 1 PUT", async () => {
    await page.click(".editor-content");
    const { count, statuses } = await countPuts(async () => {
      await page.keyboard.press("Meta+s");
    });
    expect(count).toBe(1);
    expect(statuses).toEqual([200]);
  }, 15_000);

  test("Cmd+S on modified note sends exactly 1 PUT with no 409", async () => {
    await page.click(".editor-content");
    await page.keyboard.type(" edited");
    await page.waitForSelector(".tab.active .dirty", { timeout: 2000 });

    const { count, statuses } = await countPuts(async () => {
      await page.keyboard.press("Meta+s");
    });
    expect(count).toBe(1);
    expect(statuses).toEqual([200]);
  }, 15_000);
});
