/// Tests for tab-state.ts — pure data logic, but needs DOM because
/// tabs.ts registers a render listener on the shared event bus.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
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
  let titleFromPath: (path: string) => string;
  let createNewNote: () => Promise<void>;
  let restoreSession: () => Promise<void>;
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
    titleFromPath = mod.titleFromPath;
    createNewNote = mod.createNewNote;
    restoreSession = mod.restoreSession;

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
    // Track renders and tab changes
    let renderCount = 0;
    let changeCount = 0;
    const offR = on("tab:render", () => { renderCount++; });
    const offC = on("tab:change", () => { changeCount++; });

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

  test("createNewNote creates and opens tab when prompt returns a name", async () => {
    // Clean state
    while (getTabs().length > 0) closeTab(0);

    const origPrompt = globalThis.prompt;
    (globalThis as any).prompt = () => "My Note";

    await createNewNote();

    expect(getTabs().length).toBe(1);
    expect(getTabs()[0]!.path).toBe("My Note.md");
    expect(getTabs()[0]!.title).toBe("My Note");

    (globalThis as any).prompt = origPrompt;
    while (getTabs().length > 0) closeTab(0);
  });

  test("createNewNote does nothing when prompt is cancelled", async () => {
    while (getTabs().length > 0) closeTab(0);

    const origPrompt = globalThis.prompt;
    (globalThis as any).prompt = () => null;

    await createNewNote();

    expect(getTabs().length).toBe(0);

    (globalThis as any).prompt = origPrompt;
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
});
