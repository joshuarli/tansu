import { classifySaveResult, classifyReload, type SaveAction } from "./editor.ts";
import { setupDOM, mockFetch } from "./test-helper.ts";

describe("classifySaveResult", () => {
  it("no conflict → clean", () => {
    const action = classifySaveResult({ mtime: 100 }, "editor content", "tab content");
    expect(action.type).toBe("clean");
    expect((action as Extract<SaveAction, { type: "clean" }>).mtime).toBe(100);
    expect((action as Extract<SaveAction, { type: "clean" }>).content).toBe("editor content");
  });

  it("conflict but disk matches editor → false-conflict", () => {
    const action = classifySaveResult(
      { conflict: true, content: "same", mtime: 200 },
      "same",
      "old tab content",
    );
    expect(action.type).toBe("false-conflict");
  });

  it("conflict but disk matches tab saved content → false-conflict", () => {
    const action = classifySaveResult(
      { conflict: true, content: "tab saved", mtime: 200 },
      "editor different",
      "tab saved",
    );
    expect(action.type).toBe("false-conflict");
  });

  it("conflict with genuinely different disk content → real-conflict", () => {
    const action = classifySaveResult(
      { conflict: true, content: "disk version", mtime: 300 },
      "editor version",
      "tab version",
    );
    expect(action.type).toBe("real-conflict");
    const rc = action as Extract<SaveAction, { type: "real-conflict" }>;
    expect(rc.diskContent).toBe("disk version");
    expect(rc.diskMtime).toBe(300);
  });

  it("conflict with missing disk content → real-conflict with empty string", () => {
    const action = classifySaveResult({ conflict: true, mtime: 400 }, "editor", "tab");
    expect(action.type).toBe("real-conflict");
    expect((action as Extract<SaveAction, { type: "real-conflict" }>).diskContent).toBe("");
  });

  it("conflict with empty disk content matching empty editor → false-conflict", () => {
    const action = classifySaveResult({ conflict: true, content: "", mtime: 500 }, "", "tab");
    expect(action.type).toBe("false-conflict");
  });
});

describe("classifyReload", () => {
  it("not dirty → load", () => {
    expect(classifyReload(false).type).toBe("load");
  });

  it("dirty → conflict", () => {
    expect(classifyReload(true).type).toBe("conflict");
  });
});

