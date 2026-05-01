import type { Page } from "playwright";

import { setup, teardown } from "./setup.ts";

describe("e2e: block transforms", () => {
  let page: Page;

  beforeEach(async () => {
    const ctx = await setup();
    ({ page } = ctx);

    // Open a note to get an editor
    await page.goto(ctx.baseUrl);
    await page.waitForSelector("#tab-bar", { timeout: 5000 });
    await page.keyboard.press("Meta+k");
    await page.waitForSelector("#search-input", { timeout: 2000 });
    await page.fill("#search-input", "test");
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    await page.waitForSelector(".editor-content", { timeout: 3000 });
  }, 30_000);

  afterEach(async () => {
    await teardown();
  });

  async function resetEditor(content: string) {
    await page.click(".editor-toolbar-btn--source");
    await page.fill(".editor-source", content);
    await page.click(".editor-toolbar-btn--source");
    await page.click(".editor-content");
  }

  it("heading transforms: ## + space creates H2", async () => {
    await resetEditor("");
    await page.keyboard.type("## ");
    await page.waitForTimeout(200);

    const hasH2 = await page.$eval(".editor-content", (el) => Boolean(el.querySelector("h2")));
    expect(hasH2).toBeTruthy();
  });

  it("heading transform: ### + space creates H3", async () => {
    await resetEditor("");
    await page.keyboard.type("### ");
    await page.waitForTimeout(200);

    const hasH3 = await page.$eval(".editor-content", (el) => Boolean(el.querySelector("h3")));
    expect(hasH3).toBeTruthy();
  });

  it("pressing Enter after a heading continues in plain text", async () => {
    await resetEditor("");
    await page.keyboard.type("## Heading");
    await page.keyboard.press("Enter");
    await page.keyboard.type("plain text");
    await page.click(".editor-toolbar-btn--source");

    const markdown = await page.inputValue(".editor-source");
    expect(markdown).toBe("## Heading\nplain text");
  });

  it("pressing Enter after an h1 continues with a single newline", async () => {
    await resetEditor("");
    await page.keyboard.type("# foo");
    await page.keyboard.press("Enter");
    await page.keyboard.type("bar");
    await page.click(".editor-toolbar-btn--source");

    const markdown = await page.inputValue(".editor-source");
    expect(markdown).toBe("# foo\nbar");
  });

  it("pressing Enter in a rendered h1 continues with a single newline", async () => {
    await resetEditor("# foo");
    await page.locator(".editor-content h1").click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("bar");
    await page.click(".editor-toolbar-btn--source");

    const markdown = await page.inputValue(".editor-source");
    expect(markdown).toBe("# foo\nbar");
  });

  it("unordered list: - + space creates UL", async () => {
    await resetEditor("");
    await page.keyboard.type("- ");
    await page.waitForTimeout(200);

    const hasUl = await page.$eval(".editor-content", (el) => Boolean(el.querySelector("ul")));
    expect(hasUl).toBeTruthy();
  });

  it("horizontal rule: --- creates HR", async () => {
    await resetEditor("some text\n");
    // Move to end and type on new line
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("---");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);

    const hasHr = await page.$eval(".editor-content", (el) => Boolean(el.querySelector("hr")));
    expect(hasHr).toBeTruthy();
  });

  it("blockquote: > + space creates BLOCKQUOTE", async () => {
    await resetEditor("");
    await page.keyboard.type("> ");
    await page.waitForTimeout(200);

    const hasBq = await page.$eval(".editor-content", (el) =>
      Boolean(el.querySelector("blockquote")),
    );
    expect(hasBq).toBeTruthy();
  });

  it("code block: ``` + Enter creates PRE>CODE", async () => {
    await resetEditor("");
    await page.keyboard.type("```");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);

    const hasPre = await page.$eval(".editor-content", (el) => Boolean(el.querySelector("pre")));
    expect(hasPre).toBeTruthy();
  });
});
