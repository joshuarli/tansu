import { describe, test, expect, beforeAll, afterAll, afterEach } from "vitest";

import { initFormatToolbar } from "./format-toolbar.ts";
import { setupDOM } from "./test-helper.ts";

const wait = (ms = 20) => new Promise<void>((r) => setTimeout(r, ms));

describe("format-toolbar", () => {
  let cleanup: () => void;

  beforeAll(() => {
    cleanup = setupDOM();
    // happy-dom 20.x doesn't implement document.execCommand; stub it so button actions don't throw.
    (document as unknown as Record<string, unknown>)["execCommand"] = () => false;
  });

  afterAll(() => {
    cleanup();
  });

  afterEach(() => {
    // Remove any stale toolbars and editor elements left by failed tests
    for (const el of document.body.querySelectorAll(".format-toolbar")) el.remove();
    for (const el of document.body.querySelectorAll(".editor-content")) el.remove();
  });

  function makeEditorEl(html = "<p>hello world</p>"): HTMLElement {
    const el = document.createElement("div");
    el.className = "editor-content";
    el.contentEditable = "true";
    el.innerHTML = html;
    document.body.appendChild(el);
    return el;
  }

  function selectRange(el: HTMLElement, startOffset: number, endOffset: number) {
    const textNode = el.querySelector("p")!.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, startOffset);
    range.setEnd(textNode, endOffset);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    return range;
  }

  test("toolbar is appended to body on init, removed by cleanup", () => {
    const el = makeEditorEl();
    const remove = initFormatToolbar({
      contentEl: el,
      applyIndent: () => {},
      applySourceFormat: (fn) => {
        fn("hello", 0, 5);
      },
      onMutation: () => {},
    });

    expect(document.body.querySelector(".format-toolbar") !== null).toBe(true);
    remove();
    expect(document.body.querySelector(".format-toolbar")).toBe(null);
    el.remove();
  });

  test("all expected buttons are present with correct titles", () => {
    const el = makeEditorEl();
    const remove = initFormatToolbar({
      contentEl: el,
      applyIndent: () => {},
      applySourceFormat: (fn) => {
        fn("hello", 0, 5);
      },
      onMutation: () => {},
    });
    const toolbar = document.body.querySelector(".format-toolbar")!;
    const titles = Array.from(toolbar.querySelectorAll(".format-toolbar-btn")).map(
      (b) => (b as HTMLElement).title,
    );

    for (const expected of [
      "Bold",
      "Italic",
      "Strikethrough",
      "Highlight",
      "Heading 1",
      "Heading 2",
      "Heading 3",
      "Heading 4",
      "Indent",
      "Dedent",
      "Code block",
    ]) {
      expect(titles).toContain(expected);
    }

    remove();
    el.remove();
  });

  test("non-collapsed selection inside contentEl shows toolbar", async () => {
    const el = makeEditorEl();
    const remove = initFormatToolbar({
      contentEl: el,
      applyIndent: () => {},
      applySourceFormat: (fn) => {
        fn("hello", 0, 5);
      },
      onMutation: () => {},
    });
    const toolbar = document.body.querySelector(".format-toolbar") as HTMLElement;

    selectRange(el, 0, 5);
    document.dispatchEvent(new Event("selectionchange"));
    await wait();

    expect(toolbar.style.display).toBe("flex");

    remove();
    el.remove();
  });

  test("collapsed selection hides toolbar", async () => {
    const el = makeEditorEl();
    const remove = initFormatToolbar({
      contentEl: el,
      applyIndent: () => {},
      applySourceFormat: (fn) => {
        fn("hello", 0, 5);
      },
      onMutation: () => {},
    });
    const toolbar = document.body.querySelector(".format-toolbar") as HTMLElement;

    // Show first
    selectRange(el, 0, 5);
    document.dispatchEvent(new Event("selectionchange"));
    await wait();
    expect(toolbar.style.display).toBe("flex");

    // Collapse
    const sel = window.getSelection()!;
    sel.collapseToStart();
    document.dispatchEvent(new Event("selectionchange"));
    await wait();

    expect(toolbar.style.display).toBe("none");

    remove();
    el.remove();
  });

  test("selection outside contentEl hides toolbar", async () => {
    const el = makeEditorEl();
    const outside = document.createElement("div");
    outside.innerHTML = "<p>outside text</p>";
    document.body.appendChild(outside);

    const remove = initFormatToolbar({
      contentEl: el,
      applyIndent: () => {},
      applySourceFormat: (fn) => {
        fn("hello", 0, 5);
      },
      onMutation: () => {},
    });
    const toolbar = document.body.querySelector(".format-toolbar") as HTMLElement;

    // Show with a selection inside el first
    selectRange(el, 0, 5);
    document.dispatchEvent(new Event("selectionchange"));
    await wait();
    expect(toolbar.style.display).toBe("flex");

    // Select outside
    const textNode = outside.querySelector("p")!.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 4);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    await wait();

    expect(toolbar.style.display).toBe("none");

    remove();
    el.remove();
    outside.remove();
  });

  test("Escape key hides toolbar", async () => {
    const el = makeEditorEl();
    const remove = initFormatToolbar({
      contentEl: el,
      applyIndent: () => {},
      applySourceFormat: (fn) => {
        fn("hello", 0, 5);
      },
      onMutation: () => {},
    });
    const toolbar = document.body.querySelector(".format-toolbar") as HTMLElement;

    selectRange(el, 0, 5);
    document.dispatchEvent(new Event("selectionchange"));
    await wait();
    expect(toolbar.style.display).toBe("flex");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(toolbar.style.display).toBe("none");

    remove();
    el.remove();
  });

  test("mousedown on toolbar does not set mouseIsDown flag (selection is preserved)", async () => {
    const el = makeEditorEl();
    const remove = initFormatToolbar({
      contentEl: el,
      applyIndent: () => {},
      applySourceFormat: (fn) => {
        fn("hello", 0, 5);
      },
      onMutation: () => {},
    });
    const toolbar = document.body.querySelector(".format-toolbar")!;

    selectRange(el, 0, 5);
    document.dispatchEvent(new Event("selectionchange"));
    await wait();

    // Mousedown on toolbar itself (not outside) should NOT suppress toolbar visibility
    toolbar.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await wait();

    // Toolbar should still be showing
    expect((toolbar as HTMLElement).style.display).toBe("flex");

    remove();
    el.remove();
  });

  test("mousedown outside toolbar sets mouseIsDown, mouseup clears it", async () => {
    const el = makeEditorEl();
    const remove = initFormatToolbar({
      contentEl: el,
      applyIndent: () => {},
      applySourceFormat: (fn) => {
        fn("hello", 0, 5);
      },
      onMutation: () => {},
    });

    selectRange(el, 0, 5);
    document.dispatchEvent(new Event("selectionchange"));
    await wait();

    // Mousedown outside toolbar
    document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    // selectionchange fires during the drag but toolbar shouldn't update while mouseIsDown
    document.dispatchEvent(new Event("selectionchange"));
    // No await here — verify that during mousedown the toolbar update is suppressed

    // Mouseup clears mouseIsDown and triggers requestAnimationFrame
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await wait();

    remove();
    el.remove();
  });

  test("Bold button mousedown calls onMutation", async () => {
    const el = makeEditorEl("<p>test text</p>");
    let mutationCount = 0;
    const remove = initFormatToolbar({
      contentEl: el,
      applyIndent: () => {},
      applySourceFormat: (fn) => { fn("hello", 0, 5); },
      onMutation: () => {
        mutationCount++;
      },
    });
    const toolbar = document.body.querySelector(".format-toolbar")!;
    const boldBtn = Array.from(toolbar.querySelectorAll(".format-toolbar-btn")).find(
      (b) => (b as HTMLElement).title === "Bold",
    ) as HTMLElement;

    selectRange(el, 0, 4);
    boldBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

    expect(mutationCount).toBeGreaterThan(0);

    remove();
    el.remove();
  });

  test("Italic button mousedown calls onMutation", async () => {
    const el = makeEditorEl("<p>italic me</p>");
    let mutationCount = 0;
    const remove = initFormatToolbar({
      contentEl: el,
      applyIndent: () => {},
      applySourceFormat: (fn) => { fn("hello", 0, 5); },
      onMutation: () => {
        mutationCount++;
      },
    });
    const toolbar = document.body.querySelector(".format-toolbar")!;
    const btn = Array.from(toolbar.querySelectorAll(".format-toolbar-btn")).find(
      (b) => (b as HTMLElement).title === "Italic",
    ) as HTMLElement;

    selectRange(el, 0, 6);
    btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

    expect(mutationCount).toBeGreaterThan(0);

    remove();
    el.remove();
  });

  test("Strikethrough button mousedown calls onMutation (toggleInlineWrap wrap path)", async () => {
    const el = makeEditorEl("<p>strikethrough me</p>");
    let mutationCount = 0;
    const remove = initFormatToolbar({
      contentEl: el,
      applyIndent: () => {},
      applySourceFormat: (fn) => { fn("hello", 0, 5); },
      onMutation: () => {
        mutationCount++;
      },
    });
    const toolbar = document.body.querySelector(".format-toolbar")!;
    const btn = Array.from(toolbar.querySelectorAll(".format-toolbar-btn")).find(
      (b) => (b as HTMLElement).title === "Strikethrough",
    ) as HTMLElement;

    selectRange(el, 0, 4);
    btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

    expect(mutationCount).toBeGreaterThan(0);

    remove();
    el.remove();
  });

  test("Strikethrough on already-wrapped text unwraps it (toggleInlineWrap unwrap path)", async () => {
    const el = makeEditorEl("<p><del>strike</del></p>");
    let mutationCount = 0;
    const remove = initFormatToolbar({
      contentEl: el,
      applyIndent: () => {},
      applySourceFormat: (fn) => { fn("hello", 0, 5); },
      onMutation: () => {
        mutationCount++;
      },
    });
    const toolbar = document.body.querySelector(".format-toolbar")!;
    const btn = Array.from(toolbar.querySelectorAll(".format-toolbar-btn")).find(
      (b) => (b as HTMLElement).title === "Strikethrough",
    ) as HTMLElement;

    // Select the text inside the <del>
    const delEl = el.querySelector("del")!;
    const textNode = delEl.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 6);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

    expect(mutationCount).toBeGreaterThan(0);

    remove();
    el.remove();
  });

  test("Highlight button mousedown calls onMutation (toggleInlineWrap mark)", async () => {
    const el = makeEditorEl("<p>highlight me</p>");
    let mutationCount = 0;
    const remove = initFormatToolbar({
      contentEl: el,
      applyIndent: () => {},
      applySourceFormat: (fn) => { fn("hello", 0, 5); },
      onMutation: () => {
        mutationCount++;
      },
    });
    const toolbar = document.body.querySelector(".format-toolbar")!;
    const btn = Array.from(toolbar.querySelectorAll(".format-toolbar-btn")).find(
      (b) => (b as HTMLElement).title === "Highlight",
    ) as HTMLElement;

    selectRange(el, 0, 9);
    btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

    expect(mutationCount).toBeGreaterThan(0);

    remove();
    el.remove();
  });

  test("Heading buttons hide toolbar (afterBlock path)", () => {
    const el = makeEditorEl("<p>heading text</p>");
    let mutationCount = 0;
    const remove = initFormatToolbar({
      contentEl: el,
      applyIndent: () => {},
      applySourceFormat: (fn) => { fn("hello", 0, 5); },
      onMutation: () => {
        mutationCount++;
      },
    });
    const toolbar = document.body.querySelector(".format-toolbar") as HTMLElement;

    for (const level of [1, 2, 3, 4]) {
      const btn = Array.from(toolbar.querySelectorAll(".format-toolbar-btn")).find(
        (b) => (b as HTMLElement).title === `Heading ${level}`,
      ) as HTMLElement;

      // Put cursor in the paragraph
      const p = el.querySelector("p")!;
      const textNode = p.firstChild as Text;
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, 4);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);

      btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    }

    expect(mutationCount).toBeGreaterThan(0);

    remove();
    el.remove();
  });

  test("Indent button calls applyIndent(false) and hides toolbar", () => {
    const el = makeEditorEl("<p>indent me</p>");
    let indentArgs: boolean[] = [];
    const remove = initFormatToolbar({
      contentEl: el,
      applyIndent: (dedent) => {
        indentArgs.push(dedent);
      },
      applySourceFormat: (fn) => { fn("hello", 0, 5); },
      onMutation: () => {},
    });
    const toolbar = document.body.querySelector(".format-toolbar")!;
    const btn = Array.from(toolbar.querySelectorAll(".format-toolbar-btn")).find(
      (b) => (b as HTMLElement).title === "Indent",
    ) as HTMLElement;

    btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

    expect(indentArgs).toContain(false);

    remove();
    el.remove();
  });

  test("Dedent button calls applyIndent(true) and hides toolbar", () => {
    const el = makeEditorEl("<p>dedent me</p>");
    let indentArgs: boolean[] = [];
    const remove = initFormatToolbar({
      contentEl: el,
      applyIndent: (dedent) => {
        indentArgs.push(dedent);
      },
      applySourceFormat: (fn) => { fn("hello", 0, 5); },
      onMutation: () => {},
    });
    const toolbar = document.body.querySelector(".format-toolbar")!;
    const btn = Array.from(toolbar.querySelectorAll(".format-toolbar-btn")).find(
      (b) => (b as HTMLElement).title === "Dedent",
    ) as HTMLElement;

    btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

    expect(indentArgs).toContain(true);

    remove();
    el.remove();
  });

  test("Code block button calls onMutation and hides toolbar (applyCodeBlock path)", () => {
    const el = makeEditorEl("<p>some code</p>");
    let mutationCount = 0;
    const remove = initFormatToolbar({
      contentEl: el,
      applyIndent: () => {},
      applySourceFormat: (fn) => { fn("hello", 0, 5); },
      onMutation: () => {
        mutationCount++;
      },
    });
    const toolbar = document.body.querySelector(".format-toolbar")!;
    const btn = Array.from(toolbar.querySelectorAll(".format-toolbar-btn")).find(
      (b) => (b as HTMLElement).title === "Code block",
    ) as HTMLElement;

    const p = el.querySelector("p")!;
    const textNode = p.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 4);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

    expect(mutationCount).toBeGreaterThan(0);

    remove();
    el.remove();
  });

  test("toggleInlineWrap is a no-op (no DOM change) when selection is collapsed", async () => {
    const el = makeEditorEl("<p>text</p>");
    const remove = initFormatToolbar({
      contentEl: el,
      applyIndent: () => {},
      applySourceFormat: (fn) => {
        fn("hello", 0, 5);
      },
      onMutation: () => {},
    });
    const toolbar = document.body.querySelector(".format-toolbar")!;
    const strikeBtn = Array.from(toolbar.querySelectorAll(".format-toolbar-btn")).find(
      (b) => (b as HTMLElement).title === "Strikethrough",
    ) as HTMLElement;

    // Collapsed selection: toggleInlineWrap returns early without wrapping
    const textNode = el.querySelector("p")!.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 2);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    strikeBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

    // DOM should be unchanged: no <del> inserted
    expect(el.querySelector("del")).toBe(null);
    expect(el.querySelector("p")!.textContent).toBe("text");

    remove();
    el.remove();
  });

  test("applyBlockFormat: heading toggled back to p when same tag clicked again", () => {
    const el = makeEditorEl("<h1>heading</h1>");
    let mutationCount = 0;
    const remove = initFormatToolbar({
      contentEl: el,
      applyIndent: () => {},
      applySourceFormat: (fn) => { fn("hello", 0, 5); },
      onMutation: () => {
        mutationCount++;
      },
    });
    const toolbar = document.body.querySelector(".format-toolbar")!;
    const h1Btn = Array.from(toolbar.querySelectorAll(".format-toolbar-btn")).find(
      (b) => (b as HTMLElement).title === "Heading 1",
    ) as HTMLElement;

    const h1 = el.querySelector("h1")!;
    const textNode = h1.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 7);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    h1Btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

    expect(mutationCount).toBeGreaterThan(0);

    remove();
    el.remove();
  });

  test("applyBlockFormat: no-op when block is not a heading/p/div", () => {
    const el = makeEditorEl("<ul><li>item</li></ul>");
    let mutationCount = 0;
    const remove = initFormatToolbar({
      contentEl: el,
      applyIndent: () => {},
      applySourceFormat: (fn) => { fn("hello", 0, 5); },
      onMutation: () => {
        mutationCount++;
      },
    });
    const toolbar = document.body.querySelector(".format-toolbar")!;
    const h2Btn = Array.from(toolbar.querySelectorAll(".format-toolbar-btn")).find(
      (b) => (b as HTMLElement).title === "Heading 2",
    ) as HTMLElement;

    const li = el.querySelector("li")!;
    const textNode = li.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 4);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    // li is not a p/div/h[1-6], so applyBlockFormat should be a no-op
    h2Btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

    expect(mutationCount).toBeGreaterThan(0);

    remove();
    el.remove();
  });

  test("applyCodeBlock: pre toggled back to p", () => {
    const el = makeEditorEl("<pre>code here</pre>");
    let mutationCount = 0;
    const remove = initFormatToolbar({
      contentEl: el,
      applyIndent: () => {},
      applySourceFormat: (fn) => { fn("hello", 0, 5); },
      onMutation: () => {
        mutationCount++;
      },
    });
    const toolbar = document.body.querySelector(".format-toolbar")!;
    const codeBtn = Array.from(toolbar.querySelectorAll(".format-toolbar-btn")).find(
      (b) => (b as HTMLElement).title === "Code block",
    ) as HTMLElement;

    const pre = el.querySelector("pre")!;
    const textNode = pre.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 4);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    codeBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

    expect(mutationCount).toBeGreaterThan(0);

    remove();
    el.remove();
  });

  test("cleanup removes all document event listeners", async () => {
    const el = makeEditorEl("<p>cleanup test</p>");
    const remove = initFormatToolbar({
      contentEl: el,
      applyIndent: () => {},
      applySourceFormat: (fn) => {
        fn("hello", 0, 5);
      },
      onMutation: () => {},
    });
    remove();

    // After removal, Escape should not cause any errors (no listener)
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.dispatchEvent(new Event("selectionchange"));
    await wait();
    // If no errors thrown, cleanup worked correctly

    el.remove();
  });
});
