import { describe, test, expect, beforeAll, afterAll } from "bun:test";

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
    mock.on("GET", "/api/settings", {
      weight_title: 10,
      weight_headings: 5,
      weight_tags: 2,
      weight_content: 1,
      fuzzy_distance: 1,
      result_limit: 20,
      show_score_breakdown: true,
      excluded_folders: [],
    });
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

  test("editor rendering and content", async () => {
    // showEditor renders content
    showEditor("test.md", "# Hello\n\nWorld");
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    expect(contentEl !== null).toBe(true);
    expect(contentEl.innerHTML).toContain("<h1>Hello</h1>");
    expect(contentEl.innerHTML).toContain("<p>World</p>");

    // contentEditable is set
    expect(contentEl.contentEditable).toBe("true");

    // Source mode textarea exists (hidden)
    const sourceEl = document.querySelector(".editor-source") as HTMLTextAreaElement;
    expect(sourceEl !== null).toBe(true);
    expect(sourceEl.style.display).toBe("none");

    // Toolbar exists with buttons
    const toolbar = document.querySelector(".editor-toolbar");
    expect(toolbar !== null).toBe(true);
    const buttons = toolbar!.querySelectorAll("button");
    expect(buttons.length >= 2).toBe(true);

    // getCurrentContent returns serialized markdown
    const content = getCurrentContent();
    expect(content).toContain("Hello");

    // hideEditor removes the editor
    hideEditor();
    expect(document.querySelector(".editor-content")).toBe(null);
    expect(document.querySelector(".editor-source")).toBe(null);

    // After hide, getCurrentContent returns empty
    expect(getCurrentContent()).toBe("");

    // showEditor again with different content
    showEditor("other.md", "**bold text**");
    await new Promise((r) => setTimeout(r, 50));
    const content2 = document.querySelector(".editor-content");
    expect(content2 !== null).toBe(true);
    expect(content2!.innerHTML).toContain("<strong>bold text</strong>");

    // Empty state handling
    hideEditor();
    const emptyState = document.getElementById("empty-state");
    expect(emptyState!.style.display).toBe("flex");
  });

  test("source mode toggle", async () => {
    // Source mode: click Source button → textarea visible, contentEl hidden
    showEditor("toggle.md", "# Toggle");
    await new Promise((r) => setTimeout(r, 50));

    const contentElToggle = document.querySelector(".editor-content") as HTMLElement;
    const sourceElToggle = document.querySelector(".editor-source") as HTMLTextAreaElement;
    const sourceBtn = Array.from(document.querySelectorAll(".editor-toolbar button")).find(
      (b) => b.textContent === "Source",
    ) as HTMLButtonElement;
    expect(sourceBtn !== null).toBe(true);

    // Click Source button to enter source mode
    sourceBtn.click();
    expect(contentElToggle.style.display).toBe("none");
    expect(sourceElToggle.style.display !== "none").toBe(true);

    // Source mode getCurrentContent returns textarea value
    sourceElToggle.value = "# Raw markdown";
    const srcContent = getCurrentContent();
    expect(srcContent).toBe("# Raw markdown");

    // Click Source button again to return to rich text mode
    sourceBtn.click();
    expect(contentElToggle.style.display !== "none").toBe(true);
    expect(sourceElToggle.style.display).toBe("none");

    // Verify getCurrentContent in source mode reflects textarea directly
    showEditor("cm.md", "# Current");
    await new Promise((r) => setTimeout(r, 50));
    const cmSource = document.querySelector(".editor-source") as HTMLTextAreaElement;
    const cmSourceBtn = Array.from(document.querySelectorAll(".editor-toolbar button")).find(
      (b) => b.textContent === "Source",
    ) as HTMLButtonElement;
    cmSourceBtn.click();
    cmSource.value = "custom source";
    expect(getCurrentContent()).toBe("custom source");
    hideEditor();
  });

  test("saveCurrentNote success: markClean called", async () => {
    const { openTab, getTabs, getActiveTab, closeTab } = await import("./tab-state.ts");
    mock.on("GET", "/api/note", { content: "# Save Test", mtime: 1000 });
    await openTab("save-test.md");
    showEditor("save-test.md", "# Save Test");
    await new Promise((r) => setTimeout(r, 50));

    // Switch to source mode and set content
    const sourceBtn = Array.from(document.querySelectorAll(".editor-toolbar button")).find(
      (b) => b.textContent === "Source",
    ) as HTMLButtonElement;
    sourceBtn.click();
    const sourceEl = document.querySelector(".editor-source") as HTMLTextAreaElement;
    sourceEl.value = "# Updated Content";

    // Mock successful save
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

  test("saveCurrentNote false-conflict: retries with mtime=0", async () => {
    const { openTab, getTabs, getActiveTab, closeTab } = await import("./tab-state.ts");
    mock.on("GET", "/api/note", { content: "# FC Test", mtime: 1000 });
    await openTab("fc-test.md");
    showEditor("fc-test.md", "# FC Test");
    await new Promise((r) => setTimeout(r, 50));

    // Source mode
    const sourceBtn = Array.from(document.querySelectorAll(".editor-toolbar button")).find(
      (b) => b.textContent === "Source",
    ) as HTMLButtonElement;
    sourceBtn.click();
    const sourceEl = document.querySelector(".editor-source") as HTMLTextAreaElement;
    sourceEl.value = "# FC Test";

    // First save returns conflict with same content (false conflict)
    mock.on("PUT", "/api/note", { mtime: 1000, conflict: true, content: "# FC Test" }, 409);

    // The retry should succeed — override the mock for the retry call
    // (later handlers take precedence, but both match PUT /api/note)
    // We track calls to detect the retry
    let putCount = 0;
    const wrappedFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if ((init?.method ?? "GET").toUpperCase() === "PUT" && url.includes("/api/note")) {
        putCount++;
        if (putCount >= 2) {
          // Second PUT = the retry with mtime=0
          return new Response(JSON.stringify({ mtime: 4000 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
      return wrappedFetch(input, init);
    }) as typeof fetch;

    await saveCurrentNote();

    globalThis.fetch = wrappedFetch;

    expect(putCount).toBeGreaterThanOrEqual(2);
    const tab = getActiveTab();
    expect(tab!.dirty).toBe(false);
    expect(tab!.mtime).toBe(4000);

    hideEditor();
    while (getTabs().length > 0) closeTab(0);
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    mock.on("PUT", "/api/note", { mtime: 2000 });
  });

  test("reloadFromDisk on clean tab: content updates", async () => {
    const { openTab, getTabs, getActiveTab, closeTab } = await import("./tab-state.ts");
    mock.on("GET", "/api/note", { content: "# Reload Test", mtime: 1000 });
    await openTab("reload-test.md");
    showEditor("reload-test.md", "# Reload Test");
    await new Promise((r) => setTimeout(r, 50));

    // Tab is clean; reloadFromDisk should update content without conflict
    reloadFromDisk("# New Disk Content", 5000);

    const tab = getActiveTab();
    expect(tab!.content).toBe("# New Disk Content");
    expect(tab!.mtime).toBe(5000);
    expect(tab!.dirty).toBe(false);

    // No conflict banner should appear
    expect(document.querySelector(".conflict-banner")).toBe(null);

    hideEditor();
    while (getTabs().length > 0) closeTab(0);
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
  });

  test("revision:restore event updates editor content", async () => {
    const { openTab, getTabs, getActiveTab, markDirty, closeTab } = await import("./tab-state.ts");
    const { emit } = await import("./events.ts");

    mock.on("GET", "/api/note", { content: "# Rev Test", mtime: 1000 });
    await openTab("rev-test.md");
    showEditor("rev-test.md", "# Rev Test");
    await new Promise((r) => setTimeout(r, 50));

    // Mark dirty first so we know restore cleans it
    markDirty("rev-test.md");
    expect(getActiveTab()!.dirty).toBe(true);

    // Emit revision:restore
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
