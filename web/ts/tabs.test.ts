import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setupDOM, mockFetch } from "./test-helper.ts";

describe("tabs", () => {
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
  let offChange: () => void;

  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  beforeAll(async () => {
    cleanup = setupDOM();
    mock = mockFetch();

    // Mock API responses needed by tabs
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    mock.on("PUT", "/api/state", {});
    mock.on("GET", "/api/state", { tabs: [], active: -1 });
    mock.on("DELETE", "/api/note", {});
    mock.on("POST", "/api/note", { mtime: 2000 });

    const mod = await import("./tabs.ts");
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

    const { on } = await import("./events.ts");

    // Clean up any leaked state from other test files sharing the module
    while (getTabs().length > 0) closeTab(0);

    let changeCount = 0;
    offChange = on("tab:change", () => { changeCount++; });
  });

  afterAll(() => {
    mock.restore();
    offChange();
    cleanup();
  });

  test("tab state lifecycle", async () => {
    expect(getActiveTab()).toBe(null);
    expect(getTabs().length).toBe(0);
    expect(getActiveIndex()).toBe(-1);

    // Track tab changes
    let changeCount = 0;
    const { on } = await import("./events.ts");
    const offC = on("tab:change", () => { changeCount++; });

    // Open a tab
    const tab1 = await openTab("notes/hello.md");
    expect(tab1.path).toBe("notes/hello.md");
    expect(tab1.title).toBe("hello");
    expect(tab1.content).toBe("# Test");
    expect(tab1.dirty).toBe(false);
    expect(getTabs().length).toBe(1);
    expect(getActiveIndex()).toBe(0);
    expect(changeCount > 0).toBe(true);

    // Open same tab again — should not duplicate
    const tab1Again = await openTab("notes/hello.md");
    expect(getTabs().length).toBe(1);
    expect(tab1Again.path).toBe(tab1.path);

    // Open second tab
    await openTab("notes/world.md");
    expect(getTabs().length).toBe(2);
    expect(getActiveIndex()).toBe(1);
    expect(getActiveTab()!.path).toBe("notes/world.md");

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
    expect(getTabs()[0]!.mtime).toBe(2000);

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
    expect(getActiveTab()!.path).toBe("notes/earth.md");

    // closeActiveTab
    closeActiveTab();
    expect(getTabs().length).toBe(0);
    expect(getActiveTab()).toBe(null);

    offC();
  });

  test("DOM rendering", async () => {
    const tabBar = document.getElementById("tab-bar")!;
    const emptyState = document.getElementById("empty-state")!;

    // Open two tabs and check DOM.
    await openTab("notes/alpha.md");
    await openTab("notes/beta.md");
    await tick();

    const tabEls = tabBar.querySelectorAll(".tab:not(.tab-new)");
    expect(tabEls.length).toBe(2);
    expect(emptyState.style.display).toBe("none");

    // Active tab (index 1, beta) has .active class; alpha does not.
    expect(tabEls[1]!.classList.contains("active")).toBe(true);
    expect(tabEls[0]!.classList.contains("active")).toBe(false);

    // Tab labels match titles.
    const labels = tabBar.querySelectorAll(".tab:not(.tab-new) span:not(.close):not(.dirty)");
    expect(labels[0]!.textContent).toBe("alpha");
    expect(labels[1]!.textContent).toBe("beta");

    // "+" button is still present alongside real tabs.
    const addBtn = tabBar.querySelector(".tab-new");
    expect(addBtn !== null).toBe(true);
    expect(addBtn!.textContent).toBe("+");

    // Dirty indicator: no dot before markDirty.
    expect(tabEls[0]!.querySelector(".dirty")).toBe(null);
    markDirty("notes/alpha.md");
    await tick();

    const tabElsAfterDirty = tabBar.querySelectorAll(".tab:not(.tab-new)");
    expect(tabElsAfterDirty[0]!.querySelector(".dirty") !== null).toBe(true);
    expect(tabElsAfterDirty[1]!.querySelector(".dirty")).toBe(null);

    // Close button triggers closeTab: click the close button on the first tab.
    const closeBtn = tabElsAfterDirty[0]!.querySelector(".close") as HTMLElement;
    expect(closeBtn !== null).toBe(true);
    closeBtn.click();
    await tick();

    const tabElsAfterClose = tabBar.querySelectorAll(".tab:not(.tab-new)");
    expect(tabElsAfterClose.length).toBe(1);
    expect(
      tabElsAfterClose[0]!.querySelector("span:not(.close):not(.dirty)")!.textContent,
    ).toBe("beta");

    // Context menu: right-clicking a tab should create .context-menu in the body.
    await openTab("notes/gamma.md");
    await tick();

    const tabForCtx = tabBar.querySelectorAll(".tab:not(.tab-new)")[0]!;
    const ctxEvent = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 50,
      clientY: 50,
    });
    (tabForCtx as HTMLElement).dispatchEvent(ctxEvent);
    await tick();

    const menu = document.body.querySelector(".context-menu");
    expect(menu !== null).toBe(true);

    // Context menu items: Rename, Delete, Close.
    const items = menu!.querySelectorAll(".context-menu-item");
    expect(items.length).toBe(3);
    expect(items[0]!.textContent).toBe("Rename...");
    expect(items[1]!.textContent).toBe("Delete");
    expect(items[2]!.textContent).toBe("Close");

    // Clicking "Close" in the context menu removes the tab and hides the menu.
    const tabCountBeforeCtxClose = tabBar.querySelectorAll(".tab:not(.tab-new)").length;
    (items[2] as HTMLElement).click();
    await tick();

    const menuAfter = document.body.querySelector(".context-menu");
    expect(menuAfter).toBe(null);
    const tabCountAfterCtxClose = tabBar.querySelectorAll(".tab:not(.tab-new)").length;
    expect(tabCountAfterCtxClose).toBe(tabCountBeforeCtxClose - 1);

    // Close all remaining tabs so state is clean for teardown.
    while (getTabs().length > 0) {
      closeTab(0);
      await tick();
    }

    expect(emptyState.style.display).toBe("flex");
  });

  test("context menu Delete removes tab after confirm", async () => {
    const tabBar = document.getElementById("tab-bar")!;

    await openTab("notes/to-delete.md");
    await tick();

    const tabCountBefore = getTabs().length;
    const tabEl = tabBar.querySelectorAll(".tab:not(.tab-new)")[tabCountBefore - 1]!;

    // Right-click to open context menu
    const ctxEvent = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 100,
      clientY: 100,
    });
    (tabEl as HTMLElement).dispatchEvent(ctxEvent);
    await tick();

    const menu = document.body.querySelector(".context-menu");
    expect(menu !== null).toBe(true);

    // Click "Delete" (second item) — confirm is mocked to return true
    const items = menu!.querySelectorAll(".context-menu-item");
    expect(items[1]!.textContent).toBe("Delete");
    expect(items[1]!.classList.contains("danger")).toBe(true);
    (items[1] as HTMLElement).click();
    await tick();
    // Allow the deleteNote promise to resolve
    await new Promise((r) => setTimeout(r, 50));

    expect(getTabs().length).toBe(tabCountBefore - 1);
    // Menu should be removed
    expect(document.body.querySelector(".context-menu")).toBe(null);
  });

  test("context menu Rename dispatches tansu:rename event", async () => {
    const tabBar = document.getElementById("tab-bar")!;

    await openTab("notes/to-rename.md");
    await tick();

    const tabCount = getTabs().length;
    const tabEl = tabBar.querySelectorAll(".tab:not(.tab-new)")[tabCount - 1]!;

    // Listen for the rename event
    let renameDetail: any = null;
    const handler = (e: Event) => {
      renameDetail = (e as CustomEvent).detail;
    };
    window.addEventListener("tansu:rename", handler);

    // Right-click to open context menu
    const ctxEvent = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 100,
      clientY: 100,
    });
    (tabEl as HTMLElement).dispatchEvent(ctxEvent);
    await tick();

    const menu = document.body.querySelector(".context-menu");
    const items = menu!.querySelectorAll(".context-menu-item");
    expect(items[0]!.textContent).toBe("Rename...");

    // prompt is mocked to return "test" by setupDOM
    (items[0] as HTMLElement).click();
    await tick();

    expect(renameDetail !== null).toBe(true);
    expect(renameDetail.path).toBe("notes/to-rename.md");
    expect(renameDetail.newName).toBe("test");

    window.removeEventListener("tansu:rename", handler);

    // Clean up
    while (getTabs().length > 0) {
      closeTab(0);
      await tick();
    }
  });
});
