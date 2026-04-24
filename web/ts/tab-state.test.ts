/// Tests for tab-state.ts — pure data logic, but needs DOM because
/// tabs.ts registers a render listener on the shared event bus.

import { describe, test, expect, beforeAll, afterAll } from "vitest";

import { on } from "./events.ts";
import { setupDOM, mockFetch } from "./test-helper.ts";

describe("tab-state", () => {
  let cleanup: () => void;
  let mock: ReturnType<typeof mockFetch>;
  let openTab: (path: string) => Promise<any>;
  let closeTab: (i: number) => void;
  let getActiveTab: () => any;
  let getTabs: () => any[];
  let getActiveIndex: () => number;
  let nextTab: () => void;
  let prevTab: () => void;
  let markDirty: (path: string) => void;
  let markClean: (path: string, content: string, mtime: number) => void;
  let updateTabContent: (path: string, content: string, mtime: number) => void;
  let updateTabPath: (oldPath: string, newPath: string) => void;
  let closeActiveTab: () => void;
  let closeTabByPath: (path: string) => void;
  let titleFromPath: (path: string) => string;
  let createNewNote: (name: string) => Promise<void>;
  let restoreSession: () => Promise<void>;
  let switchTab: (index: number) => Promise<void>;
  let syncToServer: () => Promise<void>;
  let setCursor: (path: string, offset: number) => void;
  let getCursor: (path: string) => number | undefined;
  let clearClosedTabs: () => void;
  let reopenClosedTab: () => Promise<void>;
  let offRender: () => void;
  let offChange: () => void;

  beforeAll(async () => {
    cleanup = setupDOM();
    mock = mockFetch();
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    mock.on("PUT", "/api/state", {});
    mock.on("GET", "/api/state", { tabs: [], active: -1 });
    mock.on("DELETE", "/api/note", {});
    mock.on("POST", "/api/note", { mtime: 2000 });

    const mod = await import("./tab-state.ts");
    openTab = mod.openTab;
    closeTab = mod.closeTab;
    switchTab = mod.switchTab;
    getActiveTab = mod.getActiveTab;
    getTabs = mod.getTabs;
    getActiveIndex = mod.getActiveIndex;
    nextTab = mod.nextTab;
    prevTab = mod.prevTab;
    markDirty = mod.markDirty;
    markClean = mod.markClean;
    updateTabContent = mod.updateTabContent;
    updateTabPath = mod.updateTabPath;
    closeActiveTab = mod.closeActiveTab;
    closeTabByPath = mod.closeTabByPath;
    titleFromPath = mod.titleFromPath;
    createNewNote = mod.createNewNote;
    restoreSession = mod.restoreSession;
    syncToServer = mod.syncToServer;
    setCursor = mod.setCursor;
    getCursor = mod.getCursor;
    clearClosedTabs = mod.clearClosedTabs;
    reopenClosedTab = mod.reopenClosedTab;

    offRender = on("tab:render", () => {});
    offChange = on("tab:change", () => {});
  });

  afterAll(() => {
    mock.restore();
    offRender();
    offChange();
    cleanup();
  });

  test("titleFromPath", () => {
    expect(titleFromPath("notes/hello.md")).toBe("hello");
    expect(titleFromPath("hello.md")).toBe("hello");
    expect(titleFromPath("deep/path/note.MD")).toBe("note");
  });

  test("tab lifecycle", async () => {
    // Clean state and pin mock to avoid pollution from concurrent test files.
    while (getTabs().length > 0) closeTab(0);
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    let renderCount = 0;
    let changeCount = 0;
    const offR = on("tab:render", () => {
      renderCount++;
    });
    const offC = on("tab:change", () => {
      changeCount++;
    });

    // Initially empty
    expect(getActiveTab()).toBe(null);
    expect(getTabs().length).toBe(0);
    expect(getActiveIndex()).toBe(-1);

    // Open tab
    const tab1 = await openTab("notes/hello.md");
    expect(tab1.path).toBe("notes/hello.md");
    expect(tab1.title).toBe("hello");
    expect(tab1.content).toBe("# Test");
    expect(tab1.dirty).toBe(false);
    expect(getTabs().length).toBe(1);
    expect(getActiveIndex()).toBe(0);
    expect(renderCount > 0).toBe(true);
    expect(changeCount > 0).toBe(true);

    // Reopen same tab — no duplicate
    await openTab("notes/hello.md");
    expect(getTabs().length).toBe(1);

    // Open second tab
    await openTab("notes/world.md");
    expect(getTabs().length).toBe(2);
    expect(getActiveIndex()).toBe(1);

    // nextTab / prevTab
    await nextTab();
    expect(getActiveIndex()).toBe(0);
    await prevTab();
    expect(getActiveIndex()).toBe(1);

    // markDirty / markClean
    markDirty("notes/hello.md");
    expect(getTabs()[0]!.dirty).toBe(true);
    markClean("notes/hello.md", "# Updated", 2000);
    expect(getTabs()[0]!.dirty).toBe(false);
    expect(getTabs()[0]!.content).toBe("# Updated");

    // updateTabContent
    updateTabContent("notes/world.md", "# World", 3000);
    expect(getTabs()[1]!.content).toBe("# World");

    // updateTabPath
    updateTabPath("notes/world.md", "notes/earth.md");
    expect(getTabs()[1]!.path).toBe("notes/earth.md");
    expect(getTabs()[1]!.title).toBe("earth");

    // closeTab
    closeTab(0);
    expect(getTabs().length).toBe(1);

    // closeActiveTab
    closeActiveTab();
    expect(getTabs().length).toBe(0);

    offR();
    offC();
  });

  test("createNewNote creates and opens tab for the given name", async () => {
    while (getTabs().length > 0) closeTab(0);

    await createNewNote("My Note");

    expect(getTabs().length).toBe(1);
    expect(getTabs()[0]!.path).toBe("My Note.md");
    expect(getTabs()[0]!.title).toBe("My Note");

    while (getTabs().length > 0) closeTab(0);
  });

  test("createNewNote accepts a path that already ends in .md", async () => {
    while (getTabs().length > 0) closeTab(0);

    await createNewNote("already.md");

    expect(getTabs().length).toBe(1);
    expect(getTabs()[0]!.path).toBe("already.md");

    while (getTabs().length > 0) closeTab(0);
  });

  test("restoreSession restores tabs from saved state", async () => {
    while (getTabs().length > 0) closeTab(0);

    mock.on("GET", "/api/state", { tabs: ["notes/a.md", "notes/b.md"], active: 1 });
    mock.on("GET", "/api/note", { content: "# B", mtime: 5000 });

    await restoreSession();

    expect(getTabs().length).toBe(2);
    expect(getTabs()[0]!.path).toBe("notes/a.md");
    expect(getTabs()[1]!.path).toBe("notes/b.md");
    expect(getActiveIndex()).toBe(1);
    // Active tab should have loaded content
    expect(getTabs()[1]!.content).toBe("# B");
    // Non-active tab has empty content (lazy loaded)
    expect(getTabs()[0]!.content).toBe("");

    while (getTabs().length > 0) closeTab(0);
    // Restore the original mock so other tests aren't affected
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    mock.on("GET", "/api/state", { tabs: [], active: -1 });
  });

  test("restoreSession does nothing with empty state", async () => {
    while (getTabs().length > 0) closeTab(0);

    mock.on("GET", "/api/state", { tabs: [], active: -1 });

    await restoreSession();

    expect(getTabs().length).toBe(0);
  });

  test("switchTab catch block: getNote failure for lazy-loaded tab", async () => {
    while (getTabs().length > 0) closeTab(0);

    // Open two tabs normally
    mock.on("GET", "/api/note", { content: "# A", mtime: 1000 });
    await openTab("notes/a.md");
    mock.on("GET", "/api/note", { content: "# B", mtime: 2000 });
    await openTab("notes/b.md");

    // Manually set tab 0 to lazy state (mtime=0, not dirty) to simulate
    // a tab that was restored from session but not yet loaded
    const tab0 = getTabs()[0]!;
    tab0.content = "";
    tab0.mtime = 0;

    // Make getNote fail for this path
    mock.on("GET", "/api/note", "server error", 500);

    const warnSpy = console.warn;
    let warned = false;
    console.warn = (..._args: unknown[]) => {
      warned = true;
    };

    await switchTab(0);

    console.warn = warnSpy;

    // Tab should still exist but with mtime=0 (load failed)
    expect(getTabs()[0]!.path).toBe("notes/a.md");
    expect(getTabs()[0]!.mtime).toBe(0);
    expect(warned).toBe(true);

    while (getTabs().length > 0) closeTab(0);
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
  });

  test("closeTab adjusts activeIndex when closing tab before active", async () => {
    while (getTabs().length > 0) closeTab(0);

    mock.on("GET", "/api/note", { content: "# X", mtime: 1000 });
    await openTab("notes/x.md");
    await openTab("notes/y.md");
    await openTab("notes/z.md");

    // Switch to tab 2 (index 1 — middle tab)
    await switchTab(1);
    expect(getActiveIndex()).toBe(1);

    // Close tab 0 (before the active tab)
    closeTab(0);

    // activeIndex should decrement from 1 to 0
    expect(getActiveIndex()).toBe(0);
    expect(getActiveTab()!.path).toBe("notes/y.md");
    expect(getTabs().length).toBe(2);

    while (getTabs().length > 0) closeTab(0);
  });

  test("createNewNote catch block: createNote API failure", async () => {
    while (getTabs().length > 0) closeTab(0);

    const origPrompt = globalThis.prompt;
    (globalThis as any).prompt = () => "Failing Note";

    // Make createNote (POST /api/note) fail
    mock.on("POST", "/api/note", "server error", 500);

    const errorSpy = console.error;
    let errorCalled = false;
    console.error = (..._args: unknown[]) => {
      errorCalled = true;
    };

    await createNewNote("Failing Note");

    console.error = errorSpy;

    expect(errorCalled).toBe(true);
    // No tab should have been created since createNote threw
    expect(getTabs().length).toBe(0);

    (globalThis as any).prompt = origPrompt;
    mock.on("POST", "/api/note", { mtime: 2000 });
  });

  test("closeTabByPath closes the tab matching the given path", async () => {
    while (getTabs().length > 0) closeTab(0);

    mock.on("GET", "/api/note", { content: "# X", mtime: 1000 });
    await openTab("notes/x.md");
    await openTab("notes/y.md");
    expect(getTabs().length).toBe(2);

    closeTabByPath("notes/x.md");
    expect(getTabs().length).toBe(1);
    expect(getTabs()[0]!.path).toBe("notes/y.md");

    while (getTabs().length > 0) closeTab(0);
  });

  test("closeTabByPath does nothing when path not open", async () => {
    while (getTabs().length > 0) closeTab(0);

    mock.on("GET", "/api/note", { content: "# X", mtime: 1000 });
    await openTab("notes/x.md");
    expect(getTabs().length).toBe(1);

    closeTabByPath("notes/not-open.md");
    expect(getTabs().length).toBe(1);

    while (getTabs().length > 0) closeTab(0);
  });

  test("setCursor and getCursor round-trip", () => {
    setCursor("notes/x.md", 42);
    expect(getCursor("notes/x.md")).toBe(42);
    expect(getCursor("notes/other.md")).toBeUndefined();
  });

  test("syncToServer is a no-op when no cached session", async () => {
    // Just verify it doesn't throw
    await syncToServer();
  });

  test("clearClosedTabs empties the closed-tabs stack", async () => {
    while (getTabs().length > 0) closeTab(0);
    mock.on("GET", "/api/note", { content: "# X", mtime: 1000 });
    await openTab("notes/x.md");
    closeTab(0); // pushes to closedTabs
    clearClosedTabs();
    // reopenClosedTab should now be a no-op
    await reopenClosedTab();
    expect(getTabs().length).toBe(0);
  });

  test("reopenClosedTab restores the last closed tab", async () => {
    while (getTabs().length > 0) closeTab(0);
    mock.on("GET", "/api/note", { content: "# X", mtime: 1000 });
    await openTab("notes/reopen.md");
    closeTab(0);
    clearClosedTabs(); // start fresh
    // Open and close to populate closedTabs
    await openTab("notes/reopen.md");
    closeTab(0);
    // Now reopen it
    await reopenClosedTab();
    expect(getTabs().length).toBe(1);
    expect(getTabs()[0]!.path).toBe("notes/reopen.md");
    while (getTabs().length > 0) closeTab(0);
  });

  test("restoreSession getNote failure: tab created with empty content", async () => {
    while (getTabs().length > 0) closeTab(0);

    mock.on("GET", "/api/state", { tabs: ["notes/fail.md"], active: 0 });
    // getNote will fail for the active tab
    mock.on("GET", "/api/note", "server error", 500);

    const warnSpy = console.warn;
    let warned = false;
    console.warn = (..._args: unknown[]) => {
      warned = true;
    };

    await restoreSession();

    console.warn = warnSpy;

    expect(warned).toBe(true);
    expect(getTabs().length).toBe(1);
    expect(getTabs()[0]!.path).toBe("notes/fail.md");
    expect(getTabs()[0]!.content).toBe("");
    expect(getTabs()[0]!.mtime).toBe(0);

    while (getTabs().length > 0) closeTab(0);
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    mock.on("GET", "/api/state", { tabs: [], active: -1 });
  });
});
