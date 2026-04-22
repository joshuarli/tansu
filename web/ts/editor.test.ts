import { describe, test, expect, beforeAll, afterAll } from "vitest";

import { classifySaveResult, classifyReload } from "./editor.ts";
import type { SaveAction } from "./editor.ts";
import { setupDOM, mockFetch } from "./test-helper.ts";

describe("classifySaveResult", () => {
  test("no conflict → clean", () => {
    const action = classifySaveResult({ mtime: 100 }, "editor content", "tab content");
    expect(action.type).toBe("clean");
    expect((action as Extract<SaveAction, { type: "clean" }>).mtime).toBe(100);
    expect((action as Extract<SaveAction, { type: "clean" }>).content).toBe("editor content");
  });

  test("conflict but disk matches editor → false-conflict", () => {
    const action = classifySaveResult(
      { conflict: true, content: "same", mtime: 200 },
      "same",
      "old tab content",
    );
    expect(action.type).toBe("false-conflict");
  });

  test("conflict but disk matches tab saved content → false-conflict", () => {
    const action = classifySaveResult(
      { conflict: true, content: "tab saved", mtime: 200 },
      "editor different",
      "tab saved",
    );
    expect(action.type).toBe("false-conflict");
  });

  test("conflict with genuinely different disk content → real-conflict", () => {
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

  test("conflict with missing disk content → real-conflict with empty string", () => {
    const action = classifySaveResult({ conflict: true, mtime: 400 }, "editor", "tab");
    expect(action.type).toBe("real-conflict");
    expect((action as Extract<SaveAction, { type: "real-conflict" }>).diskContent).toBe("");
  });

  test("conflict with empty disk content matching empty editor → false-conflict", () => {
    const action = classifySaveResult({ conflict: true, content: "", mtime: 500 }, "", "tab");
    expect(action.type).toBe("false-conflict");
  });
});

describe("classifyReload", () => {
  test("not dirty → load", () => {
    expect(classifyReload(false).type).toBe("load");
  });

  test("dirty → conflict", () => {
    expect(classifyReload(true).type).toBe("conflict");
  });
});

describe("editor", () => {
  let cleanup: () => void;
  let mock: ReturnType<typeof mockFetch>;
  let initEditor: () => void;
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
    initEditor = mod.initEditor;
    showEditor = mod.showEditor;
    hideEditor = mod.hideEditor;
    getCurrentContent = mod.getCurrentContent;
    saveCurrentNote = mod.saveCurrentNote;
    reloadFromDisk = mod.reloadFromDisk;

    initEditor();
  });

  afterAll(() => {
    mock.restore();
    cleanup();
  });

  test("showEditor renders content as HTML", async () => {
    showEditor("test.md", "# Hello\n\nWorld");
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    expect(contentEl !== null).toBe(true);
    expect(contentEl.innerHTML).toContain("<h1>Hello</h1>");
    expect(contentEl.innerHTML).toContain("<p>World</p>");
    expect(contentEl.contentEditable).toBe("true");

    hideEditor();
  });

  test("showEditor creates hidden source textarea", async () => {
    showEditor("test.md", "# Hi");
    await new Promise((r) => setTimeout(r, 50));

    const sourceEl = document.querySelector(".editor-source") as HTMLTextAreaElement;
    expect(sourceEl !== null).toBe(true);
    expect(sourceEl.style.display).toBe("none");

    hideEditor();
  });

  test("showEditor creates toolbar with Source and Revisions buttons", async () => {
    showEditor("test.md", "# Hi");
    await new Promise((r) => setTimeout(r, 50));

    const toolbar = document.querySelector(".editor-toolbar");
    expect(toolbar !== null).toBe(true);
    const buttons = toolbar!.querySelectorAll("button");
    const labels = Array.from(buttons).map((b) => b.textContent);
    expect(labels).toContain("Source");
    expect(labels).toContain("Revisions");

    hideEditor();
  });

  test("getCurrentContent returns serialized markdown in WYSIWYG mode", async () => {
    showEditor("test.md", "# Content");
    await new Promise((r) => setTimeout(r, 50));
    const content = getCurrentContent();
    expect(content).toContain("Content");
    hideEditor();
  });

  test("hideEditor removes editor elements and shows empty state", () => {
    showEditor("test.md", "# X");
    hideEditor();
    expect(document.querySelector(".editor-content")).toBe(null);
    expect(document.querySelector(".editor-source")).toBe(null);
    const emptyState = document.getElementById("empty-state");
    expect(emptyState!.style.display).toBe("flex");
  });

  test("getCurrentContent returns empty string when no editor open", () => {
    hideEditor();
    expect(getCurrentContent()).toBe("");
  });

  test("source mode: clicking Source shows textarea and hides contentEl", async () => {
    showEditor("toggle.md", "# Toggle");
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    const sourceEl = document.querySelector(".editor-source") as HTMLTextAreaElement;
    const sourceBtn = Array.from(document.querySelectorAll(".editor-toolbar button")).find(
      (b) => b.textContent === "Source",
    ) as HTMLButtonElement;

    sourceBtn.click();
    expect(contentEl.style.display).toBe("none");
    expect(sourceEl.style.display !== "none").toBe(true);

    hideEditor();
  });

  test("source mode: getCurrentContent returns textarea value", async () => {
    showEditor("toggle.md", "# Toggle");
    await new Promise((r) => setTimeout(r, 50));

    const sourceEl = document.querySelector(".editor-source") as HTMLTextAreaElement;
    const sourceBtn = Array.from(document.querySelectorAll(".editor-toolbar button")).find(
      (b) => b.textContent === "Source",
    ) as HTMLButtonElement;

    sourceBtn.click();
    sourceEl.value = "# Raw markdown";
    expect(getCurrentContent()).toBe("# Raw markdown");

    hideEditor();
  });

  test("source mode: clicking Source again returns to WYSIWYG", async () => {
    showEditor("toggle.md", "# Toggle");
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    const sourceEl = document.querySelector(".editor-source") as HTMLTextAreaElement;
    const sourceBtn = Array.from(document.querySelectorAll(".editor-toolbar button")).find(
      (b) => b.textContent === "Source",
    ) as HTMLButtonElement;

    sourceBtn.click();
    sourceBtn.click();
    expect(contentEl.style.display !== "none").toBe(true);
    expect(sourceEl.style.display).toBe("none");

    hideEditor();
  });

  test("source mode: Tab inserts a tab character at the caret", async () => {
    showEditor("tab-source.md", "# Tab");
    await new Promise((r) => setTimeout(r, 50));

    const sourceBtn = Array.from(document.querySelectorAll(".editor-toolbar button")).find(
      (b) => b.textContent === "Source",
    ) as HTMLButtonElement;
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

  test("source mode: Tab indents all selected lines and Shift+Tab dedents them", async () => {
    showEditor("tab-source-lines.md", "# Tab");
    await new Promise((r) => setTimeout(r, 50));

    const sourceBtn = Array.from(document.querySelectorAll(".editor-toolbar button")).find(
      (b) => b.textContent === "Source",
    ) as HTMLButtonElement;
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

  test("WYSIWYG: Tab inserts a visible tab and preserves markdown", async () => {
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

    expect(getCurrentContent()).toBe("he\tllo");
    expect(contentEl.querySelector(`.${"md-tab"}`)).not.toBe(null);

    hideEditor();
  });

  test("WYSIWYG: Tab and Shift+Tab indent and dedent selected blocks", async () => {
    showEditor("tab-wysiwyg-blocks.md", "alpha\n\nbeta");
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    const paragraphs = contentEl.querySelectorAll("p");
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
    expect(preserved.isCollapsed).toBe(false);

    hideEditor();
  });

  test("WYSIWYG: Tab on bullet list nests under previous item", async () => {
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

  test("WYSIWYG: Shift+Tab on multi-item nested bullet selection preserves selection", async () => {
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
    expect(preserved.isCollapsed).toBe(false);

    hideEditor();
  });

  test("saveCurrentNote success: tab marked clean with new mtime", async () => {
    const { openTab, getTabs, getActiveTab, closeTab } = await import("./tab-state.ts");
    mock.on("GET", "/api/note", { content: "# Save Test", mtime: 1000 });
    await openTab("save-test.md");
    showEditor("save-test.md", "# Save Test");
    await new Promise((r) => setTimeout(r, 50));

    const sourceBtn = Array.from(document.querySelectorAll(".editor-toolbar button")).find(
      (b) => b.textContent === "Source",
    ) as HTMLButtonElement;
    sourceBtn.click();
    const sourceEl = document.querySelector(".editor-source") as HTMLTextAreaElement;
    sourceEl.value = "# Updated Content";

    mock.on("PUT", "/api/note", { mtime: 3000 });

    await saveCurrentNote();

    const tab = getActiveTab();
    expect(tab!.dirty).toBe(false);
    expect(tab!.mtime).toBe(3000);
    expect(tab!.content).toBe("# Updated Content");

    hideEditor();
    while (getTabs().length > 0) closeTab(0);
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    mock.on("PUT", "/api/note", { mtime: 2000 });
  });

  test("saveCurrentNote real-conflict: conflict banner appears", async () => {
    const { openTab, getTabs, closeTab } = await import("./tab-state.ts");
    mock.on("GET", "/api/note", { content: "# Conflict Test", mtime: 1000 });
    await openTab("conflict-test.md");
    showEditor("conflict-test.md", "# Conflict Test");
    await new Promise((r) => setTimeout(r, 50));

    const sourceBtn = Array.from(document.querySelectorAll(".editor-toolbar button")).find(
      (b) => b.textContent === "Source",
    ) as HTMLButtonElement;
    sourceBtn.click();
    const sourceEl = document.querySelector(".editor-source") as HTMLTextAreaElement;
    sourceEl.value = "# My edits";

    // Server says file changed to something different
    mock.on("PUT", "/api/note", { mtime: 2000, conflict: true, content: "# Disk version" }, 409);

    await saveCurrentNote();

    const banner = document.querySelector(".conflict-banner");
    expect(banner !== null).toBe(true);
    expect(banner!.textContent).toContain("conflict");

    hideEditor();
    while (getTabs().length > 0) closeTab(0);
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    mock.on("PUT", "/api/note", { mtime: 2000 });
  });

  test("reloadFromDisk on clean tab updates content and mtime", async () => {
    const { openTab, getTabs, getActiveTab, closeTab } = await import("./tab-state.ts");
    mock.on("GET", "/api/note", { content: "# Reload Test", mtime: 1000 });
    await openTab("reload-test.md");
    showEditor("reload-test.md", "# Reload Test");
    await new Promise((r) => setTimeout(r, 50));

    reloadFromDisk("# New Disk Content", 5000);

    const tab = getActiveTab();
    expect(tab!.content).toBe("# New Disk Content");
    expect(tab!.mtime).toBe(5000);
    expect(tab!.dirty).toBe(false);
    expect(document.querySelector(".conflict-banner")).toBe(null);

    hideEditor();
    while (getTabs().length > 0) closeTab(0);
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
  });

  test("reloadFromDisk on dirty tab: conflict banner appears when merge fails", async () => {
    const { openTab, getTabs, markDirty, closeTab } = await import("./tab-state.ts");
    mock.on("GET", "/api/note", { content: "# Base", mtime: 1000 });
    await openTab("dirty-reload.md");
    showEditor("dirty-reload.md", "# Base");
    await new Promise((r) => setTimeout(r, 50));

    // In source mode, write content that is entirely different from disk (no merge possible)
    const sourceBtn = Array.from(document.querySelectorAll(".editor-toolbar button")).find(
      (b) => b.textContent === "Source",
    ) as HTMLButtonElement;
    sourceBtn.click();
    const sourceEl = document.querySelector(".editor-source") as HTMLTextAreaElement;
    sourceEl.value = "# Totally different ours";

    markDirty("dirty-reload.md");

    // Disk content also totally different — 3-way merge will conflict
    reloadFromDisk("# Totally different theirs", 6000);

    const banner = document.querySelector(".conflict-banner");
    expect(banner !== null).toBe(true);

    hideEditor();
    while (getTabs().length > 0) closeTab(0);
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
  });

  test("revision:restore event updates editor content and marks tab clean", async () => {
    const { openTab, getTabs, getActiveTab, markDirty, closeTab } = await import("./tab-state.ts");
    const { emit } = await import("./events.ts");

    mock.on("GET", "/api/note", { content: "# Rev Test", mtime: 1000 });
    await openTab("rev-test.md");
    showEditor("rev-test.md", "# Rev Test");
    await new Promise((r) => setTimeout(r, 50));

    markDirty("rev-test.md");
    expect(getActiveTab()!.dirty).toBe(true);

    emit("revision:restore", { content: "# Restored Version", mtime: 8000 });
    await new Promise((r) => setTimeout(r, 50));

    const tab = getActiveTab();
    expect(tab!.content).toBe("# Restored Version");
    expect(tab!.mtime).toBe(8000);
    expect(tab!.dirty).toBe(false);

    hideEditor();
    while (getTabs().length > 0) closeTab(0);
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
  });
});
