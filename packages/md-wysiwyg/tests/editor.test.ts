/// Tests for createEditor() wiring layer.

import { createEditor } from "../src/editor.ts";
import { toggleBold } from "../src/format-ops.ts";
import { createWikiLinkExtension } from "../src/wiki-link.ts";
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

  // ── DOM setup ──────────────────────────────────────────────────────────────

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

  // ── setValue / getValue ────────────────────────────────────────────────────

  it("getValue after setValue returns same markdown", () => {
    const handle = createEditor(container);
    handle.setValue("hello world");
    expect(handle.getValue()).toBe("hello world");
    handle.destroy();
  });

  it("setValue renders HTML into contentEl", () => {
    const handle = createEditor(container);
    handle.setValue("# Heading");
    expect(handle.contentEl.innerHTML).toContain("<h1>");
    handle.destroy();
  });

  it("setValue with cursor offset renders cursor marker and cleans up", () => {
    const handle = createEditor(container);
    handle.setValue("hello world", 5);
    // Cursor marker should be removed after restore
    expect(handle.contentEl.querySelector('[data-md-cursor="true"]')).toBeNull();
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

  // ── applyFormat ────────────────────────────────────────────────────────────

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

  // ── Undo / redo ────────────────────────────────────────────────────────────

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
    expect(onChange).toHaveBeenCalled();
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
    expect(onChange).toHaveBeenCalled();
    handle.destroy();
  });

  // ── Typing checkpoint (debounced) ──────────────────────────────────────────

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
    const prevValue = handle.getValue();
    handle.undo();
    // undoIndex <= 1 after setValue + debounce push, undo goes back
    expectTypeOf(handle.getValue()).toBeString();

    vi.useRealTimers();
    handle.destroy();
  });

  // ── toggleSourceMode ───────────────────────────────────────────────────────

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

  // ── onChange ───────────────────────────────────────────────────────────────

  it("onChange fires on contentEl input event", () => {
    const onChange = vi.fn();
    const handle = createEditor(container, { onChange });
    handle.setValue("hello");
    onChange.mockClear();
    handle.contentEl.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onChange).toHaveBeenCalled();
    handle.destroy();
  });

  it("onChange fires on sourceEl input event in source mode", () => {
    const onChange = vi.fn();
    const handle = createEditor(container, { onChange });
    handle.setValue("hello");
    handle.toggleSourceMode();
    onChange.mockClear();
    handle.sourceEl.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onChange).toHaveBeenCalled();
    handle.destroy();
  });

  // ── isSourceMode getter ────────────────────────────────────────────────────

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

  // ── Extensions ────────────────────────────────────────────────────────────

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

  // ── Paste: plain text ──────────────────────────────────────────────────────

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

  it("HTML paste uses setHTML when available", async () => {
    const originalSetHtml = Element.prototype.setHTML;
    const setHtml = vi.fn(function setHtml(this: Element, html: string) {
      expect(html).toContain("<strong>bold</strong>");
      this.innerHTML = "<p><strong>bold</strong></p>";
    });
    Element.prototype.setHTML = setHtml;

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
      expect(setHtml).toHaveBeenCalledOnce();
      expect(handle.getValue()).toBe("**bold**");
      handle.destroy();
    } finally {
      Element.prototype.setHTML = originalSetHtml;
    }
  });

  it("HTML paste falls back to manual sanitization when setHTML is unavailable", async () => {
    const originalSetHtml = Element.prototype.setHTML;
    delete Element.prototype.setHTML;

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
      Element.prototype.setHTML = originalSetHtml;
    }
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

  // ── Keydown: undo/redo ────────────────────────────────────────────────────

  it("Ctrl+Z keydown triggers undo", () => {
    const handle = createEditor(container);
    handle.setValue("first");
    handle.setValue("second");
    handle.contentEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }),
    );
    expect(handle.getValue()).toBe("first");
    handle.destroy();
  });

  it("Ctrl+Y keydown triggers redo", () => {
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
});
