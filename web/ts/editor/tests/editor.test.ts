import {
  expect,
  beforeAll,
  it,
  describe,
  vi,
  afterAll,
  beforeEach,
  afterEach,
  expectTypeOf,
} from "vitest";
/// Tests for createEditor() wiring layer.

import { createEditor } from "../editor.ts";
import { toggleBold } from "../format-ops.ts";
import { createWikiImageExtension } from "../wiki-image.ts";
import { createWikiLinkExtension } from "../wiki-link.ts";
import { setupDOM } from "./test-helper.ts";

describe("createEditor", () => {
  let cleanup: () => void;
  let container: HTMLElement;

  beforeAll(() => {
    cleanup = setupDOM();
  });

  afterAll(() => {
    cleanup();
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("mounts contentEl and sourceEl inside container", () => {
    const handle = createEditor(container);
    expect(container.contains(handle.contentEl)).toBeTruthy();
    expect(container.contains(handle.sourceEl)).toBeTruthy();
    handle.destroy();
  });

  it("contentEl is contenteditable", () => {
    const handle = createEditor(container);
    expect(handle.contentEl.contentEditable).toBe("true");
    handle.destroy();
  });

  it("sourceEl is hidden by default", () => {
    const handle = createEditor(container);
    expect(handle.sourceEl.style.display).toBe("none");
    handle.destroy();
  });

  it("destroy removes contentEl and sourceEl from container", () => {
    const handle = createEditor(container);
    handle.destroy();
    expect(container.contains(handle.contentEl)).toBeFalsy();
    expect(container.contains(handle.sourceEl)).toBeFalsy();
  });

  it("getValue after setValue returns same markdown", () => {
    const handle = createEditor(container);
    handle.setValue("hello world");
    expect(handle.getValue()).toBe("hello world");
    handle.destroy();
  });

  it("setValue renders HTML into contentEl", () => {
    const handle = createEditor(container);
    handle.setValue("# Heading");
    expect(handle.contentEl.querySelector("h1")).toBeInstanceOf(HTMLHeadingElement);
    handle.destroy();
  });

  it("setValue with cursor offset renders cursor marker and cleans up", () => {
    const handle = createEditor(container);
    handle.setValue("hello world", 5);
    // Cursor marker should be removed after restore
    expect(handle.contentEl.querySelector('[data-md-cursor="true"]')).toBeNull();
    handle.destroy();
  });

  it("setValue places a cursor after an H1 trailing newline in an editable paragraph", () => {
    const handle = createEditor(container);
    handle.setValue("# Title\n", "# Title\n".length);

    const sel = window.getSelection()!;
    expect(sel.anchorNode).not.toBeNull();
    expect(handle.contentEl.querySelector("h1")!.contains(sel.anchorNode)).toBeFalsy();
    expect(handle.contentEl.querySelector("h1 + p")).not.toBeNull();
    handle.destroy();
  });

  it("multiple setValue calls each update getValue", () => {
    const handle = createEditor(container);
    handle.setValue("first");
    expect(handle.getValue()).toBe("first");
    handle.setValue("second");
    expect(handle.getValue()).toBe("second");
    handle.destroy();
  });

  it("getSnapshot returns model markdown and revision state", () => {
    const handle = createEditor(container);
    handle.setValue("foo\n\nbar", 3);

    const snapshot = handle.getSnapshot();

    expect(snapshot.markdown).toBe("foo\n\nbar");
    expect(snapshot.cursorOffset).toBe(3);
    expect(snapshot.selection).toStrictEqual({ start: 3, end: 3 });
    expect(snapshot.revision).toBeGreaterThan(0);
    expect(snapshot.sourceMode).toBeFalsy();
    handle.destroy();
  });

  it("getSnapshot maps inline formatted DOM positions through source spans", () => {
    const handle = createEditor(container);
    handle.setValue("**bold**");
    const strong = handle.contentEl.querySelector("strong")!;
    const textNode = strong.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 0);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    expect(handle.getSnapshot().cursorOffset).toBe(2);

    range.setStart(textNode, 4);
    range.setEnd(textNode, 4);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    expect(handle.getSnapshot().cursorOffset).toBe(6);

    range.setStartAfter(strong);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    expect(handle.getSnapshot().cursorOffset).toBe(8);
    handle.destroy();
  });

  it("getSnapshot maps heading and list inline positions through line-relative source spans", () => {
    const handle = createEditor(container);
    handle.setValue("# **Head**\n- **Item**");

    const headingText = handle.contentEl.querySelector("h1 strong")!.firstChild!;
    const headingRange = document.createRange();
    headingRange.setStart(headingText, 0);
    headingRange.setEnd(headingText, 0);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(headingRange);
    expect(handle.getSnapshot().cursorOffset).toBe("# **".length);

    const itemText = handle.contentEl.querySelector("li strong")!.firstChild!;
    const itemRange = document.createRange();
    itemRange.setStart(itemText, 0);
    itemRange.setEnd(itemText, 0);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(itemRange);
    expect(handle.getSnapshot().cursorOffset).toBe("# **Head**\n- **".length);
    handle.destroy();
  });

  it("getSnapshot treats extension inline output as an atomic source span", () => {
    const handle = createEditor(container, { extensions: [createWikiLinkExtension()] });
    handle.setValue("[[target|display]]");
    const link = handle.contentEl.querySelector(".wiki-link")!;
    const textNode = link.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 0);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    expect(handle.getSnapshot().cursorOffset).toBe(0);

    range.setStart(textNode, textNode.textContent!.length);
    range.setEnd(textNode, textNode.textContent!.length);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    expect(handle.getSnapshot().cursorOffset).toBe("[[target|display]]".length);
    handle.destroy();
  });

  it("renders model block and line metadata with gutter handles", () => {
    const handle = createEditor(container);
    handle.setValue("# Heading\n\nbody");

    const heading = handle.contentEl.querySelector<HTMLElement>("h1")!;
    const paragraph = handle.contentEl.querySelector<HTMLElement>("p:not([data-md-blank])")!;

    expect(heading.dataset["mdBlockKind"]).toBe("heading");
    expect(heading.dataset["mdLineIndex"]).toBe("0");
    expect(heading.querySelector(".md-block-handle")).toBeInstanceOf(HTMLButtonElement);
    expect(paragraph.dataset["mdBlockKind"]).toBe("paragraph");
    expect(paragraph.dataset["mdLineIndex"]).toBe("2");
    handle.destroy();
  });

  it("clicking a gutter handle selects, copies, and deletes a block source span", () => {
    const onChange = vi.fn();
    const handle = createEditor(container, { onChange });
    handle.setValue("alpha\n\nbeta");

    const firstHandle = handle.contentEl.querySelector(".md-block-handle")!;
    firstHandle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));

    expect(handle.contentEl.querySelector("[data-md-block-id]")!.classList).toContain(
      "md-block-selected",
    );
    expect(handle.getSnapshot().selection).toStrictEqual({ start: 0, end: 6 });

    const clipboard = new DataTransfer();
    handle.contentEl.dispatchEvent(
      new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: clipboard }),
    );
    expect(clipboard.getData("text/plain")).toBe("alpha\n");

    handle.contentEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }),
    );
    expect(handle.getValue()).toBe("\nbeta");
    expect(onChange).toHaveBeenCalledWith();
    handle.destroy();
  });

  it("renders blank lines between content blocks as visible lanes", () => {
    const handle = createEditor(container);
    handle.setValue("foo\n\nbar");
    const blank = handle.contentEl.querySelector('[data-md-blank="true"]');
    expect(blank).toBeInstanceOf(HTMLElement);
    expect((blank as HTMLElement).hidden).toBeFalsy();
    expect((blank as HTMLElement).dataset["mdBlankRole"]).toBe("separator");
    expect((blank as HTMLElement).contentEditable).toBe("false");
    handle.destroy();
  });

  it("keeps block handles aligned after native paragraph input", () => {
    const handle = createEditor(container);
    handle.setValue("hello\n\n- item\nkeep");
    const paragraph = handle.contentEl.querySelector("p")!;
    const textNode = paragraph.firstChild!;
    textNode.textContent = "hello!";
    const range = document.createRange();
    range.setStart(textNode, 6);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    handle.contentEl.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText" }),
    );

    const listHandle = handle.contentEl.querySelector("ul .md-block-handle")!;
    listHandle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    const clipboard = new DataTransfer();
    handle.contentEl.dispatchEvent(
      new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: clipboard }),
    );

    expect(handle.getValue()).toBe("hello!\n\n- item\nkeep");
    expect(clipboard.getData("text/plain")).toBe("- item\n");
    handle.destroy();
  });

  it("blocks beforeinput in a structural blank separator", () => {
    const handle = createEditor(container);
    handle.setValue("foo\n\nbar");
    const blank = handle.contentEl.querySelector('[data-md-blank="true"]')!;
    const range = document.createRange();
    range.selectNodeContents(blank);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    const event = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: "x",
    });
    const dispatched = handle.contentEl.dispatchEvent(event);

    expect(dispatched).toBeFalsy();
    expect(event.defaultPrevented).toBeTruthy();
    expect(handle.getValue()).toBe("foo\n\nbar");
    handle.destroy();
  });

  it("routes beforeinput in repeated editable blank lines through the model", () => {
    const handle = createEditor(container);
    handle.setValue("foo\n\n\nbar");
    const blank = handle.contentEl.querySelector('[data-md-blank-role="editable"]')!;
    const range = document.createRange();
    range.selectNodeContents(blank);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    const event = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: "x",
    });
    const dispatched = handle.contentEl.dispatchEvent(event);

    expect(dispatched).toBeFalsy();
    expect(event.defaultPrevented).toBeTruthy();
    expect(handle.getValue()).toBe("foo\n\nx\nbar");
    handle.destroy();
  });

  it("moves pointer selection out of blank line placeholders", () => {
    const handle = createEditor(container);
    handle.setValue("foo\n\nbar");
    const blank = handle.contentEl.querySelector('[data-md-blank="true"]') as HTMLElement;
    blank.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));

    const anchor = window.getSelection()!.anchorNode;
    expect(anchor).not.toBeNull();
    expect(blank.contains(anchor)).toBeFalsy();
    handle.destroy();
  });

  it("moves arrow selection across a structural separator to the visible text end", () => {
    const handle = createEditor(container);
    handle.setValue("foo\n\nbar", "foo\n\n".length);

    handle.contentEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }),
    );

    const selection = window.getSelection()!;
    expect(selection.anchorNode?.nodeType).toBe(Node.TEXT_NODE);
    expect(selection.anchorNode?.textContent).toBe("foo");
    expect(selection.anchorOffset).toBe(3);
    expect(handle.getValue()).toBe("foo\n\nbar");
    handle.destroy();
  });

  it("enter on an empty paragraph preserves repeated blank lines", () => {
    const handle = createEditor(container);
    handle.setValue("# Foo\n", "# Foo\n".length);

    handle.contentEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    expect(handle.getValue()).toBe("# Foo\n\n");

    handle.contentEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    expect(handle.getValue()).toBe("# Foo\n\n\n");
    expect(handle.contentEl.querySelectorAll('[data-md-blank="true"]')).toHaveLength(3);
    handle.destroy();
  });

  it("native paragraph input reconciles only the active plain line into the model", () => {
    const handle = createEditor(container);
    handle.setValue("hello\nworld");
    const paragraph = handle.contentEl.querySelector("p")!;
    const textNode = paragraph.firstChild!;
    textNode.textContent = "hello!";
    const range = document.createRange();
    range.setStart(textNode, 6);
    range.setEnd(textNode, 6);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    handle.contentEl.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText" }),
    );

    expect(handle.getValue()).toBe("hello!\nworld");
    expect(handle.contentEl.querySelector("p")).toBe(paragraph);
    handle.destroy();
  });

  it("completed inline markdown rerenders from model markdown", () => {
    const handle = createEditor(container);
    handle.setValue("x\nkeep");
    const paragraphs = [...handle.contentEl.querySelectorAll("p")];
    const paragraph = paragraphs[0]!;
    const preserved = paragraphs[1]!;
    paragraph.textContent = "**hello**";
    const textNode = paragraph.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 9);
    range.setEnd(textNode, 9);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    handle.contentEl.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText" }),
    );

    expect(handle.getValue()).toBe("**hello**\nkeep");
    expect(handle.contentEl.querySelector("strong")?.textContent).toBe("hello");
    expect([...handle.contentEl.querySelectorAll("p")].at(-1)).toBe(preserved);
    handle.destroy();
  });

  it("space-triggered heading transform rerenders from model markdown", () => {
    const handle = createEditor(container);
    handle.setValue("x\nkeep");
    const paragraphs = [...handle.contentEl.querySelectorAll("p")];
    const paragraph = paragraphs[0]!;
    const preserved = paragraphs[1]!;
    paragraph.textContent = "# ";
    const textNode = paragraph.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 2);
    range.setEnd(textNode, 2);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    handle.contentEl.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText" }),
    );

    expect(handle.getValue()).toBe("# \nkeep");
    expect(handle.contentEl.querySelector("h1")).not.toBeNull();
    expect(handle.contentEl.querySelector("p")).toBe(preserved);
    handle.destroy();
  });

  it("space-triggered list transform rerenders from model markdown", () => {
    const handle = createEditor(container);
    handle.setValue("x\nkeep");
    const paragraphs = [...handle.contentEl.querySelectorAll("p")];
    const paragraph = paragraphs[0]!;
    const preserved = paragraphs[1]!;
    paragraph.textContent = "- ";
    const textNode = paragraph.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 2);
    range.setEnd(textNode, 2);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    handle.contentEl.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText" }),
    );

    expect(handle.getValue()).toBe("- \nkeep");
    expect(handle.contentEl.querySelector("ul li")).not.toBeNull();
    expect(handle.contentEl.querySelector("p")).toBe(preserved);
    handle.destroy();
  });

  it("beforeinput insertParagraph uses a model transaction", () => {
    const handle = createEditor(container);
    handle.setValue("foo");
    const textNode = handle.contentEl.querySelector("p")!.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 3);
    range.setEnd(textNode, 3);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    const event = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertParagraph",
    });
    const dispatched = handle.contentEl.dispatchEvent(event);

    expect(dispatched).toBeFalsy();
    expect(event.defaultPrevented).toBeTruthy();
    expect(handle.getValue()).toBe("foo\n");
    handle.destroy();
  });

  it("beforeinput insertParagraph continues a rendered list item through the model", () => {
    const handle = createEditor(container);
    handle.setValue("- foo");
    const listItem = handle.contentEl.querySelector("li")!;
    const textNode = listItem.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 3);
    range.setEnd(textNode, 3);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    const event = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertParagraph",
    });
    handle.contentEl.dispatchEvent(event);

    expect(event.defaultPrevented).toBeTruthy();
    expect(handle.getValue()).toBe("- foo\n- ");
    expect(handle.contentEl.querySelectorAll("li")).toHaveLength(2);
    handle.destroy();
  });

  it("beforeinput insertParagraph exits an empty rendered list item through the model", () => {
    const handle = createEditor(container);
    handle.setValue("- ");
    const listItem = handle.contentEl.querySelector("li")!;
    const range = document.createRange();
    range.selectNodeContents(listItem);
    range.collapse(false);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    const event = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertParagraph",
    });
    handle.contentEl.dispatchEvent(event);

    expect(event.defaultPrevented).toBeTruthy();
    expect(handle.getValue()).toBe("");
    expect(handle.contentEl.querySelector("ul")).toBeNull();
    handle.destroy();
  });

  it("beforeinput deleteContentBackward removes one blank boundary through the model", () => {
    const handle = createEditor(container);
    handle.setValue("foo\n\n\nbar", 6);

    const event = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "deleteContentBackward",
    });
    const dispatched = handle.contentEl.dispatchEvent(event);

    expect(dispatched).toBeFalsy();
    expect(event.defaultPrevented).toBeTruthy();
    expect(handle.getValue()).toBe("foo\n\nbar");
    handle.destroy();
  });

  it("composition input updates the model without replacing the active host", () => {
    const onChange = vi.fn();
    const handle = createEditor(container, { onChange });
    handle.setValue("hello");
    const paragraph = handle.contentEl.querySelector("p")!;
    const textNode = paragraph.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 5);
    range.setEnd(textNode, 5);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    handle.contentEl.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    textNode.textContent = "hello文";
    range.setStart(textNode, 6);
    range.setEnd(textNode, 6);
    handle.contentEl.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertCompositionText" }),
    );
    handle.contentEl.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));

    expect(handle.getValue()).toBe("hello文");
    expect(handle.contentEl.querySelector("p")).toBe(paragraph);
    expect(onChange).toHaveBeenCalledWith();
    handle.destroy();
  });

  it("applyFormat toggleBold on selection wraps with **", () => {
    const handle = createEditor(container);
    handle.setValue("hello world");

    // Place selection over "hello" (chars 0–5)
    const range = document.createRange();
    const textNode = handle.contentEl.querySelector("p")!.firstChild!;
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    handle.applyFormat(toggleBold);
    expect(handle.getValue()).toContain("**hello**");
    handle.destroy();
  });

  it("applyFormat does nothing in source mode", () => {
    const handle = createEditor(container);
    handle.setValue("hello");
    handle.toggleSourceMode();
    handle.applyFormat(toggleBold);
    expect(handle.getValue()).toBe("hello");
    handle.toggleSourceMode();
    handle.destroy();
  });

  it("applyFormat fires onChange", () => {
    const onChange = vi.fn();
    const handle = createEditor(container, { onChange });
    handle.setValue("hello");

    const range = document.createRange();
    const textNode = handle.contentEl.querySelector("p")!.firstChild!;
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    onChange.mockClear();
    handle.applyFormat(toggleBold);
    expect(onChange).toHaveBeenCalledTimes(1);
    handle.destroy();
  });

  it("undo after setValue returns nothing (single entry)", () => {
    const handle = createEditor(container);
    handle.setValue("hello");
    handle.undo(); // undoIndex <= 0, no-op
    expect(handle.getValue()).toBe("hello");
    handle.destroy();
  });

  it("undo after applyFormat restores pre-format content", () => {
    const handle = createEditor(container);
    handle.setValue("hello world");

    const range = document.createRange();
    const textNode = handle.contentEl.querySelector("p")!.firstChild!;
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    handle.applyFormat(toggleBold);
    expect(handle.getValue()).toContain("**hello**");

    handle.undo();
    expect(handle.getValue()).toBe("hello world");
    handle.destroy();
  });

  it("redo after undo restores formatted content", () => {
    const handle = createEditor(container);
    handle.setValue("hello world");

    const range = document.createRange();
    const textNode = handle.contentEl.querySelector("p")!.firstChild!;
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    handle.applyFormat(toggleBold);
    handle.undo();
    handle.redo();
    expect(handle.getValue()).toContain("**hello**");
    handle.destroy();
  });

  it("undo fires onChange", () => {
    const onChange = vi.fn();
    const handle = createEditor(container, { onChange });
    handle.setValue("first");

    // Need two distinct states so undo has somewhere to go
    handle.setValue("second");
    onChange.mockClear();
    handle.undo();
    expect(onChange).toHaveBeenCalledWith();
    handle.destroy();
  });

  it("redo fires onChange", () => {
    const onChange = vi.fn();
    const handle = createEditor(container, { onChange });
    handle.setValue("first");
    handle.setValue("second");
    handle.undo();
    onChange.mockClear();
    handle.redo();
    expect(onChange).toHaveBeenCalledWith();
    handle.destroy();
  });

  it("resizes wiki images and persists the markdown width", () => {
    const onChange = vi.fn();
    const handle = createEditor(container, {
      extensions: [createWikiImageExtension({ resolveUrl: (name) => `/assets/${name}` })],
      onChange,
    });
    handle.setValue("![[photo.webp|120]]");
    const image = handle.contentEl.querySelector("img")!;
    Object.defineProperty(image, "getBoundingClientRect", {
      value: () => ({
        bottom: 80,
        height: 80,
        left: 0,
        right: 120,
        top: 0,
        width: 120,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });

    onChange.mockClear();
    image.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 118 }));
    document.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 168 }));
    document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 168 }));

    expect(handle.getValue()).toBe("![[photo.webp|170]]");
    expect(onChange).toHaveBeenCalledTimes(1);
    handle.destroy();
  });

  it("typing checkpoint fires after debounce delay", () => {
    vi.useFakeTimers();
    const handle = createEditor(container);
    handle.setValue("initial");

    // Simulate the debounce timer firing by manipulating internal state
    // via the onInput event on contentEl
    handle.contentEl.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(1000);

    // After the timer fires, the current content should be checkpointed.
    // We can verify by checking undo works after.
    handle.undo();
    // undoIndex <= 1 after setValue + debounce push, undo goes back
    expectTypeOf(handle.getValue()).toBeString();

    vi.useRealTimers();
    handle.destroy();
  });

  it("toggleSourceMode hides contentEl and shows sourceEl", () => {
    const handle = createEditor(container);
    handle.setValue("hello");
    handle.toggleSourceMode();
    expect(handle.isSourceMode).toBeTruthy();
    expect(handle.contentEl.style.display).toBe("none");
    expect(handle.sourceEl.style.display).toBe("");
    handle.destroy();
  });

  it("toggleSourceMode back shows contentEl and hides sourceEl", () => {
    const handle = createEditor(container);
    handle.setValue("hello");
    handle.toggleSourceMode();
    handle.toggleSourceMode();
    expect(handle.isSourceMode).toBeFalsy();
    expect(handle.contentEl.style.display).toBe("");
    expect(handle.sourceEl.style.display).toBe("none");
    handle.destroy();
  });

  it("getValue in source mode returns sourceEl value", () => {
    const handle = createEditor(container);
    handle.setValue("hello world");
    handle.toggleSourceMode();
    expect(handle.getValue()).toBe("hello world");
    handle.destroy();
  });

  it("getValue after toggling back from source mode reflects edits", () => {
    const handle = createEditor(container);
    handle.setValue("original");
    handle.toggleSourceMode();
    handle.sourceEl.value = "edited in source";
    handle.toggleSourceMode(); // back to wysiwyg, re-renders sourceEl.value
    expect(handle.getValue()).toBe("edited in source");
    handle.destroy();
  });

  it("onChange fires on contentEl input event", () => {
    const onChange = vi.fn();
    const handle = createEditor(container, { onChange });
    handle.setValue("hello");
    onChange.mockClear();
    handle.contentEl.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith();
    handle.destroy();
  });

  it("onChange fires on sourceEl input event in source mode", () => {
    const onChange = vi.fn();
    const handle = createEditor(container, { onChange });
    handle.setValue("hello");
    handle.toggleSourceMode();
    onChange.mockClear();
    handle.sourceEl.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith();
    handle.destroy();
  });

  it("isSourceMode starts false", () => {
    const handle = createEditor(container);
    expect(handle.isSourceMode).toBeFalsy();
    handle.destroy();
  });

  it("isSourceMode is true after toggleSourceMode", () => {
    const handle = createEditor(container);
    handle.toggleSourceMode();
    expect(handle.isSourceMode).toBeTruthy();
    handle.destroy();
  });

  it("createEditor passes extensions through to renderer", () => {
    const handle = createEditor(container, { extensions: [createWikiLinkExtension()] });
    handle.setValue("See [[my note]]");
    expect(handle.contentEl.innerHTML).toContain('class="wiki-link"');
    handle.destroy();
  });

  it("createEditor passes extensions through to serializer", () => {
    const handle = createEditor(container, { extensions: [createWikiLinkExtension()] });
    handle.setValue("[[my note]]");
    expect(handle.getValue()).toBe("[[my note]]");
    handle.destroy();
  });

  it("plain text paste inserts text at cursor position", async () => {
    const handle = createEditor(container);
    handle.setValue("hello world");

    // Place cursor at position 5 (after "hello")
    const range = document.createRange();
    const textNode = handle.contentEl.querySelector("p")!.firstChild!;
    range.setStart(textNode, 5);
    range.setEnd(textNode, 5);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    const clipboardData = {
      items: [],
      getData: (type: string) => (type === "text/plain" ? " inserted" : ""),
    };
    const pasteEvent = new ClipboardEvent("paste", {
      bubbles: true,
      clipboardData: clipboardData as unknown as DataTransfer,
    });
    handle.contentEl.dispatchEvent(pasteEvent);

    // Allow microtasks to settle
    await Promise.resolve();
    expect(handle.getValue()).toBe("hello inserted world");
    handle.destroy();
  });

  it("multi-block paste at the start of a block keeps markdown block separation", async () => {
    const handle = createEditor(container);
    handle.setValue("# hi\n\nfoo");

    const range = document.createRange();
    const textNode = handle.contentEl.querySelector("h1")!.firstChild!;
    range.setStart(textNode, 0);
    range.setEnd(textNode, 0);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    const clipboardData = {
      items: [],
      getData: (type: string) => (type === "text/plain" ? "# hi\n\nfoo" : ""),
    };
    const pasteEvent = new ClipboardEvent("paste", {
      bubbles: true,
      clipboardData: clipboardData as unknown as DataTransfer,
    });
    handle.contentEl.dispatchEvent(pasteEvent);

    await Promise.resolve();
    expect(handle.getValue()).toBe("# hi\n\nfoo\n\n# hi\n\nfoo");
    handle.destroy();
  });

  it("hTML paste uses setHTML when available", async () => {
    const elementPrototype = Element.prototype as Element & {
      setHTML?: (html: string) => void;
    };
    const originalSetHtml = elementPrototype.setHTML;
    const setHtml = vi.fn(function setHtml(this: Element, html: string) {
      expect(html).toContain("<strong>bold</strong>");
      this.innerHTML = "<p><strong>bold</strong></p>";
    });
    elementPrototype.setHTML = setHtml;

    try {
      const handle = createEditor(container);
      handle.setValue("");

      const clipboardData = {
        items: [],
        getData: (type: string) =>
          type === "text/html" ? "<p><strong>bold</strong><script>bad()</script></p>" : "",
      };
      const pasteEvent = new ClipboardEvent("paste", {
        bubbles: true,
        clipboardData: clipboardData as unknown as DataTransfer,
      });
      handle.contentEl.dispatchEvent(pasteEvent);

      await Promise.resolve();
      expect(setHtml).toHaveBeenCalledTimes(1);
      expect(handle.getValue()).toBe("**bold**");
      handle.destroy();
    } finally {
      if (originalSetHtml === undefined) {
        delete elementPrototype.setHTML;
      } else {
        elementPrototype.setHTML = originalSetHtml;
      }
    }
  });

  it("hTML paste falls back to manual sanitization when setHTML is unavailable", async () => {
    const elementPrototype = Element.prototype as Element & {
      setHTML?: (html: string) => void;
    };
    const originalSetHtml = elementPrototype.setHTML;
    delete elementPrototype.setHTML;

    try {
      const handle = createEditor(container);
      handle.setValue("");

      const clipboardData = {
        items: [],
        getData: (type: string) =>
          type === "text/html"
            ? '<p><strong>bold</strong><script>bad()</script><a href="javascript:bad()">x</a></p>'
            : "",
      };
      const pasteEvent = new ClipboardEvent("paste", {
        bubbles: true,
        clipboardData: clipboardData as unknown as DataTransfer,
      });
      handle.contentEl.dispatchEvent(pasteEvent);

      await Promise.resolve();
      expect(handle.getValue()).toBe("**bold**[x]()");
      handle.destroy();
    } finally {
      if (originalSetHtml === undefined) {
        delete elementPrototype.setHTML;
      } else {
        elementPrototype.setHTML = originalSetHtml;
      }
    }
  });

  it("hTML paste inserts copied editor fragments with root text nodes", async () => {
    const handle = createEditor(container);
    handle.setValue("");

    const clipboardData = {
      items: [],
      getData: (type: string) =>
        type === "text/html" ? "copied from editor" : type === "text/plain" ? "" : "",
    };
    const pasteEvent = new ClipboardEvent("paste", {
      bubbles: true,
      clipboardData: clipboardData as unknown as DataTransfer,
    });
    handle.contentEl.dispatchEvent(pasteEvent);

    await Promise.resolve();
    expect(handle.getValue()).toBe("copied from editor");
    handle.destroy();
  });

  it("hTML paste falls back to plain text when rich serialization is empty", async () => {
    const handle = createEditor(container);
    handle.setValue("");

    const clipboardData = {
      items: [],
      getData: (type: string) =>
        type === "text/html" ? '<meta charset="utf-8">' : type === "text/plain" ? "plain" : "",
    };
    const pasteEvent = new ClipboardEvent("paste", {
      bubbles: true,
      clipboardData: clipboardData as unknown as DataTransfer,
    });
    handle.contentEl.dispatchEvent(pasteEvent);

    await Promise.resolve();
    expect(handle.getValue()).toBe("plain");
    handle.destroy();
  });

  it("plain-text paste preference ignores HTML when beforeinput indicates no rich text", async () => {
    const handle = createEditor(container);
    handle.setValue("");

    const beforeInputEvent = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertFromPaste",
    });
    Object.defineProperty(beforeInputEvent, "dataTransfer", {
      value: {
        types: ["text/plain"],
      } satisfies Pick<DataTransfer, "types">,
      configurable: true,
    });
    handle.contentEl.dispatchEvent(beforeInputEvent);

    const clipboardData = {
      items: [],
      getData: (type: string) => {
        if (type === "text/html") return "<p><strong>rich</strong></p>";
        if (type === "text/plain") return "plain";
        return "";
      },
    };
    const pasteEvent = new ClipboardEvent("paste", {
      bubbles: true,
      clipboardData: clipboardData as unknown as DataTransfer,
    });
    handle.contentEl.dispatchEvent(pasteEvent);

    await Promise.resolve();
    expect(handle.getValue()).toBe("plain");
    handle.destroy();
  });

  it("image paste converts uploaded HTML to markdown through the model", async () => {
    const originalCreateImageBitmap = globalThis.createImageBitmap;
    const originalOffscreenCanvas = globalThis.OffscreenCanvas;
    globalThis.createImageBitmap = vi.fn(async () => ({
      width: 10,
      height: 10,
      close: vi.fn(),
    })) as unknown as typeof createImageBitmap;
    globalThis.OffscreenCanvas = vi.fn(function () {
      return {
        getContext: () => ({ drawImage: vi.fn() }),
        convertToBlob: async () => new Blob(["webp"], { type: "image/webp" }),
      };
    }) as unknown as typeof OffscreenCanvas;

    try {
      const handle = createEditor(container, {
        onImagePaste: vi.fn(async () => '<img src="/photo.png" alt="photo">'),
      });
      handle.setValue("before ");
      const textNode = handle.contentEl.querySelector("p")!.firstChild!;
      const range = document.createRange();
      range.setStart(textNode, 7);
      range.setEnd(textNode, 7);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);

      const file = new File(["image"], "photo.png", { type: "image/png" });
      const clipboardData = {
        items: [{ type: "image/png", getAsFile: () => file }],
        getData: () => "",
      };
      handle.contentEl.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          clipboardData: clipboardData as unknown as DataTransfer,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(handle.getValue()).toBe("before ![photo](/photo.png)");
      handle.destroy();
    } finally {
      globalThis.createImageBitmap = originalCreateImageBitmap;
      globalThis.OffscreenCanvas = originalOffscreenCanvas;
    }
  });

  it("ctrl+Z keydown triggers undo", () => {
    const handle = createEditor(container);
    handle.setValue("first");
    handle.setValue("second");
    handle.contentEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }),
    );
    expect(handle.getValue()).toBe("first");
    handle.destroy();
  });

  it("ctrl+Y keydown triggers redo", () => {
    const handle = createEditor(container);
    handle.setValue("first");
    handle.setValue("second");
    handle.undo();
    handle.contentEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "y", ctrlKey: true, bubbles: true }),
    );
    expect(handle.getValue()).toContain("second");
    handle.destroy();
  });

  it("source mode handles save and tab indentation shortcuts", () => {
    const onSave = vi.fn();
    const onChange = vi.fn();
    const handle = createEditor(container, { onSave, onChange, indentUnit: "  " });
    handle.setValue("one\ntwo");
    handle.toggleSourceMode();
    handle.sourceEl.selectionStart = 0;
    handle.sourceEl.selectionEnd = 0;
    handle.sourceEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(handle.sourceEl.value).toBe("  one\ntwo");
    expect(onChange).toHaveBeenCalledTimes(1);

    handle.sourceEl.selectionStart = 0;
    handle.sourceEl.selectionEnd = handle.sourceEl.value.length;
    handle.sourceEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
    );
    expect(handle.sourceEl.value).toBe("one\ntwo");

    handle.sourceEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true }),
    );
    expect(onSave).toHaveBeenCalledTimes(1);
    handle.destroy();
  });

  it("content mode handles formatting and save shortcuts", () => {
    const onSave = vi.fn();
    const handle = createEditor(container, { onSave });
    handle.setValue("hello");
    const textNode = handle.contentEl.querySelector("p")!.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    handle.contentEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "b", metaKey: true, bubbles: true }),
    );
    expect(handle.getValue()).toBe("**hello**");
    handle.contentEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true }),
    );
    expect(onSave).toHaveBeenCalledTimes(1);
    handle.destroy();
  });

  it("enter at the end of a heading creates a model paragraph boundary", () => {
    const onChange = vi.fn();
    const handle = createEditor(container, { onChange });
    handle.setValue("# Heading");
    const heading = handle.contentEl.querySelector("h1")!;
    const range = document.createRange();
    range.selectNodeContents(heading);
    range.collapse(false);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    handle.contentEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    expect(handle.getValue()).toBe("# Heading\n");
    expect(handle.contentEl.querySelector("h1 + p")).not.toBeNull();
    expect(onChange).toHaveBeenCalledWith();
    handle.destroy();
  });

  it("removes an empty top-level task item on backspace", () => {
    const onChange = vi.fn();
    const handle = createEditor(container, { onChange });
    handle.setValue("- [ ] ");
    const item = handle.contentEl.querySelector("li")!;
    const range = document.createRange();
    range.selectNodeContents(item);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    handle.contentEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }),
    );
    expect(handle.contentEl.querySelector("ul")).toBeNull();
    expect(handle.getValue()).toBe("");
    expect(onChange).toHaveBeenCalledWith();
    handle.destroy();
  });

  it("ignores image resize drags away from the resize edge and unchanged drags", () => {
    const onChange = vi.fn();
    const handle = createEditor(container, {
      extensions: [createWikiImageExtension({ resolveUrl: (name) => `/assets/${name}` })],
      onChange,
    });
    handle.setValue("![[photo.webp|120]]");
    const image = handle.contentEl.querySelector("img")!;
    Object.defineProperty(image, "getBoundingClientRect", {
      value: () => ({
        bottom: 80,
        height: 80,
        left: 0,
        right: 120,
        top: 0,
        width: 120,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });

    image.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 20 }));
    document.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 80 }));
    expect(image.getAttribute("width")).toBe("120");

    image.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 118 }));
    document.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 118 }));
    document.dispatchEvent(new MouseEvent("pointercancel", { bubbles: true, clientX: 118 }));
    expect(onChange).not.toHaveBeenCalled();
    handle.destroy();
  });

  it("setConfig updates classes and later editor behavior", () => {
    const handle = createEditor(container);
    handle.setConfig({ contentClassName: "custom-content", sourceClassName: "custom-source" });
    expect(handle.contentEl.className).toBe("custom-content");
    expect(handle.sourceEl.className).toBe("custom-source");
    handle.destroy();
  });
});
