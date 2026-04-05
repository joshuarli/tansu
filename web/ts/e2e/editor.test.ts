import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Page } from "playwright";
import { setup, teardown } from "./setup.ts";

describe("e2e: editor", () => {
  let page: Page;
  let baseUrl: string;

  beforeAll(async () => {
    const ctx = await setup();
    page = ctx.page;
    baseUrl = ctx.baseUrl;
  }, 30_000);

  afterAll(async () => {
    await teardown();
  });

  async function resetEditor(content: string) {
    await page.click("button:has-text('Source')");
    await page.fill(".editor-source", content);
    await page.click("button:has-text('Source')");
    await page.click(".editor-content");
  }

  test("opens note, renders, source toggle, edit, save, transforms", async () => {
    await page.goto(baseUrl);
    await page.waitForSelector("#tab-bar", { timeout: 5000 });

    // Open test.md via search
    await page.keyboard.press("Meta+k");
    await page.waitForSelector("#search-input", { timeout: 2000 });
    await page.fill("#search-input", "test");
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    await page.waitForSelector(".editor-content", { timeout: 3000 });

    // Renders markdown
    const html = await page.$eval(".editor-content", (el) => el.innerHTML);
    expect(html).toContain("<h1>Hello</h1>");
    expect(html).toContain("This is a test note.");

    // contentEditable
    const editable = await page.$eval(".editor-content", (el) => (el as HTMLElement).contentEditable);
    expect(editable).toBe("true");

    // Source mode toggle
    await page.click("button:has-text('Source')");
    expect(await page.isVisible(".editor-source")).toBe(true);
    const srcValue = await page.$eval(".editor-source", (el: HTMLTextAreaElement) => el.value);
    expect(srcValue).toContain("# Hello");

    // Toggle back
    await page.click("button:has-text('Source')");
    expect(await page.isVisible(".editor-content")).toBe(true);
    expect(await page.isHidden(".editor-source")).toBe(true);

    // Typing marks dirty
    await page.click(".editor-content");
    await page.keyboard.type("new text");
    await page.waitForSelector(".tab.active .dirty", { timeout: 2000 });
    expect(await page.isVisible(".tab.active .dirty")).toBe(true);

    // Cmd+S saves and clears dirty
    await page.keyboard.press("Meta+s");
    await page.waitForTimeout(500);
    expect(await page.isVisible(".tab.active .dirty")).toBe(false);

    // Inline bold transform: **text** → <strong>
    await resetEditor("");
    await page.keyboard.type("**bold**");
    await page.waitForTimeout(200);
    const boldHtml = await page.$eval(".editor-content", (el) => el.innerHTML);
    expect(boldHtml).toContain("<strong>");

    // Inline code transform: `code` + space → <code>
    await resetEditor("");
    await page.keyboard.type("`code` ");
    await page.waitForTimeout(200);
    const codeHtml = await page.$eval(".editor-content", (el) => el.innerHTML);
    // Chrome may render <code> as inline styles (monospace font-family)
    const hasCode = codeHtml.includes("<code>") || codeHtml.includes("monospace");
    expect(hasCode).toBe(true);

    // Cmd+B toggles bold
    await resetEditor("plain text");
    await page.keyboard.press("Meta+a");
    await page.keyboard.press("Meta+b");
    const bHtml = await page.$eval(".editor-content", (el) => el.innerHTML);
    expect(bHtml).toContain("<b>");

    // Cmd+I toggles italic
    await resetEditor("plain text");
    await page.keyboard.press("Meta+a");
    await page.keyboard.press("Meta+i");
    const iHtml = await page.$eval(".editor-content", (el) => el.innerHTML);
    expect(iHtml).toContain("<i>");

    // Paste plain text
    await resetEditor("");
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData("text/plain", "pasted content");
      const event = new ClipboardEvent("paste", {
        clipboardData: dt,
        cancelable: true,
        bubbles: true,
      });
      document.querySelector(".editor-content")!.dispatchEvent(event);
    });
    await page.waitForTimeout(200);
    const pasteText = await page.$eval(".editor-content", (el) => el.textContent);
    expect(pasteText).toContain("pasted content");
  }, 30_000);
});
