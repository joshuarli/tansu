import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setupDOM, mockFetch } from "./test-helper.ts";

describe("transforms", () => {
  let cleanup: () => void;
  let mock: ReturnType<typeof mockFetch>;
  let handleBlockTransform: (event: KeyboardEvent, contentEl: HTMLElement, path: string) => void;
  let checkBlockInputTransform: (contentEl: HTMLElement) => boolean;

  function makeContentEl(): HTMLElement {
    const el = document.createElement("div");
    el.className = "editor-content";
    el.contentEditable = "true";
    document.body.appendChild(el);
    return el;
  }

  function simulateTransform(contentEl: HTMLElement, text: string): { prevented: boolean } {
    const p = document.createElement("p");
    p.textContent = text;
    contentEl.appendChild(p);

    // Place cursor inside the paragraph
    const range = document.createRange();
    const textNode = p.firstChild ?? p;
    range.setStart(textNode, text.length);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    let prevented = false;
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    Object.defineProperty(event, "preventDefault", {
      value: () => {
        prevented = true;
      },
    });
    handleBlockTransform(event, contentEl, "test.md");
    return { prevented };
  }

  function simulateInputTransform(contentEl: HTMLElement, text: string): boolean {
    const p = document.createElement("p");
    p.textContent = text;
    contentEl.appendChild(p);

    const range = document.createRange();
    const textNode = p.firstChild ?? p;
    range.setStart(textNode, text.length);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    return checkBlockInputTransform(contentEl);
  }

  beforeAll(async () => {
    cleanup = setupDOM();
    mock = mockFetch();

    // tabs.ts needs API mocks at import time
    mock.on("PUT", "/api/state", {});
    mock.on("GET", "/api/state", { tabs: [], active: -1 });

    const mod = await import("./transforms.ts");
    handleBlockTransform = mod.handleBlockTransform;
    checkBlockInputTransform = mod.checkBlockInputTransform;
  });

  afterAll(() => {
    mock.restore();
    cleanup();
  });

  test("heading prevented default", () => {
    const el = makeContentEl();
    const { prevented } = simulateTransform(el, "## Hello");
    expect(prevented).toBe(true);
    el.remove();
  });

  test("h2 created", () => {
    const el = makeContentEl();
    simulateTransform(el, "## Hello");
    const h2 = el.querySelector("h2");
    expect(h2 !== null).toBe(true);
    expect(h2!.textContent).toBe("Hello");
    // Paragraph added after heading
    const p = h2!.nextElementSibling;
    expect(p !== null && p.tagName === "P").toBe(true);
    el.remove();
  });

  test("hr prevented default", () => {
    const el = makeContentEl();
    const { prevented } = simulateTransform(el, "---");
    expect(prevented).toBe(true);
    expect(el.querySelector("hr") !== null).toBe(true);
    el.remove();
  });

  test("code prevented default", () => {
    const el = makeContentEl();
    const { prevented } = simulateTransform(el, "```js");
    expect(prevented).toBe(true);
    const pre = el.querySelector("pre");
    expect(pre !== null).toBe(true);
    const code = pre!.querySelector("code");
    expect(code !== null).toBe(true);
    expect(code!.className).toBe("language-js");
    el.remove();
  });

  test("ul prevented default", () => {
    const el = makeContentEl();
    const { prevented } = simulateTransform(el, "- item");
    expect(prevented).toBe(true);
    const ul = el.querySelector("ul");
    expect(ul !== null).toBe(true);
    const li = ul!.querySelector("li");
    expect(li!.textContent).toBe("item");
    el.remove();
  });

  test("ol prevented default", () => {
    const el = makeContentEl();
    const { prevented } = simulateTransform(el, "1. first");
    expect(prevented).toBe(true);
    const ol = el.querySelector("ol");
    expect(ol !== null).toBe(true);
    expect(ol!.querySelector("li")!.textContent).toBe("first");
    el.remove();
  });

  test("bq prevented default", () => {
    const el = makeContentEl();
    const { prevented } = simulateTransform(el, "> quoted");
    expect(prevented).toBe(true);
    const bq = el.querySelector("blockquote");
    expect(bq !== null).toBe(true);
    expect(bq!.querySelector("p")!.textContent).toBe("quoted");
    el.remove();
  });

  test("normal text not prevented", () => {
    const el = makeContentEl();
    const { prevented } = simulateTransform(el, "just text");
    expect(prevented).toBe(false);
    el.remove();
  });

  test("h2 input transform", () => {
    const el = makeContentEl();
    expect(simulateInputTransform(el, "## ")).toBe(true);
    const h2 = el.querySelector("h2");
    expect(h2 !== null).toBe(true);
    expect(h2!.innerHTML).toBe("<br>");
    el.remove();
  });

  test("h2 nbsp input transform", () => {
    const el = makeContentEl();
    expect(simulateInputTransform(el, "##\u00A0")).toBe(true);
    expect(el.querySelector("h2") !== null).toBe(true);
    el.remove();
  });

  test("h1 input transform", () => {
    const el = makeContentEl();
    expect(simulateInputTransform(el, "# ")).toBe(true);
    expect(el.querySelector("h1") !== null).toBe(true);
    el.remove();
  });

  test("h3 input transform", () => {
    const el = makeContentEl();
    expect(simulateInputTransform(el, "### ")).toBe(true);
    expect(el.querySelector("h3") !== null).toBe(true);
    el.remove();
  });

  test("ul input transform", () => {
    const el = makeContentEl();
    expect(simulateInputTransform(el, "- ")).toBe(true);
    const ul = el.querySelector("ul");
    expect(ul !== null).toBe(true);
    const li = ul!.querySelector("li");
    expect(li !== null).toBe(true);
    expect(li!.innerHTML).toBe("<br>");
    el.remove();
  });

  test("ul asterisk input transform", () => {
    const el = makeContentEl();
    expect(simulateInputTransform(el, "* ")).toBe(true);
    expect(el.querySelector("ul") !== null).toBe(true);
    el.remove();
  });

  test("ol input transform", () => {
    const el = makeContentEl();
    expect(simulateInputTransform(el, "1. ")).toBe(true);
    const ol = el.querySelector("ol");
    expect(ol !== null).toBe(true);
    el.remove();
  });

  test("bq input transform", () => {
    const el = makeContentEl();
    expect(simulateInputTransform(el, "> ")).toBe(true);
    const bq = el.querySelector("blockquote");
    expect(bq !== null).toBe(true);
    const p = bq!.querySelector("p");
    expect(p !== null).toBe(true);
    expect(p!.innerHTML).toBe("<br>");
    el.remove();
  });

  test("code block input transform", () => {
    const el = makeContentEl();
    expect(simulateInputTransform(el, "``` ")).toBe(true);
    const pre = el.querySelector("pre");
    expect(pre !== null).toBe(true);
    const code = pre!.querySelector("code");
    expect(code !== null).toBe(true);
    el.remove();
  });

  test("code block lang input transform", () => {
    const el = makeContentEl();
    expect(simulateInputTransform(el, "```js ")).toBe(true);
    const code = el.querySelector("code");
    expect(code !== null).toBe(true);
    expect(code!.className).toBe("language-js");
    el.remove();
  });

  test("code block nbsp input transform", () => {
    const el = makeContentEl();
    expect(simulateInputTransform(el, "```\u00A0")).toBe(true);
    expect(el.querySelector("pre") !== null).toBe(true);
    el.remove();
  });

  test("no input transform for normal text", () => {
    const el = makeContentEl();
    expect(simulateInputTransform(el, "hello ")).toBe(false);
    el.remove();
  });

  test("unwrapped text node triggers transform", () => {
    const el = makeContentEl();
    const textNode = document.createTextNode("## ");
    el.appendChild(textNode);

    const range = document.createRange();
    range.setStart(textNode, 3);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    expect(checkBlockInputTransform(el)).toBe(true);
    expect(el.querySelector("h2") !== null).toBe(true);
    el.remove();
  });

  test("heading re-level triggers", () => {
    const el = makeContentEl();
    const h1 = document.createElement("h1");
    h1.textContent = "### hello";
    el.appendChild(h1);
    const range = document.createRange();
    range.setStart(h1.firstChild!, 4);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    expect(checkBlockInputTransform(el)).toBe(true);
    const h3 = el.querySelector("h3");
    expect(h3 !== null).toBe(true);
    expect(h3!.textContent).toBe("hello");
    el.remove();
  });

  test("heading re-level empty triggers", () => {
    const el = makeContentEl();
    const h1 = document.createElement("h1");
    h1.textContent = "## ";
    el.appendChild(h1);
    const range = document.createRange();
    range.setStart(h1.firstChild!, 3);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    expect(checkBlockInputTransform(el)).toBe(true);
    const h2 = el.querySelector("h2");
    expect(h2 !== null).toBe(true);
    expect(h2!.innerHTML).toBe("<br>");
    el.remove();
  });

  test("no transform for plain heading text", () => {
    const el = makeContentEl();
    const h2 = document.createElement("h2");
    h2.textContent = "just text";
    el.appendChild(h2);
    const range = document.createRange();
    range.setStart(h2.firstChild!, 9);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    expect(checkBlockInputTransform(el)).toBe(false);
    el.remove();
  });
});
