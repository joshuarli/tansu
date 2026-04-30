import type { Page, Response as PlaywrightResponse } from "playwright";

import { setup, teardown } from "./setup.ts";

describe("e2e: save deduplication", () => {
  let page: Page;
  let baseUrl: string;
  let pageErrors: Error[] = [];

  beforeAll(async () => {
    const ctx = await setup();
    ({ page } = ctx);
    ({ baseUrl } = ctx);
    pageErrors = [];
    page.on("pageerror", (error) => {
      pageErrors.push(error);
    });

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

  afterEach(() => {
    expect(pageErrors).toStrictEqual([]);
    pageErrors = [];
  });

  // Collect /api/note requests by method during a callback, then wait for cascading
  // requests to settle before returning. The settle window must be long enough for a
  // full SSE round-trip (file write → watcher event → drain → SSE broadcast → client
  // handler) to complete so we can assert it didn't happen.
  async function collectNoteRequests(
    fn: () => Promise<void>,
    settleMs = 1500,
  ): Promise<Record<string, number[]>> {
    const byMethod: Record<string, number[]> = {};
    const handler = (response: PlaywrightResponse) => {
      if (!response.url().includes("/api/note")) return;
      const method = response.request().method();
      (byMethod[method] ??= []).push(response.status());
    };
    page.on("response", handler);
    await fn();
    await page.waitForTimeout(settleMs);
    page.off("response", handler);
    return byMethod;
  }

  it("Cmd+S on unmodified note sends no requests", async () => {
    await page.click(".editor-content");
    const reqs = await collectNoteRequests(async () => {
      await page.keyboard.press("Meta+s");
    });
    expect(reqs["PUT"]).toBeUndefined();
    expect(reqs["GET"]).toBeUndefined();
  }, 15_000);

  it("Cmd+S on modified note sends exactly 1 PUT with no 409", async () => {
    await page.click(".editor-content");
    await page.keyboard.type(" edited");
    await page.waitForSelector(".tab.active .dirty", { timeout: 2000 });

    const reqs = await collectNoteRequests(async () => {
      await page.keyboard.press("Meta+s");
    });
    expect(reqs["PUT"]).toStrictEqual([200]);
    expect(reqs["GET"]).toBeUndefined();
  }, 15_000);

  it("saving twice in sequence sends no GET after either save", async () => {
    await page.click(".editor-content");
    await page.keyboard.type(" first");
    await page.waitForSelector(".tab.active .dirty", { timeout: 2000 });
    await page.keyboard.press("Meta+s");
    await page.waitForTimeout(200);

    await page.keyboard.type(" second");
    await page.waitForSelector(".tab.active .dirty", { timeout: 2000 });

    const reqs = await collectNoteRequests(async () => {
      await page.keyboard.press("Meta+s");
    });
    expect(reqs["PUT"]).toStrictEqual([200]);
    expect(reqs["GET"]).toBeUndefined();
  }, 15_000);
});