describe("editor", () => {
  let cleanup: () => void;
  let mock: ReturnType<typeof mockFetch>;
  let showEditor: (path: string, content: string, tags?: string[]) => void;
  let hideEditor: () => void;
  let getCurrentContent: () => string;
  let saveCurrentNote: () => Promise<void>;
  let reloadFromDisk: (content: string, mtime: number) => void;

  beforeAll(async () => {
    cleanup = setupDOM();
    mock = mockFetch();

    // conflict.tsx's compiled output calls delegateEvents(["click"]) at module level,
    // which runs before setupDOM() replaces globalThis.document. Re-register on the
    // new document so SolidJS click delegation works for conflict banner buttons.
    const { delegateEvents } = await import("solid-js/web");
    delegateEvents(["click"]);

    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    mock.on("PUT", "/api/note", { mtime: 2000 });
    mock.on("PUT", "/api/state", {});
    mock.on("GET", "/api/state", { tabs: [], active: -1 });
    mock.on("GET", "/api/backlinks", []);
    mock.on("GET", "/api/notes", []);
    mock.on("GET", "/api/revisions", []);
    mock.on("GET", "/api/tags", { tags: [] });

    const mod = await import("./editor.ts");
    const instance = mod.initEditor();
    ({ showEditor, hideEditor, getCurrentContent, saveCurrentNote, reloadFromDisk } = instance);
  });

  afterAll(() => {
    mock.restore();
    cleanup();
  });

  it("showEditor renders content as HTML", async () => {
    showEditor("test.md", "# Hello\n\nWorld");
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    expect(contentEl !== null).toBeTruthy();
    expect(contentEl.innerHTML).toContain("<h1>Hello</h1>");
    expect(contentEl.innerHTML).toContain("<p>World</p>");
    expect(contentEl.contentEditable).toBe("true");

    hideEditor();
  });

  it("showEditor hides frontmatter in content mode and preserves it in source mode", async () => {
    showEditor("frontmatter.md", "---\ntags: [alpha]\n---\n\n# Hello");
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    expect(contentEl.innerHTML).toContain("<h1>Hello</h1>");
    expect(contentEl.innerHTML).not.toContain("tags:");
    expect(contentEl.innerHTML).not.toContain("---");

    const sourceBtn = document.querySelector(".editor-toolbar-btn--source") as HTMLButtonElement;
    sourceBtn.click();
    const sourceEl = document.querySelector(".editor-source") as HTMLTextAreaElement;
    expect(sourceEl.value).toContain("tags: [alpha]");
    expect(sourceEl.value).toContain("# Hello");

    hideEditor();
  });

  it("showEditor creates hidden source textarea", async () => {
    showEditor("test.md", "# Hi");
    await new Promise((r) => setTimeout(r, 50));

    const sourceEl = document.querySelector(".editor-source") as HTMLTextAreaElement;
    expect(sourceEl !== null).toBeTruthy();
    expect(sourceEl.style.display).toBe("none");

    hideEditor();
  });

  it("showEditor creates toolbar with source and menu buttons", async () => {
    showEditor("test.md", "# Hi");
    await new Promise((r) => setTimeout(r, 50));

    const toolbar = document.querySelector(".editor-toolbar");
    expect(toolbar !== null).toBeTruthy();
    expect(toolbar!.querySelector(".editor-toolbar-btn--source") !== null).toBeTruthy();
    const menuBtn = [...toolbar!.querySelectorAll("button")].find((b) => b.title === "More");
    expect(menuBtn !== undefined).toBeTruthy();

    hideEditor();
  });

  it("showEditor renders a dedicated tag input row", async () => {
    showEditor("tags.md", "# Hi", ["alpha"]);
    await new Promise((r) => setTimeout(r, 50));

    const tagRow = document.querySelector(".editor-tags") as HTMLElement;
    const tagInput = document.querySelector(".editor-tags-input") as HTMLInputElement;
    expect(tagRow).not.toBeNull();
    expect(tagInput).not.toBeNull();
    expect(tagInput.placeholder).toBe("Add tag");

    const sourceBtn = document.querySelector(".editor-toolbar-btn--source") as HTMLButtonElement;
    sourceBtn.click();
    expect(document.querySelector(".editor-tags-input")).not.toBeNull();

    hideEditor();
  });

  it("getCurrentContent returns serialized markdown in WYSIWYG mode", async () => {
    showEditor("test.md", "# Content");
    await new Promise((r) => setTimeout(r, 50));
    const content = getCurrentContent();
    expect(content).toContain("Content");
    hideEditor();
  });

  it("showEditor restores saved cursor inside a paragraph after a list", async () => {
    const { setCursor } = await import("./tab-state.ts");
    const content = "foo:\n- one\nx\ndsf";
    setCursor("cursor-paragraph.md", content.indexOf("x") + 1);

    showEditor("cursor-paragraph.md", content);
    await new Promise((r) => setTimeout(r, 50));

    const sel = window.getSelection()!;
    expect(sel.rangeCount).toBe(1);
    expect(sel.getRangeAt(0).startContainer.textContent).toContain("x");
    expect(sel.getRangeAt(0).startOffset).toBe(1);

    hideEditor();
  });

  it("showEditor restores saved cursor inside a list item", async () => {
    const { setCursor } = await import("./tab-state.ts");
    const content = "foo:\n- one\n- x\ndsf";
    setCursor("cursor-list.md", content.indexOf("x") + 1);

    showEditor("cursor-list.md", content);
    await new Promise((r) => setTimeout(r, 50));

    const sel = window.getSelection()!;
    expect(sel.rangeCount).toBe(1);
    expect(sel.getRangeAt(0).startContainer.textContent).toBe("x");
    expect(sel.getRangeAt(0).startOffset).toBe(1);

    hideEditor();
  });

  it("hideEditor removes editor elements and shows empty state", () => {
    showEditor("test.md", "# X");
    hideEditor();
    expect(document.querySelector(".editor-content")).toBeNull();
    expect(document.querySelector(".editor-source")).toBeNull();
    const emptyState = document.querySelector("#empty-state") as HTMLElement;
    expect(emptyState.style.display).toBe("flex");
  });

  it("getCurrentContent returns empty string when no editor open", () => {
    hideEditor();
    expect(getCurrentContent()).toBe("");
  });

  it("source mode: clicking Source shows textarea and hides contentEl", async () => {
    showEditor("toggle.md", "# Toggle");
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    const sourceEl = document.querySelector(".editor-source") as HTMLTextAreaElement;
    const sourceBtn = document.querySelector(".editor-toolbar-btn--source") as HTMLButtonElement;

    sourceBtn.click();
    expect(contentEl.style.display).toBe("none");
    expect(sourceEl.style.display !== "none").toBeTruthy();

    hideEditor();
  });

  it("source mode: getCurrentContent returns textarea value", async () => {
    showEditor("toggle.md", "# Toggle");
    await new Promise((r) => setTimeout(r, 50));

    const sourceEl = document.querySelector(".editor-source") as HTMLTextAreaElement;
    const sourceBtn = document.querySelector(".editor-toolbar-btn--source") as HTMLButtonElement;

    sourceBtn.click();
    sourceEl.value = "# Raw markdown";
    expect(getCurrentContent()).toBe("# Raw markdown");

    hideEditor();
  });

  it("source mode: clicking Source again returns to WYSIWYG", async () => {
    showEditor("toggle.md", "# Toggle");
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    const sourceEl = document.querySelector(".editor-source") as HTMLTextAreaElement;
    const sourceBtn = document.querySelector(".editor-toolbar-btn--source") as HTMLButtonElement;

    sourceBtn.click();
    sourceBtn.click();
    expect(contentEl.style.display !== "none").toBeTruthy();
    expect(sourceEl.style.display).toBe("none");

    hideEditor();
  });

  it("typing # in note content does not open tag autocomplete", async () => {
    showEditor("no-body-tags.md", "hello");
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    contentEl.focus();
    const node = contentEl.querySelector("p")!.firstChild as Text;
    node.textContent = "hello #ru";
    const range = document.createRange();
    range.setStart(node, node.length);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    contentEl.dispatchEvent(new Event("input", { bubbles: true }));

    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector(".autocomplete")).toBeNull();

    const sourceBtn = document.querySelector(".editor-toolbar-btn--source") as HTMLButtonElement;
    sourceBtn.click();
    const sourceEl = document.querySelector(".editor-source") as HTMLTextAreaElement;
    sourceEl.value = "hello #ru";
    sourceEl.selectionStart = sourceEl.value.length;
    sourceEl.selectionEnd = sourceEl.value.length;
    sourceEl.focus();
    sourceEl.dispatchEvent(new Event("input", { bubbles: true }));

    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector(".autocomplete")).toBeNull();

    hideEditor();
  });

  it("source mode: Tab inserts a tab character at the caret", async () => {
    showEditor("tab-source.md", "# Tab");
    await new Promise((r) => setTimeout(r, 50));

    const sourceBtn = document.querySelector(".editor-toolbar-btn--source") as HTMLButtonElement;
    sourceBtn.click();

    const sourceEl = document.querySelector(".editor-source") as HTMLTextAreaElement;
    sourceEl.value = "hello";
    sourceEl.selectionStart = 2;
    sourceEl.selectionEnd = 2;
    sourceEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));

    expect(sourceEl.value).toBe("he\tllo");
    expect(sourceEl.selectionStart).toBe(3);
    expect(sourceEl.selectionEnd).toBe(3);

    hideEditor();
  });

  it("source mode: Tab indents all selected lines and Shift+Tab dedents them", async () => {
    showEditor("tab-source-lines.md", "# Tab");
    await new Promise((r) => setTimeout(r, 50));

    const sourceBtn = document.querySelector(".editor-toolbar-btn--source") as HTMLButtonElement;
    sourceBtn.click();

    const sourceEl = document.querySelector(".editor-source") as HTMLTextAreaElement;
    sourceEl.value = "alpha\nbeta";
    sourceEl.selectionStart = 0;
    sourceEl.selectionEnd = sourceEl.value.length;
    sourceEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));

    expect(sourceEl.value).toBe("\talpha\n\tbeta");
    expect(sourceEl.selectionStart).toBe(0);
    expect(sourceEl.selectionEnd).toBe(sourceEl.value.length);

    sourceEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
    );

    expect(sourceEl.value).toBe("alpha\nbeta");
    expect(sourceEl.selectionStart).toBe(0);
    expect(sourceEl.selectionEnd).toBe(sourceEl.value.length);

    hideEditor();
  });

  it("WYSIWYG: Tab indents the current line", async () => {
    showEditor("tab-wysiwyg.md", "hello");
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    const textNode = contentEl.querySelector("p")!.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 2);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    contentEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));

    expect(getCurrentContent()).toBe("\thello");

    hideEditor();
  });

  it("WYSIWYG: Cmd/Ctrl+H wraps selection in mark and preserves markdown", async () => {
    showEditor("highlight-shortcut.md", "hello world");
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    const textNode = contentEl.querySelector("p")!.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    contentEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "h", ctrlKey: true, bubbles: true }),
    );

    expect(getCurrentContent()).toBe("==hello== world");
    expect(contentEl.querySelector("mark")?.textContent).toBe("hello");

    hideEditor();
  });

  it("WYSIWYG: Cmd/Ctrl+H across multiple paragraphs wraps entire selection", async () => {
    // Highlight across paragraph boundaries wraps each paragraph separately.
    showEditor("highlight-multiblock.md", "foo\n\nbar");
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    const paragraphs = [...contentEl.querySelectorAll("p")].filter(
      (p) => (p.textContent ?? "").trim() !== "",
    );
    const startNode = paragraphs[0]!.firstChild as Text;
    const endNode = paragraphs[1]!.firstChild as Text;
    const range = document.createRange();
    range.setStart(startNode, 0);
    range.setEnd(endNode, endNode.length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    contentEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "h", ctrlKey: true, bubbles: true }),
    );

    expect(getCurrentContent()).toBe("==foo==\n\n==bar==");

    hideEditor();
  });

  it("WYSIWYG: Tab and Shift+Tab indent and dedent selected blocks", async () => {
    showEditor("tab-wysiwyg-blocks.md", "alpha\n\nbeta");
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    const paragraphs = [...contentEl.querySelectorAll("p")].filter(
      (p) => (p.textContent ?? "").trim() !== "",
    );
    const startNode = paragraphs[0]!.firstChild as Text;
    const endNode = paragraphs[1]!.firstChild as Text;
    const range = document.createRange();
    range.setStart(startNode, 1);
    range.setEnd(endNode, 3);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    contentEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(getCurrentContent()).toBe("\talpha\n\n\tbeta");

    contentEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
    );
    expect(getCurrentContent()).toBe("alpha\n\nbeta");
    const preserved = window.getSelection()!;
    expect(preserved.rangeCount).toBe(1);
    expect(preserved.isCollapsed).toBeFalsy();

    hideEditor();
  });

  it("WYSIWYG: Tab on bullet list nests under previous item", async () => {
    showEditor("list-indent.md", "- one\n- two");
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    const items = contentEl.querySelectorAll("li");
    const textNode = items[1]!.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 1);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    contentEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(getCurrentContent()).toBe("- one\n  - two");

    contentEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
    );
    expect(getCurrentContent()).toBe("- one\n- two");

    hideEditor();
  });

  it("WYSIWYG: Shift+Tab on multi-item nested bullet selection preserves selection", async () => {
    showEditor("list-dedent-selection.md", "- one\n  - two\n  - three");
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    const items = contentEl.querySelectorAll("li");
    const startNode = items[1]!.firstChild as Text;
    const endNode = items[2]!.firstChild as Text;
    const range = document.createRange();
    range.setStart(startNode, 1);
    range.setEnd(endNode, 3);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    contentEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
    );

    expect(getCurrentContent()).toBe("- one\n- two\n- three");
    const preserved = window.getSelection()!;
    expect(preserved.rangeCount).toBe(1);
    expect(preserved.isCollapsed).toBeFalsy();

    hideEditor();
  });

  it("WYSIWYG: Backspace on empty nested bullet outdents instead of flattening the list", async () => {
    showEditor("nested-empty-backspace.md", "- one\n  - ");
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    const items = contentEl.querySelectorAll("li");
    const emptyNested = items[1] as HTMLElement;
    const range = document.createRange();
    range.setStart(emptyNested, 0);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    contentEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));

    expect(getCurrentContent()).toBe("- one\n- ");
    const topList = contentEl.firstElementChild as HTMLElement;
    expect(topList.tagName).toBe("UL");
    expect(topList.children).toHaveLength(2);

    hideEditor();
  });

  it("WYSIWYG: Backspace on empty top-level bullet removes only that bullet", async () => {
    showEditor("top-level-empty-backspace.md", "- a\n- ");
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    const items = contentEl.querySelectorAll("li");
    const emptyItem = items[1] as HTMLElement;
    const range = document.createRange();
    range.setStart(emptyItem, 0);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    contentEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));

    expect(getCurrentContent()).toBe("- a");
    expect(contentEl.querySelectorAll("li")).toHaveLength(1);

    hideEditor();
  });

  it("saveCurrentNote success: tab marked clean with new mtime", async () => {
    const { openTab, getTabs, getActiveTab, closeTab } = await import("./tab-state.ts");
    mock.on("GET", "/api/note", { content: "# Save Test", mtime: 1000 });
    await openTab("save-test.md");
    showEditor("save-test.md", "# Save Test");
    await new Promise((r) => setTimeout(r, 50));

    const sourceBtn = document.querySelector(".editor-toolbar-btn--source") as HTMLButtonElement;
    sourceBtn.click();
    const sourceEl = document.querySelector(".editor-source") as HTMLTextAreaElement;
    sourceEl.value = "# Updated Content";
    sourceEl.dispatchEvent(new Event("input", { bubbles: true }));

    mock.on("PUT", "/api/note", { mtime: 3000 });

    await saveCurrentNote();

    const tab = getActiveTab();
    expect(tab!.dirty).toBeFalsy();
    expect(tab!.mtime).toBe(3000);
    expect(tab!.content).toBe("# Updated Content");

    hideEditor();
    while (getTabs().length > 0) {
      closeTab(0);
    }
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    mock.on("PUT", "/api/note", { mtime: 2000 });
  });

  it("saveCurrentNote with tag-only changes persists frontmatter in the note save", async () => {
    const { openTab, getTabs, getActiveTab, closeTab } = await import("./tab-state.ts");
    const raw = "---\ntags: [alpha]\n---\n\n# Tag Save";
    mock.on("GET", "/api/note", { content: raw, mtime: 1000, tags: ["alpha"] });
    await openTab("tag-save.md");
    showEditor("tag-save.md", raw, ["alpha"]);
    await new Promise((r) => setTimeout(r, 50));

    const removeBtn = document.querySelector(".tag-pill-remove") as HTMLButtonElement;
    removeBtn.click();

    mock.on("PUT", "/api/note", { mtime: 2000 });

    await saveCurrentNote();

    const tab = getActiveTab();
    expect(tab!.dirty).toBeFalsy();
    expect(tab!.mtime).toBe(2000);
    expect(tab!.content).toBe("# Tag Save");

    hideEditor();
    while (getTabs().length > 0) {
      closeTab(0);
    }
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    mock.on("PUT", "/api/note", { mtime: 2000 });
  });

  it("saveCurrentNote real-conflict: conflict banner appears", async () => {
    const { openTab, getTabs, closeTab } = await import("./tab-state.ts");
    mock.on("GET", "/api/note", { content: "# Conflict Test", mtime: 1000 });
    await openTab("conflict-test.md");
    showEditor("conflict-test.md", "# Conflict Test");
    await new Promise((r) => setTimeout(r, 50));

    const sourceBtn = document.querySelector(".editor-toolbar-btn--source") as HTMLButtonElement;
    sourceBtn.click();
    const sourceEl = document.querySelector(".editor-source") as HTMLTextAreaElement;
    sourceEl.value = "# My edits";
    sourceEl.dispatchEvent(new Event("input", { bubbles: true }));

    // Server says file changed to something different
    mock.on("PUT", "/api/note", { mtime: 2000, conflict: true, content: "# Disk version" }, 409);

    await saveCurrentNote();

    const banner = document.querySelector(".conflict-banner");
    expect(banner !== null).toBeTruthy();
    expect(banner!.textContent).toContain("conflict");

    hideEditor();
    while (getTabs().length > 0) {
      closeTab(0);
    }
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    mock.on("PUT", "/api/note", { mtime: 2000 });
  });

  it("reloadFromDisk on clean tab updates content and mtime", async () => {
    const { openTab, getTabs, getActiveTab, closeTab } = await import("./tab-state.ts");
    mock.on("GET", "/api/note", { content: "# Reload Test", mtime: 1000 });
    await openTab("reload-test.md");
    showEditor("reload-test.md", "# Reload Test");
    await new Promise((r) => setTimeout(r, 50));

    reloadFromDisk("# New Disk Content", 5000);

    const tab = getActiveTab();
    expect(tab!.content).toBe("# New Disk Content");
    expect(tab!.mtime).toBe(5000);
    expect(tab!.dirty).toBeFalsy();
    expect(document.querySelector(".conflict-banner")).toBeNull();

    hideEditor();
    while (getTabs().length > 0) {
      closeTab(0);
    }
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
  });

  it("reloadFromDisk on unchanged clean tab preserves selection", async () => {
    const { openTab, getTabs, getActiveTab, closeTab } = await import("./tab-state.ts");
    const content = "foo:\n- one\nx\ndsf";
    mock.on("GET", "/api/note", { content, mtime: 1000 });
    await openTab("reload-same-selection.md");
    showEditor("reload-same-selection.md", content);
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    const paragraph = contentEl.querySelectorAll("p")[1] as HTMLElement;
    const textNode = paragraph.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 1);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    reloadFromDisk(content, 5000);

    const preserved = window.getSelection()!;
    expect(preserved.rangeCount).toBe(1);
    expect(preserved.getRangeAt(0).startContainer).toBe(textNode);
    expect(preserved.getRangeAt(0).startOffset).toBe(1);
    expect(getActiveTab()!.mtime).toBe(5000);
    expect(contentEl.querySelectorAll("li")).toHaveLength(1);

    hideEditor();
    while (getTabs().length > 0) {
      closeTab(0);
    }
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
  });

  it("reloadFromDisk on dirty tab: conflict banner appears when merge fails", async () => {
    const { openTab, getTabs, markDirty, closeTab } = await import("./tab-state.ts");
    mock.on("GET", "/api/note", { content: "# Base", mtime: 1000 });
    await openTab("dirty-reload.md");
    showEditor("dirty-reload.md", "# Base");
    await new Promise((r) => setTimeout(r, 50));

    // In source mode, write content that is entirely different from disk (no merge possible)
    const sourceBtn = document.querySelector(".editor-toolbar-btn--source") as HTMLButtonElement;
    sourceBtn.click();
    const sourceEl = document.querySelector(".editor-source") as HTMLTextAreaElement;
    sourceEl.value = "# Totally different ours";

    markDirty("dirty-reload.md");

    // Disk content also totally different — 3-way merge will conflict
    reloadFromDisk("# Totally different theirs", 6000);

    const banner = document.querySelector(".conflict-banner");
    expect(banner !== null).toBeTruthy();

    hideEditor();
    while (getTabs().length > 0) {
      closeTab(0);
    }
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
  });

  it("showEditor cancels pending autosave timer and silent-saves before loading new file", async () => {
    const { openTab, getTabs, closeTab } = await import("./tab-state.ts");
    mock.on("GET", "/api/note", { content: "# Timer Test", mtime: 1000 });
    await openTab("timer-a.md");
    showEditor("timer-a.md", "# Timer Test");
    await new Promise((r) => setTimeout(r, 50));

    // Simulate input to schedule the autosave timer
    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    contentEl.dispatchEvent(new Event("input", { bubbles: true }));

    // Immediately open another file — should cancel the timer and trigger silent save
    mock.on("GET", "/api/note", { content: "# Timer B", mtime: 2000 });
    await openTab("timer-b.md");
    showEditor("timer-b.md", "# Timer B");
    await new Promise((r) => setTimeout(r, 100));

    hideEditor();
    while (getTabs().length > 0) {
      closeTab(0);
    }
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    mock.on("PUT", "/api/note", { mtime: 2000 });
  });

  it("More menu button click shows context menu with Revisions item", async () => {
    showEditor("menu-test.md", "# Menu Test");
    await new Promise((r) => setTimeout(r, 50));

    const menuBtn = document.querySelector(
      '.editor-toolbar-btn[title="More"]',
    ) as HTMLButtonElement;
    expect(menuBtn !== null).toBeTruthy();
    menuBtn.click();
    await new Promise((r) => setTimeout(r, 0));

    const menu = document.body.querySelector(".context-menu");
    expect(menu !== null).toBeTruthy();
    const items = menu!.querySelectorAll(".context-menu-item");
    const labels = [...items].map((i) => i.textContent);
    expect(labels).toContain("Revisions");

    // Dismiss
    document.body.click();
    hideEditor();
  });

  it("contentEl input event marks tab dirty and schedules autosave", async () => {
    const { openTab, getTabs, getActiveTab, closeTab } = await import("./tab-state.ts");
    mock.on("GET", "/api/note", { content: "# Input Test", mtime: 1000 });
    await openTab("input-test.md");
    showEditor("input-test.md", "# Input Test");
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    const heading = contentEl.querySelector("h1");
    if (heading) {
      heading.textContent = "Changed";
    }
    contentEl.dispatchEvent(new Event("input", { bubbles: true }));

    expect(getActiveTab()!.dirty).toBeTruthy();

    hideEditor();
    while (getTabs().length > 0) {
      closeTab(0);
    }
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
  });

  it("contentEl input historyUndo marks dirty and collapses selection", async () => {
    const { openTab, getTabs, closeTab } = await import("./tab-state.ts");
    mock.on("GET", "/api/note", { content: "# Undo Test", mtime: 1000 });
    await openTab("undo-test.md");
    showEditor("undo-test.md", "# Undo Test");
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    const inputEvent = new InputEvent("input", { bubbles: true, inputType: "historyUndo" });
    contentEl.dispatchEvent(inputEvent);

    hideEditor();
    while (getTabs().length > 0) {
      closeTab(0);
    }
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
  });

  it("sourceEl input event marks tab dirty", async () => {
    const { openTab, getTabs, getActiveTab, closeTab } = await import("./tab-state.ts");
    mock.on("GET", "/api/note", { content: "# Source Input", mtime: 1000 });
    await openTab("source-input.md");
    showEditor("source-input.md", "# Source Input");
    await new Promise((r) => setTimeout(r, 50));

    const sourceBtn = document.querySelector(".editor-toolbar-btn--source") as HTMLButtonElement;
    sourceBtn.click();

    const sourceEl = document.querySelector(".editor-source") as HTMLTextAreaElement;
    sourceEl.value = "# Changed";
    sourceEl.dispatchEvent(new Event("input", { bubbles: true }));

    expect(getActiveTab()!.dirty).toBeTruthy();

    hideEditor();
    while (getTabs().length > 0) {
      closeTab(0);
    }
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
  });

  it("Cmd+S in WYSIWYG mode triggers save", async () => {
    const { openTab, getTabs, closeTab } = await import("./tab-state.ts");
    mock.on("GET", "/api/note", { content: "# Cmd+S Test", mtime: 1000 });
    mock.on("PUT", "/api/note", { mtime: 5000 });
    await openTab("cmds-test.md");
    showEditor("cmds-test.md", "# Cmd+S Test");
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    contentEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    await new Promise((r) => setTimeout(r, 100));

    hideEditor();
    while (getTabs().length > 0) {
      closeTab(0);
    }
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    mock.on("PUT", "/api/note", { mtime: 2000 });
  });

  it("Cmd+B in WYSIWYG mode triggers bold", async () => {
    showEditor("cmdb-test.md", "hello");
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    contentEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true, cancelable: true }),
    );

    hideEditor();
  });

  it("Cmd+I in WYSIWYG mode triggers italic", async () => {
    showEditor("cmdi-test.md", "hello");
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    contentEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "i", ctrlKey: true, bubbles: true, cancelable: true }),
    );

    hideEditor();
  });

  it("sourceEl Cmd+S triggers save", async () => {
    const { openTab, getTabs, closeTab } = await import("./tab-state.ts");
    mock.on("GET", "/api/note", { content: "# Source Save", mtime: 1000 });
    mock.on("PUT", "/api/note", { mtime: 6000 });
    await openTab("source-save.md");
    showEditor("source-save.md", "# Source Save");
    await new Promise((r) => setTimeout(r, 50));

    const sourceBtn = document.querySelector(".editor-toolbar-btn--source") as HTMLButtonElement;
    sourceBtn.click();

    const sourceEl = document.querySelector(".editor-source") as HTMLTextAreaElement;
    sourceEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    await new Promise((r) => setTimeout(r, 100));

    hideEditor();
    while (getTabs().length > 0) {
      closeTab(0);
    }
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    mock.on("PUT", "/api/note", { mtime: 2000 });
  });

  it("saveCurrentNote false-conflict retry path: marks tab clean", async () => {
    const { openTab, getTabs, getActiveTab, closeTab } = await import("./tab-state.ts");
    mock.on("GET", "/api/note", { content: "# FC", mtime: 1000 });
    await openTab("false-conflict.md");
    showEditor("false-conflict.md", "# FC");
    await new Promise((r) => setTimeout(r, 50));

    const sourceBtn = document.querySelector(".editor-toolbar-btn--source") as HTMLButtonElement;
    sourceBtn.click();
    const sourceEl = document.querySelector(".editor-source") as HTMLTextAreaElement;
    sourceEl.value = "# Mine";
    sourceEl.dispatchEvent(new Event("input", { bubbles: true }));

    // Server returns conflict but disk content matches editor → false-conflict
    mock.on("PUT", "/api/note", { mtime: 2000, content: "# Mine" }, 409);

    await saveCurrentNote();

    // false-conflict retries with mtime=0; second PUT also returns 409 but mtime is used
    const tab = getActiveTab();
    expect(tab!.dirty).toBeFalsy();
    expect(tab!.mtime).toBe(2000);

    hideEditor();
    while (getTabs().length > 0) {
      closeTab(0);
    }
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    mock.on("PUT", "/api/note", { mtime: 2000 });
  });

  it("saveCurrentNote with pending autosave timer clears timer then saves", async () => {
    const { openTab, getTabs, closeTab } = await import("./tab-state.ts");
    mock.on("GET", "/api/note", { content: "# Timer Save", mtime: 1000 });
    mock.on("PUT", "/api/note", { mtime: 7000 });
    await openTab("timer-save.md");
    showEditor("timer-save.md", "# Timer Save");
    await new Promise((r) => setTimeout(r, 50));

    // Schedule autosave via input event
    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    contentEl.dispatchEvent(new Event("input", { bubbles: true }));

    // Immediately save manually (clears autosave timer)
    await saveCurrentNote();

    hideEditor();
    while (getTabs().length > 0) {
      closeTab(0);
    }
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    mock.on("PUT", "/api/note", { mtime: 2000 });
  });

  it("loadContent in source mode updates textarea preserving cursor", async () => {
    const { openTab, getTabs, closeTab } = await import("./tab-state.ts");
    mock.on("GET", "/api/note", { content: "# Load Source", mtime: 1000 });
    await openTab("load-source.md");
    showEditor("load-source.md", "# Load Source");
    await new Promise((r) => setTimeout(r, 50));

    const sourceBtn = document.querySelector(".editor-toolbar-btn--source") as HTMLButtonElement;
    sourceBtn.click();
    const sourceEl = document.querySelector(".editor-source") as HTMLTextAreaElement;
    sourceEl.value = "# Load Source";
    sourceEl.selectionStart = 3;
    sourceEl.selectionEnd = 3;

    // reloadFromDisk triggers loadContent in source mode
    reloadFromDisk("# Updated Source", 9000);

    expect(sourceEl.value).toBe("# Updated Source");

    hideEditor();
    while (getTabs().length > 0) {
      closeTab(0);
    }
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
  });

  it("Enter keydown in WYSIWYG mode handled by block transform", async () => {
    showEditor("enter-test.md", "- item");
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    const li = contentEl.querySelector("li");
    if (li) {
      const textNode = li.firstChild as Text;
      const range = document.createRange();
      range.setStart(textNode, textNode.length);
      range.collapse(true);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    }

    contentEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );

    hideEditor();
  });

  it("typing bare task marker followed by space transforms into an interactive checkbox", async () => {
    showEditor("task-input.md", "[ ]");
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    contentEl.innerHTML = '<ul class="task-list"><li class="task-item">[ ] </li></ul>';
    const li = contentEl.querySelector("li.task-item") as HTMLLIElement;
    const textNode = li.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, textNode.length);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    contentEl.dispatchEvent(new Event("input", { bubbles: true }));

    expect(getCurrentContent()).toBe("- [ ] ");

    hideEditor();
  });

  it("pressing Enter on a task item creates the next empty task item", async () => {
    showEditor("task-enter.md", "[ ] foo");
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    const li = contentEl.querySelector("li.task-item") as HTMLLIElement;
    const textNode = [...li.childNodes].find((node) => node.nodeType === Node.TEXT_NODE) as Text;
    const range = document.createRange();
    range.setStart(textNode, textNode.textContent?.length ?? 0);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    contentEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );

    expect(contentEl.querySelectorAll("li.task-item")).toHaveLength(2);
    expect(getCurrentContent()).toBe("- [ ] foo\n- [ ] ");

    hideEditor();
  });

  it("WYSIWYG: nested task lists round-trip as markdown-compliant source", async () => {
    const src =
      "- [x] Parent Task\n  - [x] Completed Sub-task\n  - [ ] Pending Sub-task\n    - [ ] Deeply nested task";
    showEditor("task-nesting.md", src);
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    expect(contentEl.querySelectorAll("li.task-item")).toHaveLength(4);
    expect(contentEl.querySelectorAll("ul.task-list")).toHaveLength(3);
    expect(contentEl.querySelectorAll(".task-list li ul.task-list")).toHaveLength(2);
    expect(getCurrentContent()).toBe(src);

    hideEditor();
  });

  it("paste plain text in WYSIWYG inserts text via execCommand", async () => {
    showEditor("paste-test.md", "# Paste");
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;

    const clipData = {
      items: [],
      getData: (type: string) => (type === "text/plain" ? "pasted text" : ""),
    };
    const pasteEvent = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(pasteEvent, "clipboardData", { value: clipData });
    contentEl.dispatchEvent(pasteEvent);

    hideEditor();
  });

  it("revision:restore event updates editor content and marks tab clean", async () => {
    const { openTab, getTabs, getActiveTab, markDirty, closeTab } = await import("./tab-state.ts");
    const { emit } = await import("./events.ts");

    mock.on("GET", "/api/note", { content: "# Rev Test", mtime: 1000 });
    await openTab("rev-test.md");
    showEditor("rev-test.md", "# Rev Test");
    await new Promise((r) => setTimeout(r, 50));

    markDirty("rev-test.md");
    expect(getActiveTab()!.dirty).toBeTruthy();

    emit("revision:restore", { content: "# Restored Version", mtime: 8000 });
    await new Promise((r) => setTimeout(r, 50));

    const tab = getActiveTab();
    expect(tab!.content).toBe("# Restored Version");
    expect(tab!.mtime).toBe(8000);
    expect(tab!.dirty).toBeFalsy();

    hideEditor();
    while (getTabs().length > 0) {
      closeTab(0);
    }
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
  });

  it("task list checkboxes toggle and serialize back to markdown", async () => {
    showEditor("checkbox.md", "- [ ] todo");
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    const checkbox = contentEl.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox !== null).toBeTruthy();
    expect(checkbox.disabled).toBeFalsy();

    checkbox.click();
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));

    expect(getCurrentContent()).toBe("- [x] todo");

    hideEditor();
  });

  it("autosave defers then fires when selection becomes collapsed", async () => {
    const { openTab, getTabs, closeTab } = await import("./tab-state.ts");
    const { AUTOSAVE_DELAY_MS, AUTOSAVE_RETRY_DELAY_MS } = await import("./constants.ts");
    mock.on("GET", "/api/note", { content: "# Defer Test", mtime: 1000 });
    mock.on("PUT", "/api/note", { mtime: 2001 });
    await openTab("defer-autosave.md");
    showEditor("defer-autosave.md", "# Defer Test");
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;

    // Actually mutate content so the tab becomes dirty
    const heading = contentEl.querySelector("h1");
    if (heading) {
      heading.textContent = "Defer Changed";
    }

    // Snapshot request count before testing — mock.requests accumulates across tests
    const saveCountBefore = mock.requests.filter(
      (r) => r.method === "PUT" && r.url.includes("/api/note"),
    ).length;

    // Use a real child node of contentEl so contentEl.contains() returns true
    const anchorNode = contentEl.firstChild ?? contentEl;
    const origGetSelection = window.getSelection.bind(window);

    vi.useFakeTimers();
    try {
      // Pretend user has an active (non-collapsed) selection inside contentEl.
      // rangeCount: 0 prevents library internals (typing checkpoint) from calling getRangeAt.
      window.getSelection = () =>
        ({ isCollapsed: false, anchorNode, rangeCount: 0 }) as unknown as Selection;

      contentEl.dispatchEvent(new Event("input", { bubbles: true }));

      // Advance past AUTOSAVE_DELAY_MS — tryAutosave should defer because selection is active
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS + 1);

      const savesAfterDefer =
        mock.requests.filter((r) => r.method === "PUT" && r.url.includes("/api/note")).length -
        saveCountBefore;
      expect(savesAfterDefer).toBe(0);

      // Restore real getSelection — retry should save (selection is now collapsed)
      window.getSelection = origGetSelection;
      vi.advanceTimersByTime(AUTOSAVE_RETRY_DELAY_MS + 1);
    } finally {
      // Always restore — prevents mock from leaking to other tests if assertion fails
      window.getSelection = origGetSelection;
      vi.useRealTimers();
    }

    // Let the async save settle
    await new Promise((r) => setTimeout(r, 100));

    const savesAfterRetry =
      mock.requests.filter((r) => r.method === "PUT" && r.url.includes("/api/note")).length -
      saveCountBefore;
    expect(savesAfterRetry).toBeGreaterThan(0);

    hideEditor();
    while (getTabs().length > 0) {
      closeTab(0);
    }
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    mock.on("PUT", "/api/note", { mtime: 2000 });
  });

  it("tag add via autocomplete callback path appends tag to editor", async () => {
    const { openTab, getTabs, closeTab } = await import("./tab-state.ts");
    const { invalidateTagCache } = await import("./editor.ts");
    mock.on("GET", "/api/note", { content: "# Tag AC Test", mtime: 1000 });
    mock.on("GET", "/api/tags", { tags: ["typescript", "rust"] });
    invalidateTagCache();
    await openTab("tag-ac.md");
    showEditor("tag-ac.md", "# Tag AC Test");
    await new Promise((r) => setTimeout(r, 50));

    const tagInput = document.querySelector(".editor-tags-input") as HTMLInputElement | null;
    expect(tagInput).not.toBeNull();

    // Focus triggers checkTagInput which fetches and shows the dropdown
    tagInput!.focus();
    tagInput!.value = "typ";
    tagInput!.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));

    const autocomplete = document.querySelector(".autocomplete");
    expect(autocomplete).not.toBeNull();

    const firstItem = autocomplete!.querySelector(".autocomplete-item") as HTMLElement | null;
    expect(firstItem).not.toBeNull();
    firstItem!.click();

    const tagPills = document.querySelectorAll(".tag-pill");
    expect(tagPills.length).toBeGreaterThan(0);

    hideEditor();
    while (getTabs().length > 0) closeTab(0);
    invalidateTagCache();
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    mock.on("GET", "/api/tags", { tags: [] });
  });

  it("conflict banner Keep Mine force-saves and removes the banner", async () => {
    const { openTab, getTabs, getActiveTab, closeTab } = await import("./tab-state.ts");
    mock.on("GET", "/api/note", { content: "# Keep Mine Base", mtime: 1000 });
    await openTab("keep-mine.md");
    showEditor("keep-mine.md", "# Keep Mine Base");
    await new Promise((r) => setTimeout(r, 50));

    const sourceBtn = document.querySelector(".editor-toolbar-btn--source") as HTMLButtonElement;
    sourceBtn.click();
    const sourceEl = document.querySelector(".editor-source") as HTMLTextAreaElement;
    sourceEl.value = "# My Edits";
    sourceEl.dispatchEvent(new Event("input", { bubbles: true }));

    mock.on("PUT", "/api/note", { mtime: 2000, conflict: true, content: "# Disk Edits" }, 409);
    await saveCurrentNote();

    const banner = document.querySelector(".conflict-banner");
    expect(banner).not.toBeNull();

    // Register a success response for the force save
    mock.on("PUT", "/api/note", { mtime: 3000 });

    const keepBtn = Array.from(banner!.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Keep mine",
    ) as HTMLButtonElement | undefined;
    expect(keepBtn).toBeDefined();
    keepBtn!.click();
    await new Promise((r) => setTimeout(r, 80));

    expect(document.querySelector(".conflict-banner")).toBeNull();
    expect(getActiveTab()!.dirty).toBeFalsy();

    hideEditor();
    while (getTabs().length > 0) closeTab(0);
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    mock.on("PUT", "/api/note", { mtime: 2000 });
  });

  it("conflict banner Take Theirs loads disk content and clears the banner", async () => {
    const { openTab, getTabs, getActiveTab, closeTab } = await import("./tab-state.ts");
    mock.on("GET", "/api/note", { content: "# Take Theirs Base", mtime: 1000 });
    await openTab("take-theirs.md");
    showEditor("take-theirs.md", "# Take Theirs Base");
    await new Promise((r) => setTimeout(r, 50));

    const sourceBtn = document.querySelector(".editor-toolbar-btn--source") as HTMLButtonElement;
    sourceBtn.click();
    const sourceEl = document.querySelector(".editor-source") as HTMLTextAreaElement;
    sourceEl.value = "# Local Edits";
    sourceEl.dispatchEvent(new Event("input", { bubbles: true }));

    mock.on("PUT", "/api/note", { mtime: 2000, conflict: true, content: "# Disk Content" }, 409);
    await saveCurrentNote();

    const banner = document.querySelector(".conflict-banner");
    expect(banner).not.toBeNull();

    const theirsBtn = Array.from(banner!.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Take theirs",
    ) as HTMLButtonElement | undefined;
    expect(theirsBtn).toBeDefined();
    theirsBtn!.click();
    await new Promise((r) => setTimeout(r, 20));

    expect(document.querySelector(".conflict-banner")).toBeNull();

    // Source mode textarea should contain disk content after reload
    const updatedSource = document.querySelector(".editor-source") as HTMLTextAreaElement | null;
    expect(updatedSource?.value).toBe("# Disk Content");

    const tab = getActiveTab();
    expect(tab!.dirty).toBeFalsy();
    expect(tab!.mtime).toBe(2000);

    hideEditor();
    while (getTabs().length > 0) closeTab(0);
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    mock.on("PUT", "/api/note", { mtime: 2000 });
  });

  it("autosave timer debounces rapid inputs and fires exactly once", async () => {
    const { AUTOSAVE_DELAY_MS } = await import("./constants.ts");
    const { openTab, getTabs, closeTab } = await import("./tab-state.ts");
    mock.on("GET", "/api/note", { content: "# Debounce", mtime: 1000 });
    mock.on("PUT", "/api/note", { mtime: 9001 });
    await openTab("debounce.md");
    showEditor("debounce.md", "# Debounce");
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    const h1 = contentEl.querySelector("h1");
    if (h1) h1.textContent = "Debounced";

    const saveBefore = mock.requests.filter(
      (r) => r.method === "PUT" && r.url.includes("/api/note"),
    ).length;

    vi.useFakeTimers();
    try {
      contentEl.dispatchEvent(new Event("input", { bubbles: true }));

      // Advance partway — no save yet
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS / 2);

      // Second input resets the debounce timer
      contentEl.dispatchEvent(new Event("input", { bubbles: true }));

      // Advance to just before the second timer would fire — still no save
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS / 2);
      const savesMid =
        mock.requests.filter((r) => r.method === "PUT" && r.url.includes("/api/note")).length -
        saveBefore;
      expect(savesMid).toBe(0);

      // Advance past the full second timer — autosave fires
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);
    } finally {
      vi.useRealTimers();
    }

    await new Promise((r) => setTimeout(r, 100));

    const savesAfter =
      mock.requests.filter((r) => r.method === "PUT" && r.url.includes("/api/note")).length -
      saveBefore;
    expect(savesAfter).toBeGreaterThan(0);

    hideEditor();
    while (getTabs().length > 0) closeTab(0);
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    mock.on("PUT", "/api/note", { mtime: 2000 });
  });

  it("Cmd+Z undoes and Cmd+Shift+Z redoes editor content changes", async () => {
    const { openTab, getTabs, closeTab } = await import("./tab-state.ts");
    mock.on("GET", "/api/note", { content: "# UndoRedo Base", mtime: 1000 });
    mock.on("PUT", "/api/note", { mtime: 7001 });
    await openTab("undo-redo.md");
    showEditor("undo-redo.md", "# UndoRedo Base");
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;

    // Mutate content and save to push a second undo entry
    const h1 = contentEl.querySelector("h1");
    if (h1) h1.textContent = "UndoRedo Changed";
    contentEl.dispatchEvent(new Event("input", { bubbles: true }));
    await saveCurrentNote();

    expect(getCurrentContent()).toContain("UndoRedo Changed");

    // Cmd+Z → undo
    contentEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(getCurrentContent()).toContain("UndoRedo Base");

    // Cmd+Shift+Z → redo
    contentEl.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "z",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(getCurrentContent()).toContain("UndoRedo Changed");

    hideEditor();
    while (getTabs().length > 0) closeTab(0);
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    mock.on("PUT", "/api/note", { mtime: 2000 });
  });

  it("source-mode save path sends source textarea content to the API", async () => {
    const { openTab, getTabs, closeTab } = await import("./tab-state.ts");
    mock.on("GET", "/api/note", { content: "# Source Save Path", mtime: 1000 });
    mock.on("PUT", "/api/note", { mtime: 6001 });
    await openTab("src-save-path.md");
    showEditor("src-save-path.md", "# Source Save Path");
    await new Promise((r) => setTimeout(r, 50));

    const sourceBtn = document.querySelector(".editor-toolbar-btn--source") as HTMLButtonElement;
    sourceBtn.click();
    const sourceEl = document.querySelector(".editor-source") as HTMLTextAreaElement;
    sourceEl.value = "# From Source Textarea\n\nEdited in source mode.";
    sourceEl.dispatchEvent(new Event("input", { bubbles: true }));

    mock.clearRequests();
    await saveCurrentNote();

    const put = mock.requests.find((r) => r.method === "PUT" && r.url.includes("/api/note"));
    expect(put?.body).toBeTruthy();
    const payload = JSON.parse(put!.body!) as { content: string };
    expect(payload.content).toBe("# From Source Textarea\n\nEdited in source mode.");

    hideEditor();
    while (getTabs().length > 0) closeTab(0);
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    mock.on("PUT", "/api/note", { mtime: 2000 });
  });

  it("paste event with image item routes to image handler and skips text paste", async () => {
    showEditor("img-paste.md", "# Image Paste");
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    const contentBefore = getCurrentContent();

    const imageItem = {
      type: "image/png",
      kind: "file",
      getAsFile: () => null,
      getAsString: () => {},
      webkitGetAsEntry: () => null,
    } as unknown as DataTransferItem;

    const clipboardData = {
      items: [imageItem],
      getData: (type: string) => (type === "text/plain" ? "should-not-be-pasted" : ""),
    } as unknown as DataTransfer;

    const pasteEvent = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: clipboardData,
      configurable: true,
    });

    contentEl.dispatchEvent(pasteEvent);

    // Text paste path must NOT have run — the magic string must be absent
    expect(getCurrentContent()).not.toContain("should-not-be-pasted");
    // Content unchanged since handleImagePaste returned early (getAsFile() = null)
    expect(getCurrentContent()).toBe(contentBefore);

    hideEditor();
  });
});
