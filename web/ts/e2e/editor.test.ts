import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "playwright";

import { setup, teardown } from "./setup.ts";

describe("e2e: editor", () => {
  let page: Page;
  let baseUrl: string;
  let notesDir: string;
  const defaultNote = "# Hello\n\nThis is a test note.";

  beforeEach(async () => {
    const ctx = await setup();
    ({ page } = ctx);
    ({ baseUrl } = ctx);
    ({ notesDir } = ctx);
    writeFileSync(join(notesDir, "test.md"), defaultNote);
    const stateRes = await fetch(`${baseUrl}/api/state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tabs: ["test.md"], active: 0, closed: [], cursors: {} }),
    });
    if (!stateRes.ok) {
      throw new Error(`failed to seed editor test state: ${stateRes.status}`);
    }
    await page.goto(baseUrl);
    await page.waitForSelector(".editor-content", { timeout: 3000 });
  });

  afterEach(async () => {
    await teardown();
  });

  async function resetEditor(content: string) {
    await page.click(".editor-toolbar-btn--source");
    await page.waitForSelector(".editor-source", { state: "visible", timeout: 3000 });
    await page.waitForSelector(".editor-content", { state: "hidden", timeout: 3000 });
    await page.fill(".editor-source", content);
    await page.click(".editor-toolbar-btn--source");
    await page.waitForSelector(".editor-content", { state: "visible", timeout: 3000 });
    await page.waitForSelector(".editor-source", { state: "hidden", timeout: 3000 });
    await page.click(".editor-content");
  }

  it("opens note, renders, source toggle, edit, save, transforms", async () => {
    // Renders markdown
    const html = await page.$eval(".editor-content", (el) => el.innerHTML);
    expect(html).toContain("<h1>Hello</h1>");
    expect(html).toContain("This is a test note.");

    // contentEditable
    const editable = await page.$eval(
      ".editor-content",
      (el) => (el as HTMLElement).contentEditable,
    );
    expect(editable).toBe("true");

    // Source mode toggle
    await page.click(".editor-toolbar-btn--source");
    await page.waitForSelector(".editor-source", { state: "visible", timeout: 3000 });
    const srcValue = await page.$eval(".editor-source", (el: HTMLTextAreaElement) => el.value);
    expect(srcValue).toContain("# Hello");

    // Toggle back
    await page.click(".editor-toolbar-btn--source");
    await page.waitForSelector(".editor-content", { state: "visible", timeout: 3000 });
    await page.waitForSelector(".editor-source", { state: "hidden", timeout: 3000 });

    // Typing marks dirty
    await page.click(".editor-content");
    await page.keyboard.type("new text");
    await page.waitForSelector(".tab.active .dirty", { timeout: 2000 });
    await expect(page.isVisible(".tab.active .dirty")).resolves.toBeTruthy();

    // Cmd+S saves and clears dirty
    await page.keyboard.press("Meta+s");
    await page.waitForTimeout(500);
    await expect(page.isVisible(".tab.active .dirty")).resolves.toBeFalsy();

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
    expect(hasCode).toBeTruthy();

    // Cmd+B toggles bold
    await resetEditor("plain text");
    await page.keyboard.press("Meta+a");
    await page.keyboard.press("Meta+b");
    const bHtml = await page.$eval(".editor-content", (el) => el.innerHTML);
    expect(bHtml).toContain("<strong>");

    // Cmd+I toggles italic
    await resetEditor("plain text");
    await page.keyboard.press("Meta+a");
    await page.keyboard.press("Meta+i");
    const iHtml = await page.$eval(".editor-content", (el) => el.innerHTML);
    expect(iHtml).toContain("<em>");

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

  async function saveAndGetSource(): Promise<string> {
    await page.keyboard.press("Meta+s");
    await page.waitForTimeout(300);
    await page.click(".editor-toolbar-btn--source");
    await page.waitForSelector(".editor-source", { state: "visible", timeout: 3000 });
    const src = await page.$eval(".editor-source", (el: HTMLTextAreaElement) => el.value);
    // Toggle back to content mode for subsequent tests
    await page.click(".editor-toolbar-btn--source");
    await page.waitForSelector(".editor-source", { state: "hidden", timeout: 3000 });
    await page.waitForSelector(".editor-content", { state: "visible", timeout: 3000 });
    return src;
  }

  it(
    String.raw`single Enter produces \n in saved markdown`,
    async () => {
      await resetEditor("");
      await page.keyboard.type("foo");
      await page.keyboard.press("Enter");
      await page.keyboard.type("bar");
      const src = await saveAndGetSource();
      expect(src).toBe("foo\nbar");
    },
    15_000,
  );

  it(
    String.raw`double Enter produces \n\n in saved markdown`,
    async () => {
      await resetEditor("");
      await page.keyboard.type("foo");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      await page.keyboard.type("bar");
      const src = await saveAndGetSource();
      expect(src).toBe("foo\n\nbar");
    },
    15_000,
  );

  it("three lines separated by single Enter", async () => {
    await resetEditor("");
    await page.keyboard.type("a");
    await page.keyboard.press("Enter");
    await page.keyboard.type("b");
    await page.keyboard.press("Enter");
    await page.keyboard.type("c");
    const src = await saveAndGetSource();
    expect(src).toBe("a\nb\nc");
  }, 15_000);

  it("inline bold transform roundtrips as **bold**", async () => {
    await resetEditor("");
    await page.keyboard.type("**bold**");
    await page.waitForTimeout(200);
    const src = await saveAndGetSource();
    expect(src).toBe("**bold**");
  }, 15_000);

  it("inline italic transform roundtrips as *italic*", async () => {
    await resetEditor("");
    await page.keyboard.type("*italic*");
    await page.waitForTimeout(200);
    const src = await saveAndGetSource();
    expect(src).toBe("*italic*");
  }, 15_000);

  it("inline code transform roundtrips as `code`", async () => {
    await resetEditor("");
    await page.keyboard.type("`code` ");
    await page.waitForTimeout(200);
    const src = await saveAndGetSource();
    // Trailing space from trigger is not preserved
    expect(src.trim()).toBe("`code`");
  }, 15_000);

  it("bold on a line followed by Enter stays on one line", async () => {
    await resetEditor("");
    await page.keyboard.type("**bold**");
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    await page.keyboard.type("next");
    const src = await saveAndGetSource();
    expect(src).toBe("**bold**\nnext");
  }, 15_000);
});
