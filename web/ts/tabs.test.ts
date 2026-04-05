import { describe, test, expect, beforeAll, afterAll } from "bun:test";

import { setupDOM, mockFetch } from "./test-helper.ts";

describe("tabs", () => {
  let cleanup: () => void;
  let mock: ReturnType<typeof mockFetch>;
  let openTab: (path: string) => Promise<any>;
  let closeTab: (i: number) => void;
  let getTabs: () => any[];
  let getActiveIndex: () => number;
  let markDirty: (path: string) => void;
  let closeActiveTab: () => void;
  let switchTab: (index: number) => Promise<void>;

  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  beforeAll(async () => {
    cleanup = setupDOM();
    mock = mockFetch();

    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    mock.on("PUT", "/api/state", {});
    mock.on("GET", "/api/state", { tabs: [], active: -1 });
    mock.on("DELETE", "/api/note", {});
    mock.on("POST", "/api/note", { mtime: 2000 });

    const mod = await import("./tabs.ts");
    openTab = mod.openTab;
    closeTab = mod.closeTab;
    switchTab = mod.switchTab;
    getTabs = mod.getTabs;
    getActiveIndex = mod.getActiveIndex;
    markDirty = mod.markDirty;
    closeActiveTab = mod.closeActiveTab;

    // Clean up any leaked state from other test files sharing the module.
    while (getTabs().length > 0) closeTab(0);
  });

  afterAll(() => {
    mock.restore();
    cleanup();
  });

  // Helper: ensure a clean slate before each DOM test.
  async function openTwo() {
    while (getTabs().length > 0) closeTab(0);
    await openTab("notes/alpha.md");
    await openTab("notes/beta.md");
    await tick();
  }

  test("tab bar renders correct number of tabs", async () => {
    await openTwo();
    const tabBar = document.getElementById("tab-bar")!;
    const tabEls = tabBar.querySelectorAll(".tab:not(.tab-new)");
    expect(tabEls.length).toBe(2);
    while (getTabs().length > 0) closeTab(0);
  });

  test("empty-state hides when tabs are open, shows when all closed", async () => {
    const emptyState = document.getElementById("empty-state")!;
    await openTwo();
    expect(emptyState.style.display).toBe("none");
    while (getTabs().length > 0) {
      closeTab(0);
      await tick();
    }
    expect(emptyState.style.display).toBe("flex");
  });

  test("active tab gets .active class; others do not", async () => {
    await openTwo();
    const tabBar = document.getElementById("tab-bar")!;
    const tabEls = tabBar.querySelectorAll(".tab:not(.tab-new)");
    // beta was opened second so it is active (index 1)
    expect(tabEls[1]!.classList.contains("active")).toBe(true);
    expect(tabEls[0]!.classList.contains("active")).toBe(false);
    while (getTabs().length > 0) closeTab(0);
  });

  test("tab labels match note titles", async () => {
    await openTwo();
    const tabBar = document.getElementById("tab-bar")!;
    const labels = tabBar.querySelectorAll(".tab:not(.tab-new) span:not(.close):not(.dirty)");
    expect(labels[0]!.textContent).toBe("alpha");
    expect(labels[1]!.textContent).toBe("beta");
    while (getTabs().length > 0) closeTab(0);
  });

  test("+ button is always present", async () => {
    await openTwo();
    const tabBar = document.getElementById("tab-bar")!;
    const addBtn = tabBar.querySelector(".tab-new");
    expect(addBtn !== null).toBe(true);
    expect(addBtn!.textContent).toBe("+");
    while (getTabs().length > 0) closeTab(0);
  });

  test("dirty indicator appears after markDirty, absent otherwise", async () => {
    await openTwo();
    const tabBar = document.getElementById("tab-bar")!;
    const tabEls = () => tabBar.querySelectorAll(".tab:not(.tab-new)");

    expect(tabEls()[0]!.querySelector(".dirty")).toBe(null);
    markDirty("notes/alpha.md");
    await tick();
    expect(tabEls()[0]!.querySelector(".dirty") !== null).toBe(true);
    expect(tabEls()[1]!.querySelector(".dirty")).toBe(null);
    while (getTabs().length > 0) closeTab(0);
  });

  test("close button on tab removes that tab", async () => {
    await openTwo();
    const tabBar = document.getElementById("tab-bar")!;
    markDirty("notes/alpha.md");
    await tick();
    const tabEls = tabBar.querySelectorAll(".tab:not(.tab-new)");
    const closeBtn = tabEls[0]!.querySelector(".close") as HTMLElement;
    closeBtn.click();
    await tick();
    const remaining = tabBar.querySelectorAll(".tab:not(.tab-new)");
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.querySelector("span:not(.close):not(.dirty)")!.textContent).toBe("beta");
    while (getTabs().length > 0) closeTab(0);
  });

  test("context menu appears on right-click with Rename / Delete / Close", async () => {
    while (getTabs().length > 0) closeTab(0);
    await openTab("notes/gamma.md");
    await tick();
    const tabBar = document.getElementById("tab-bar")!;
    const tabEl = tabBar.querySelectorAll(".tab:not(.tab-new)")[0]!;
    (tabEl as HTMLElement).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }),
    );
    await tick();
    const menu = document.body.querySelector(".context-menu");
    expect(menu !== null).toBe(true);
    const items = menu!.querySelectorAll(".context-menu-item");
    expect(items.length).toBe(3);
    expect(items[0]!.textContent).toBe("Rename...");
    expect(items[1]!.textContent).toBe("Delete");
    expect(items[2]!.textContent).toBe("Close");
    while (getTabs().length > 0) closeTab(0);
  });

  test("context menu Close removes the tab", async () => {
    while (getTabs().length > 0) closeTab(0);
    await openTab("notes/gamma.md");
    await openTab("notes/delta.md");
    await tick();
    const tabBar = document.getElementById("tab-bar")!;
    const countBefore = tabBar.querySelectorAll(".tab:not(.tab-new)").length;
    const tabEl = tabBar.querySelectorAll(".tab:not(.tab-new)")[0]!;
    (tabEl as HTMLElement).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
    await tick();
    const items = document.body.querySelectorAll(".context-menu-item");
    (items[2] as HTMLElement).click();
    await tick();
    expect(document.body.querySelector(".context-menu")).toBe(null);
    expect(tabBar.querySelectorAll(".tab:not(.tab-new)").length).toBe(countBefore - 1);
    while (getTabs().length > 0) closeTab(0);
  });

  test("context menu Delete removes tab after confirm", async () => {
    while (getTabs().length > 0) closeTab(0);
    await openTab("notes/to-delete.md");
    await tick();
    const tabBar = document.getElementById("tab-bar")!;
    const countBefore = getTabs().length;
    const tabEl = tabBar.querySelectorAll(".tab:not(.tab-new)")[countBefore - 1]!;
    (tabEl as HTMLElement).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }),
    );
    await tick();
    const menu = document.body.querySelector(".context-menu");
    const items = menu!.querySelectorAll(".context-menu-item");
    expect(items[1]!.textContent).toBe("Delete");
    expect(items[1]!.classList.contains("danger")).toBe(true);
    (items[1] as HTMLElement).click();
    await tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(getTabs().length).toBe(countBefore - 1);
    expect(document.body.querySelector(".context-menu")).toBe(null);
  });

  test("context menu Rename dispatches tansu:rename event", async () => {
    while (getTabs().length > 0) closeTab(0);
    await openTab("notes/to-rename.md");
    await tick();
    const tabBar = document.getElementById("tab-bar")!;
    const tabEl = tabBar.querySelectorAll(".tab:not(.tab-new)")[getTabs().length - 1]!;

    let renameDetail: any = null;
    const handler = (e: Event) => {
      renameDetail = (e as CustomEvent).detail;
    };
    window.addEventListener("tansu:rename", handler);

    (tabEl as HTMLElement).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }),
    );
    await tick();
    const items = document.body.querySelectorAll(".context-menu-item");
    expect(items[0]!.textContent).toBe("Rename...");
    (items[0] as HTMLElement).click();
    await tick();

    expect(renameDetail !== null).toBe(true);
    expect(renameDetail.path).toBe("notes/to-rename.md");
    expect(renameDetail.newName).toBe("test");

    window.removeEventListener("tansu:rename", handler);
    while (getTabs().length > 0) closeTab(0);
  });
});
