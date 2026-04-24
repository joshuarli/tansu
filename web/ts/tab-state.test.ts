/// Tests for tab-state.ts — pure data logic, but needs DOM because
/// tabs.ts registers a render listener on the shared event bus.

import { stemFromPath } from "@joshuarli98/md-wysiwyg";

import { on } from "./events.ts";
import type { Tab } from "./tab-state.ts";
import { setupDOM, mockFetch } from "./test-helper.ts";

describe("tab-state", () => {
  let cleanup: () => void;
  let mock: ReturnType<typeof mockFetch>;
  let openTab: (path: string) => Promise<Tab>;
  let closeTab: (i: number) => void;
  let getActiveTab: () => Tab | null;
  let getTabs: () => Tab[];
  let getActiveIndex: () => number;
  let nextTab: () => void;
  let prevTab: () => void;
  let markDirty: (path: string) => void;
  let markClean: (path: string, content: string, mtime: number) => void;
  let updateTabContent: (path: string, content: string, mtime: number) => void;
  let updateTabPath: (oldPath: string, newPath: string) => void;
  let closeActiveTab: () => void;
  let closeTabByPath: (path: string) => void;
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
    ({ openTab } = mod);
    ({ closeTab } = mod);
    ({ switchTab } = mod);
    ({ getActiveTab } = mod);
    ({ getTabs } = mod);
    ({ getActiveIndex } = mod);
    ({ nextTab } = mod);
    ({ prevTab } = mod);
    ({ markDirty } = mod);
    ({ markClean } = mod);
    ({ updateTabContent } = mod);
    ({ updateTabPath } = mod);
    ({ closeActiveTab } = mod);
    ({ closeTabByPath } = mod);
    ({ createNewNote } = mod);
    ({ restoreSession } = mod);
    ({ syncToServer } = mod);
    ({ setCursor } = mod);
    ({ getCursor } = mod);
    ({ clearClosedTabs } = mod);
    ({ reopenClosedTab } = mod);

    offRender = on("tab:render", () => {});
    offChange = on("tab:change", () => {});
  });

  afterAll(() => {
    mock.restore();
    offRender();
    offChange();
    cleanup();
  });

  it("stemFromPath", () => {
    expect(stemFromPath("notes/hello.md")).toBe("hello");
    expect(stemFromPath("hello.md")).toBe("hello");
    expect(stemFromPath("deep/path/note.MD")).toBe("note");
  });

  it("tab lifecycle", async () => {
    // Clean state and pin mock to avoid pollution from concurrent test files.
    while (getTabs().length > 0) {
      closeTab(0);
    }
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
    expect(getActiveTab()).toBeNull();
    expect(getTabs()).toHaveLength(0);
    expect(getActiveIndex()).toBe(-1);

    // Open tab
    const tab1 = await openTab("notes/hello.md");
    expect(tab1.path).toBe("notes/hello.md");
    expect(tab1.title).toBe("hello");
    expect(tab1.content).toBe("# Test");
    expect(tab1.dirty).toBeFalsy();
    expect(getTabs()).toHaveLength(1);
    expect(getActiveIndex()).toBe(0);
    expect(renderCount).toBeGreaterThan(0);
    expect(changeCount).toBeGreaterThan(0);

    // Reopen same tab — no duplicate
    await openTab("notes/hello.md");
    expect(getTabs()).toHaveLength(1);

    // Open second tab
    await openTab("notes/world.md");
    expect(getTabs()).toHaveLength(2);
    expect(getActiveIndex()).toBe(1);

    // nextTab / prevTab
    await nextTab();
    expect(getActiveIndex()).toBe(0);
    await prevTab();
    expect(getActiveIndex()).toBe(1);

    // markDirty / markClean
    markDirty("notes/hello.md");
    expect(getTabs()[0]!.dirty).toBeTruthy();
    markClean("notes/hello.md", "# Updated", 2000);
    expect(getTabs()[0]!.dirty).toBeFalsy();
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
    expect(getTabs()).toHaveLength(1);

    // closeActiveTab
    closeActiveTab();
    expect(getTabs()).toHaveLength(0);

    offR();
    offC();
  });

  it("createNewNote creates and opens tab for the given name", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }

    await createNewNote("My Note");

    expect(getTabs()).toHaveLength(1);
    expect(getTabs()[0]!.path).toBe("My Note.md");
    expect(getTabs()[0]!.title).toBe("My Note");

    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("createNewNote accepts a path that already ends in .md", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }

    await createNewNote("already.md");

    expect(getTabs()).toHaveLength(1);
    expect(getTabs()[0]!.path).toBe("already.md");

    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("restoreSession restores tabs from saved state", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }

    mock.on("GET", "/api/state", { tabs: ["notes/a.md", "notes/b.md"], active: 1 });
    mock.on("GET", "/api/note", { content: "# B", mtime: 5000 });

    await restoreSession();

    expect(getTabs()).toHaveLength(2);
    expect(getTabs()[0]!.path).toBe("notes/a.md");
    expect(getTabs()[1]!.path).toBe("notes/b.md");
    expect(getActiveIndex()).toBe(1);
    // Active tab should have loaded content
    expect(getTabs()[1]!.content).toBe("# B");
    // Non-active tab has empty content (lazy loaded)
    expect(getTabs()[0]!.content).toBe("");

    while (getTabs().length > 0) {
      closeTab(0);
    }
    // Restore the original mock so other tests aren't affected
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    mock.on("GET", "/api/state", { tabs: [], active: -1 });
  });

  it("restoreSession does nothing with empty state", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }

    mock.on("GET", "/api/state", { tabs: [], active: -1 });

    await restoreSession();

    expect(getTabs()).toHaveLength(0);
  });

  it("switchTab catch block: getNote failure for lazy-loaded tab", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }

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
    expect(warned).toBeTruthy();

    while (getTabs().length > 0) {
      closeTab(0);
    }
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
  });

  it("closeTab adjusts activeIndex when closing tab before active", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }

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
    expect(getTabs()).toHaveLength(2);

    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("createNewNote catch block: createNote API failure", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }

    const origPrompt = globalThis.prompt;
    (globalThis as unknown as Record<string, unknown>)["prompt"] = () => "Failing Note";

    // Make createNote (POST /api/note) fail
    mock.on("POST", "/api/note", "server error", 500);

    const errorSpy = console.error;
    let errorCalled = false;
    console.error = (..._args: unknown[]) => {
      errorCalled = true;
    };

    await createNewNote("Failing Note");

    console.error = errorSpy;

    expect(errorCalled).toBeTruthy();
    // No tab should have been created since createNote threw
    expect(getTabs()).toHaveLength(0);

    (globalThis as unknown as Record<string, unknown>)["prompt"] = origPrompt;
    mock.on("POST", "/api/note", { mtime: 2000 });
  });

  it("closeTabByPath closes the tab matching the given path", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }

    mock.on("GET", "/api/note", { content: "# X", mtime: 1000 });
    await openTab("notes/x.md");
    await openTab("notes/y.md");
    expect(getTabs()).toHaveLength(2);

    closeTabByPath("notes/x.md");
    expect(getTabs()).toHaveLength(1);
    expect(getTabs()[0]!.path).toBe("notes/y.md");

    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("closeTabByPath does nothing when path not open", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }

    mock.on("GET", "/api/note", { content: "# X", mtime: 1000 });
    await openTab("notes/x.md");
    expect(getTabs()).toHaveLength(1);

    closeTabByPath("notes/not-open.md");
    expect(getTabs()).toHaveLength(1);

    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("setCursor and getCursor round-trip", () => {
    setCursor("notes/x.md", 42);
    expect(getCursor("notes/x.md")).toBe(42);
    expect(getCursor("notes/other.md")).toBeUndefined();
  });

  it("syncToServer is a no-op when no cached session", async () => {
    // Just verify it doesn't throw
    await syncToServer();
  });

  it("clearClosedTabs empties the closed-tabs stack", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }
    mock.on("GET", "/api/note", { content: "# X", mtime: 1000 });
    await openTab("notes/x.md");
    closeTab(0); // pushes to closedTabs
    clearClosedTabs();
    // reopenClosedTab should now be a no-op
    await reopenClosedTab();
    expect(getTabs()).toHaveLength(0);
  });

  it("reopenClosedTab restores the last closed tab", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }
    mock.on("GET", "/api/note", { content: "# X", mtime: 1000 });
    await openTab("notes/reopen.md");
    closeTab(0);
    clearClosedTabs(); // start fresh
    // Open and close to populate closedTabs
    await openTab("notes/reopen.md");
    closeTab(0);
    // Now reopen it
    await reopenClosedTab();
    expect(getTabs()).toHaveLength(1);
    expect(getTabs()[0]!.path).toBe("notes/reopen.md");
    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("restoreSession getNote failure: tab created with empty content", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }

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

    expect(warned).toBeTruthy();
    expect(getTabs()).toHaveLength(1);
    expect(getTabs()[0]!.path).toBe("notes/fail.md");
    expect(getTabs()[0]!.content).toBe("");
    expect(getTabs()[0]!.mtime).toBe(0);

    while (getTabs().length > 0) {
      closeTab(0);
    }
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    mock.on("GET", "/api/state", { tabs: [], active: -1 });
  });
});
