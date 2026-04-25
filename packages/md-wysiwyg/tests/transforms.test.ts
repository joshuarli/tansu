import { handleBlockTransform, checkBlockInputTransform } from "../src/transforms.ts";
import { setupDOM } from "./test-helper.ts";

describe("transforms", () => {
  let cleanup: () => void;

  function makeContentEl(): HTMLElement {
    const el = document.createElement("div");
    el.className = "editor-content";
    el.contentEditable = "true";
    document.body.append(el);
    return el;
  }

  function simulateTransform(
    contentEl: HTMLElement,
    text: string,
  ): { prevented: boolean; dirty: boolean } {
    const p = document.createElement("p");
    p.textContent = text;
    contentEl.append(p);

    const range = document.createRange();
    const textNode = p.firstChild ?? p;
    range.setStart(textNode, text.length);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    let prevented = false;
    let dirty = false;
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    Object.defineProperty(event, "preventDefault", {
      value: () => {
        prevented = true;
      },
    });
    handleBlockTransform(event, contentEl, () => {
      dirty = true;
    });
    return { prevented, dirty };
  }

  function simulateInputTransform(contentEl: HTMLElement, text: string): boolean {
    const p = document.createElement("p");
    p.textContent = text;
    contentEl.append(p);

    const range = document.createRange();
    const textNode = p.firstChild ?? p;
    range.setStart(textNode, text.length);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    return checkBlockInputTransform(contentEl);
  }

  beforeAll(() => {
    cleanup = setupDOM();
  });

  afterAll(() => {
    cleanup();
  });

  it("heading prevented default", () => {
    const el = makeContentEl();
    const { prevented } = simulateTransform(el, "## Hello");
    expect(prevented).toBeTruthy();
    el.remove();
  });

  it("heading calls onDirty", () => {
    const el = makeContentEl();
    const { dirty } = simulateTransform(el, "## Hello");
    expect(dirty).toBeTruthy();
    el.remove();
  });

  it("h2 created", () => {
    const el = makeContentEl();
    simulateTransform(el, "## Hello");
    const h2 = el.querySelector("h2");
    expect(h2 !== null).toBeTruthy();
    expect(h2!.textContent).toBe("Hello");
    const p = h2!.nextElementSibling;
    expect(p !== null && p.tagName === "P").toBeTruthy();
    el.remove();
  });

  it("hr prevented default", () => {
    const el = makeContentEl();
    const { prevented } = simulateTransform(el, "---");
    expect(prevented).toBeTruthy();
    expect(el.querySelector("hr") !== null).toBeTruthy();
    el.remove();
  });

  it("code prevented default", () => {
    const el = makeContentEl();
    const { prevented } = simulateTransform(el, "```js");
    expect(prevented).toBeTruthy();
    const pre = el.querySelector("pre");
    expect(pre !== null).toBeTruthy();
    const code = pre!.querySelector("code");
    expect(code !== null).toBeTruthy();
    expect(code!.className).toBe("language-js");
    el.remove();
  });

  it("ul prevented default", () => {
    const el = makeContentEl();
    const { prevented } = simulateTransform(el, "- item");
    expect(prevented).toBeTruthy();
    const ul = el.querySelector("ul");
    expect(ul !== null).toBeTruthy();
    const li = ul!.querySelector("li");
    expect(li!.textContent).toBe("item");
    el.remove();
  });

  it("ol prevented default", () => {
    const el = makeContentEl();
    const { prevented } = simulateTransform(el, "1. first");
    expect(prevented).toBeTruthy();
    const ol = el.querySelector("ol");
    expect(ol !== null).toBeTruthy();
    expect(ol!.querySelector("li")!.textContent).toBe("first");
    el.remove();
  });

  it("bq prevented default", () => {
    const el = makeContentEl();
    const { prevented } = simulateTransform(el, "> quoted");
    expect(prevented).toBeTruthy();
    const bq = el.querySelector("blockquote");
    expect(bq !== null).toBeTruthy();
    expect(bq!.querySelector("p")!.textContent).toBe("quoted");
    el.remove();
  });

  it("normal text not prevented", () => {
    const el = makeContentEl();
    const { prevented, dirty } = simulateTransform(el, "just text");
    expect(prevented).toBeFalsy();
    expect(dirty).toBeFalsy();
    el.remove();
  });

  it("onDirty optional — no crash without it", () => {
    const el = makeContentEl();
    const p = document.createElement("p");
    p.textContent = "## heading";
    el.append(p);
    const range = document.createRange();
    range.setStart(p.firstChild!, 10);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    // Should not throw even with no onDirty callback
    expect(() => handleBlockTransform(event, el)).not.toThrow();
    el.remove();
  });

  it("h2 input transform", () => {
    const el = makeContentEl();
    expect(simulateInputTransform(el, "## ")).toBeTruthy();
    const h2 = el.querySelector("h2");
    expect(h2 !== null).toBeTruthy();
    expect(h2!.innerHTML).toBe("<br>");
    el.remove();
  });

  it("h2 nbsp input transform", () => {
    const el = makeContentEl();
    expect(simulateInputTransform(el, "##\u00A0")).toBeTruthy();
    expect(el.querySelector("h2") !== null).toBeTruthy();
    el.remove();
  });

  it("h1 input transform", () => {
    const el = makeContentEl();
    expect(simulateInputTransform(el, "# ")).toBeTruthy();
    expect(el.querySelector("h1") !== null).toBeTruthy();
    el.remove();
  });

  it("h3 input transform", () => {
    const el = makeContentEl();
    expect(simulateInputTransform(el, "### ")).toBeTruthy();
    expect(el.querySelector("h3") !== null).toBeTruthy();
    el.remove();
  });

  it("ul input transform", () => {
    const el = makeContentEl();
    expect(simulateInputTransform(el, "- ")).toBeTruthy();
    const ul = el.querySelector("ul");
    expect(ul !== null).toBeTruthy();
    const li = ul!.querySelector("li");
    expect(li !== null).toBeTruthy();
    expect(li!.innerHTML).toBe("<br>");
    el.remove();
  });

  it("ul asterisk input transform", () => {
    const el = makeContentEl();
    expect(simulateInputTransform(el, "* ")).toBeTruthy();
    expect(el.querySelector("ul") !== null).toBeTruthy();
    el.remove();
  });

  it("ol input transform", () => {
    const el = makeContentEl();
    expect(simulateInputTransform(el, "1. ")).toBeTruthy();
    const ol = el.querySelector("ol");
    expect(ol !== null).toBeTruthy();
    el.remove();
  });

  it("task input transform", () => {
    const el = makeContentEl();
    expect(simulateInputTransform(el, "[ ] ")).toBeTruthy();
    const ul = el.querySelector("ul.task-list");
    expect(ul !== null).toBeTruthy();
    const li = ul!.querySelector("li.task-item");
    expect(li !== null).toBeTruthy();
    const checkbox = li!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox !== null).toBeTruthy();
    expect(checkbox.checked).toBeFalsy();
    el.remove();
  });

  it("task enter transform creates a new empty task item", () => {
    const el = makeContentEl();
    const ul = document.createElement("ul");
    ul.className = "task-list";
    const li = document.createElement("li");
    li.className = "task-item";
    li.innerHTML = '<input type="checkbox">&nbsp;foo';
    ul.append(li);
    el.append(ul);

    const textNode = [...li.childNodes].find((node) => node.nodeType === Node.TEXT_NODE) as Text;
    const range = document.createRange();
    range.setStart(textNode, textNode.textContent?.length ?? 0);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    handleBlockTransform(event, el);

    expect(el.querySelectorAll("li.task-item")).toHaveLength(2);
    const next = el.querySelectorAll("li.task-item")[1]!;
    expect(next.querySelector('input[type="checkbox"]')).not.toBeNull();
    el.remove();
  });

  it("bq input transform", () => {
    const el = makeContentEl();
    expect(simulateInputTransform(el, "> ")).toBeTruthy();
    const bq = el.querySelector("blockquote");
    expect(bq !== null).toBeTruthy();
    const p = bq!.querySelector("p");
    expect(p !== null).toBeTruthy();
    expect(p!.innerHTML).toBe("<br>");
    el.remove();
  });

  it("code block input transform", () => {
    const el = makeContentEl();
    expect(simulateInputTransform(el, "``` ")).toBeTruthy();
    const pre = el.querySelector("pre");
    expect(pre !== null).toBeTruthy();
    const code = pre!.querySelector("code");
    expect(code !== null).toBeTruthy();
    el.remove();
  });

  it("code block lang input transform", () => {
    const el = makeContentEl();
    expect(simulateInputTransform(el, "```js ")).toBeTruthy();
    const code = el.querySelector("code");
    expect(code !== null).toBeTruthy();
    expect(code!.className).toBe("language-js");
    el.remove();
  });

  it("code block nbsp input transform", () => {
    const el = makeContentEl();
    expect(simulateInputTransform(el, "```\u00A0")).toBeTruthy();
    expect(el.querySelector("pre") !== null).toBeTruthy();
    el.remove();
  });

  it("no input transform for normal text", () => {
    const el = makeContentEl();
    expect(simulateInputTransform(el, "hello ")).toBeFalsy();
    el.remove();
  });

  it("unwrapped text node triggers transform", () => {
    const el = makeContentEl();
    const textNode = document.createTextNode("## ");
    el.append(textNode);

    const range = document.createRange();
    range.setStart(textNode, 3);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    expect(checkBlockInputTransform(el)).toBeTruthy();
    expect(el.querySelector("h2") !== null).toBeTruthy();
    el.remove();
  });

  it("heading re-level triggers", () => {
    const el = makeContentEl();
    const h1 = document.createElement("h1");
    h1.textContent = "### hello";
    el.append(h1);
    const range = document.createRange();
    range.setStart(h1.firstChild!, 4);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    expect(checkBlockInputTransform(el)).toBeTruthy();
    const h3 = el.querySelector("h3");
    expect(h3 !== null).toBeTruthy();
    expect(h3!.textContent).toBe("hello");
    el.remove();
  });

  it("heading re-level empty triggers", () => {
    const el = makeContentEl();
    const h1 = document.createElement("h1");
    h1.textContent = "## ";
    el.append(h1);
    const range = document.createRange();
    range.setStart(h1.firstChild!, 3);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    expect(checkBlockInputTransform(el)).toBeTruthy();
    const h2 = el.querySelector("h2");
    expect(h2 !== null).toBeTruthy();
    expect(h2!.innerHTML).toBe("<br>");
    el.remove();
  });

  it("no transform for plain heading text", () => {
    const el = makeContentEl();
    const h2 = document.createElement("h2");
    h2.textContent = "just text";
    el.append(h2);
    const range = document.createRange();
    range.setStart(h2.firstChild!, 9);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    expect(checkBlockInputTransform(el)).toBeFalsy();
    el.remove();
  });
});
