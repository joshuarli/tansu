/// Unit tests for getCursorMarkdownOffset.
/// Verifies that cursor positions inside various DOM structures map to correct
/// offsets in the serialized markdown string, especially for cursors inside
/// inline elements where a naive clone-to-cursor approach overcounts.

import { setupDOM } from "./test-helper.ts";

describe("getCursorMarkdownOffset", () => {
  let cleanup: () => void;
  let getCursorMarkdownOffset: (el: HTMLElement, range: Range) => number;

  beforeAll(async () => {
    cleanup = setupDOM();
    const serMod = await import("../src/serialize.ts");
    ({ getCursorMarkdownOffset } = serMod);
  });

  afterAll(() => cleanup());

  function makeEl(html: string): HTMLElement {
    const el = document.createElement("div");
    el.innerHTML = html;
    return el;
  }

  function rangeAt(node: Node, offset: number): Range {
    const r = document.createRange();
    r.setStart(node, offset);
    r.collapse(true);
    return r;
  }

  // Plain text in a single paragraph

  it("start of plain paragraph → offset 0", () => {
    const el = makeEl("<p>hello</p>");
    const text = el.querySelector("p")!.firstChild as Text;
    expect(getCursorMarkdownOffset(el, rangeAt(text, 0))).toBe(0);
  });

  it("middle of plain paragraph", () => {
    const el = makeEl("<p>hello</p>");
    const text = el.querySelector("p")!.firstChild as Text;
    expect(getCursorMarkdownOffset(el, rangeAt(text, 3))).toBe(3);
  });

  it("end of plain paragraph", () => {
    const el = makeEl("<p>hello</p>");
    const text = el.querySelector("p")!.firstChild as Text;
    expect(getCursorMarkdownOffset(el, rangeAt(text, 5))).toBe(5);
  });

  // Cursor inside <strong> — the canonical test for the sentinel-insert approach.
  // A naive cloneContents approach would produce **bo** (6 chars) not 4.

  it("cursor inside bold — before first char → offset 2 (after **)", () => {
    const el = makeEl("<p><strong>bold</strong></p>");
    const text = el.querySelector("strong")!.firstChild as Text;
    expect(getCursorMarkdownOffset(el, rangeAt(text, 0))).toBe(2);
  });

  it("cursor inside bold — after first char → offset 3", () => {
    const el = makeEl("<p><strong>bold</strong></p>");
    const text = el.querySelector("strong")!.firstChild as Text;
    expect(getCursorMarkdownOffset(el, rangeAt(text, 1))).toBe(3);
  });

  it("cursor inside bold — after last char → offset 6", () => {
    const el = makeEl("<p><strong>bold</strong></p>");
    const text = el.querySelector("strong")!.firstChild as Text;
    expect(getCursorMarkdownOffset(el, rangeAt(text, 4))).toBe(6);
  });

  it("cursor after strong element → offset 8 (**bold**)", () => {
    const el = makeEl("<p><strong>bold</strong></p>");
    const p = el.querySelector("p")!;
    const strong = p.querySelector("strong")!;
    const r = document.createRange();
    r.setStartAfter(strong);
    r.collapse(true);
    expect(getCursorMarkdownOffset(el, r)).toBe(8);
  });

  // Cursor inside <em>

  it("cursor inside italic — before first char → offset 1 (after *)", () => {
    const el = makeEl("<p><em>hi</em></p>");
    const text = el.querySelector("em")!.firstChild as Text;
    expect(getCursorMarkdownOffset(el, rangeAt(text, 0))).toBe(1);
  });

  it("cursor inside italic — after last char → offset 3 (*hi)", () => {
    const el = makeEl("<p><em>hi</em></p>");
    const text = el.querySelector("em")!.firstChild as Text;
    expect(getCursorMarkdownOffset(el, rangeAt(text, 2))).toBe(3);
  });

  // Mixed prefix text + inline element

  it("cursor in prefix text before bold", () => {
    // "foo **bar**" — cursor at position 2 in "foo " = markdown offset 2
    const el = makeEl("<p>foo <strong>bar</strong></p>");
    const prefixText = el.querySelector("p")!.firstChild as Text;
    expect(getCursorMarkdownOffset(el, rangeAt(prefixText, 2))).toBe(2);
  });

  it("cursor inside bold after prefix text", () => {
    // "foo **bar**" — cursor before 'b' in bold = offset 6 ("foo **")
    const el = makeEl("<p>foo <strong>bar</strong></p>");
    const boldText = el.querySelector("strong")!.firstChild as Text;
    expect(getCursorMarkdownOffset(el, rangeAt(boldText, 0))).toBe(6);
  });

  // Multi-paragraph: paragraphs are separated by \n

  it("cursor at start of second paragraph → offset = first.length + 1", () => {
    // "foo\nbar" — second para starts at offset 4
    const el = makeEl("<p>foo</p><p>bar</p>");
    const secondText = el.querySelectorAll("p")[1]!.firstChild as Text;
    expect(getCursorMarkdownOffset(el, rangeAt(secondText, 0))).toBe(4);
  });

  it("cursor in middle of second paragraph", () => {
    // "foo\nbar" — offset into "bar" at position 2 = 4 + 2 = 6
    const el = makeEl("<p>foo</p><p>bar</p>");
    const secondText = el.querySelectorAll("p")[1]!.firstChild as Text;
    expect(getCursorMarkdownOffset(el, rangeAt(secondText, 2))).toBe(6);
  });

  // Strikethrough and highlight (less common but same logic)

  it("cursor inside strikethrough — before first char → offset 2 (after ~~)", () => {
    const el = makeEl("<p><del>bye</del></p>");
    const text = el.querySelector("del")!.firstChild as Text;
    expect(getCursorMarkdownOffset(el, rangeAt(text, 0))).toBe(2);
  });

  it("cursor inside highlight — before first char → offset 2 (after ==)", () => {
    const el = makeEl("<p><mark>hi</mark></p>");
    const text = el.querySelector("mark")!.firstChild as Text;
    expect(getCursorMarkdownOffset(el, rangeAt(text, 0))).toBe(2);
  });
});
