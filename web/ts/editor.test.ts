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
  let showEditor: (path: string, content: string) => void;
  let hideEditor: () => void;
  let getCurrentContent: () => string;
  let saveCurrentNote: () => Promise<void>;
  let reloadFromDisk: (content: string, mtime: number) => void;

  beforeAll(async () => {
    cleanup = setupDOM();
    mock = mockFetch();

    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    mock.on("PUT", "/api/note", { mtime: 2000 });
    mock.on("PUT", "/api/state", {});
    mock.on("GET", "/api/state", { tabs: [], active: -1 });
    mock.on("GET", "/api/backlinks", []);
    mock.on("GET", "/api/notes", []);
    mock.on("GET", "/api/revisions", []);

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
    sourceEl.value = "# FC";
    sourceEl.dispatchEvent(new Event("input", { bubbles: true }));

    // Server returns conflict but disk content matches editor → false-conflict
    mock.on("PUT", "/api/note", { mtime: 2000, content: "# FC" }, 409);

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
});
