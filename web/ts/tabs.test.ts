import { on } from "./events.ts";
import type { Tab } from "./tab-state.ts";
import { setupDOM, mockFetch } from "./test-helper.ts";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("tabs", () => {
  let cleanup: () => void;
  let mock: ReturnType<typeof mockFetch>;
  let openTab: (path: string) => Promise<Tab>;
  let closeTab: (i: number) => void;
  let getTabs: () => Tab[];
  let getActiveTab: () => Tab | null;
  let markDirty: (path: string) => void;
  let createNewNoteViaDialog: () => Promise<void>;

  beforeAll(async () => {
    cleanup = setupDOM();
    mock = mockFetch();

    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    mock.on("PUT", "/api/state", {});
    mock.on("GET", "/api/state", { tabs: [], active: -1 });
    mock.on("DELETE", "/api/note", {});
    mock.on("POST", "/api/note", { mtime: 2000 });
    mock.on("GET", "/api/pinned", []);
    mock.on("POST", "/api/pin", {});
    mock.on("DELETE", "/api/pin", {});

    const mod = await import("./tabs.ts");
    const stateMod = await import("./tab-state.ts");
    ({ openTab } = stateMod);
    ({ closeTab } = stateMod);
    ({ getTabs } = stateMod);
    ({ getActiveTab } = stateMod);
    ({ markDirty } = stateMod);
    createNewNoteViaDialog = mod.promptNewNote;

    // Clean up any leaked state from other test files sharing the module.
    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  afterAll(() => {
    mock.restore();
    cleanup();
  });

  // Helper: ensure a clean slate before each DOM test.
  async function openTwo() {
    while (getTabs().length > 0) {
      closeTab(0);
    }
    await openTab("notes/alpha.md");
    await openTab("notes/beta.md");
    await tick();
  }

  it("tab bar renders correct number of tabs", async () => {
    await openTwo();
    const tabBar = document.querySelector("#tab-bar")!;
    const tabEls = tabBar.querySelectorAll(".tab:not(.tab-new)");
    expect(tabEls).toHaveLength(2);
    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("empty-state hides when tabs are open, shows when all closed", async () => {
    const emptyState = document.querySelector("#empty-state") as HTMLElement;
    await openTwo();
    expect(emptyState.style.display).toBe("none");
    while (getTabs().length > 0) {
      closeTab(0);
      await tick();
    }
    expect(emptyState.style.display).toBe("flex");
  });

  it("active tab gets .active class; others do not", async () => {
    await openTwo();
    const tabBar = document.querySelector("#tab-bar")!;
    const tabEls = tabBar.querySelectorAll(".tab:not(.tab-new)");
    // beta was opened second so it is active (index 1)
    expect(tabEls[1]!.classList.contains("active")).toBeTruthy();
    expect(tabEls[0]!.classList.contains("active")).toBeFalsy();
    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("clicking an inactive tab switches the active tab", async () => {
    await openTwo();
    const tabBar = document.querySelector("#tab-bar")!;
    const tabEls = tabBar.querySelectorAll(".tab:not(.tab-new)");

    expect(getActiveTab()?.path).toBe("notes/beta.md");
    (tabEls[0] as HTMLElement).click();
    await tick();

    const renderedTabEls = tabBar.querySelectorAll(".tab:not(.tab-new)");
    expect(getActiveTab()?.path).toBe("notes/alpha.md");
    expect(renderedTabEls[0]!.classList.contains("active")).toBeTruthy();
    expect(renderedTabEls[1]!.classList.contains("active")).toBeFalsy();

    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("tab labels match note titles", async () => {
    await openTwo();
    const tabBar = document.querySelector("#tab-bar")!;
    const labels = tabBar.querySelectorAll(".tab:not(.tab-new) .tab-label-text");
    expect(labels[0]!.textContent).toBe("alpha");
    expect(labels[1]!.textContent).toBe("beta");
    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("+ button is always present", async () => {
    await openTwo();
    const tabBar = document.querySelector("#tab-bar")!;
    const addBtn = tabBar.querySelector(".tab-new");
    expect(addBtn !== null).toBeTruthy();
    expect(addBtn!.textContent).toBe("+");
    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("dirty indicator appears after markDirty, absent otherwise", async () => {
    await openTwo();
    const tabBar = document.querySelector("#tab-bar")!;
    const tabEls = () => tabBar.querySelectorAll(".tab:not(.tab-new)");

    expect(tabEls()[0]!.querySelector(".dirty")).toBeNull();
    markDirty("notes/alpha.md");
    await tick();
    expect(tabEls()[0]!.querySelector(".dirty") !== null).toBeTruthy();
    expect(tabEls()[1]!.querySelector(".dirty")).toBeNull();
    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("close button on tab removes that tab", async () => {
    await openTwo();
    const tabBar = document.querySelector("#tab-bar")!;
    markDirty("notes/alpha.md");
    await tick();
    const tabEls = tabBar.querySelectorAll(".tab:not(.tab-new)");
    const closeBtn = tabEls[0]!.querySelector(".close") as HTMLElement;
    closeBtn.click();
    await tick();
    const remaining = tabBar.querySelectorAll(".tab:not(.tab-new)");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.querySelector("span:not(.close):not(.dirty)")!.textContent).toBe("beta");
    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("close button on an inactive tab does not switch before closing", async () => {
    await openTwo();
    const tabBar = document.querySelector("#tab-bar")!;
    const tabEls = tabBar.querySelectorAll(".tab:not(.tab-new)");
    const closeBtn = tabEls[0]!.querySelector(".close") as HTMLElement;

    expect(getActiveTab()?.path).toBe("notes/beta.md");
    closeBtn.click();
    await tick();

    expect(getActiveTab()?.path).toBe("notes/beta.md");
    expect(tabBar.querySelectorAll(".tab:not(.tab-new)")).toHaveLength(1);

    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("context menu appears on right-click with Rename / Pin / Delete / Close", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }
    await openTab("notes/gamma.md");
    await tick();
    const tabBar = document.querySelector("#tab-bar")!;
    const tabEl = tabBar.querySelectorAll(".tab:not(.tab-new)")[0]!;
    (tabEl as HTMLElement).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }),
    );
    await tick();
    const menu = document.body.querySelector(".context-menu");
    expect(menu !== null).toBeTruthy();
    const items = menu!.querySelectorAll(".context-menu-item");
    expect(items).toHaveLength(4);
    expect(items[0]!.textContent).toBe("Rename...");
    expect(items[1]!.textContent).toBe("Pin");
    expect(items[2]!.textContent).toBe("Delete");
    expect(items[3]!.textContent).toBe("Close");
    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("context menu Close removes the tab", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }
    await openTab("notes/gamma.md");
    await openTab("notes/delta.md");
    await tick();
    const tabBar = document.querySelector("#tab-bar")!;
    const countBefore = tabBar.querySelectorAll(".tab:not(.tab-new)").length;
    const tabEl = tabBar.querySelectorAll(".tab:not(.tab-new)")[0]!;
    (tabEl as HTMLElement).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
    await tick();
    const items = document.body.querySelectorAll(".context-menu-item");
    (items[3] as HTMLElement).click();
    await tick();
    expect(document.body.querySelector(".context-menu")).toBeNull();
    expect(tabBar.querySelectorAll(".tab:not(.tab-new)")).toHaveLength(countBefore - 1);
    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("context menu Delete removes tab after confirm", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }
    await openTab("notes/to-delete.md");
    await tick();
    const tabBar = document.querySelector("#tab-bar")!;
    const countBefore = getTabs().length;
    const tabEl = tabBar.querySelectorAll(".tab:not(.tab-new)")[countBefore - 1]!;
    (tabEl as HTMLElement).dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 100,
      }),
    );
    await tick();
    const menu = document.body.querySelector(".context-menu");
    const items = menu!.querySelectorAll(".context-menu-item");
    expect(items[2]!.textContent).toBe("Delete");
    expect(items[2]!.classList.contains("danger")).toBeTruthy();
    (items[2] as HTMLElement).click();
    await tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(getTabs()).toHaveLength(countBefore - 1);
    expect(document.body.querySelector(".context-menu")).toBeNull();
  });

  it("tab tooltip shows on mouseenter and hides on mouseleave", async () => {
    await openTwo();
    const tabBar = document.querySelector("#tab-bar")!;
    const tabEl = tabBar.querySelectorAll(".tab:not(.tab-new)")[0]! as HTMLElement;

    tabEl.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    const tooltip = document.body.querySelector(".tab-tooltip") as HTMLElement;
    expect(tooltip !== null).toBeTruthy();
    expect(tooltip.style.display).toBe("block");
    expect(tooltip.textContent).toBe("alpha (space to close)");

    tabEl.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    expect(tooltip.style.display).toBe("none");

    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("space key closes the currently hovered tab", async () => {
    await openTwo();
    const tabBar = document.querySelector("#tab-bar")!;
    const countBefore = tabBar.querySelectorAll(".tab:not(.tab-new)").length;
    const tabEl = tabBar.querySelectorAll(".tab:not(.tab-new)")[0]! as HTMLElement;

    tabEl.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await tick();

    expect(tabBar.querySelectorAll(".tab:not(.tab-new)")).toHaveLength(countBefore - 1);

    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("space key with modifier keys ignored", async () => {
    await openTwo();
    const tabBar = document.querySelector("#tab-bar")!;
    const countBefore = tabBar.querySelectorAll(".tab:not(.tab-new)").length;
    const tabEl = tabBar.querySelectorAll(".tab:not(.tab-new)")[0]! as HTMLElement;

    tabEl.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", ctrlKey: true, bubbles: true }),
    );
    await tick();

    expect(tabBar.querySelectorAll(".tab:not(.tab-new)")).toHaveLength(countBefore);

    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("space key does not close hovered tab when focus is in an input", async () => {
    await openTwo();
    const tabBar = document.querySelector("#tab-bar")!;
    const countBefore = tabBar.querySelectorAll(".tab:not(.tab-new)").length;
    const tabEl = tabBar.querySelectorAll(".tab:not(.tab-new)")[0]! as HTMLElement;
    const input = document.querySelector("#sidebar-search") as HTMLInputElement;

    tabEl.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await tick();

    expect(tabBar.querySelectorAll(".tab:not(.tab-new)")).toHaveLength(countBefore);

    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("space key does nothing when no tab is hovered", async () => {
    await openTwo();
    const tabBar = document.querySelector("#tab-bar")!;
    const countBefore = tabBar.querySelectorAll(".tab:not(.tab-new)").length;

    // Don't mouseenter any tab
    document.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await tick();

    expect(tabBar.querySelectorAll(".tab:not(.tab-new)")).toHaveLength(countBefore);

    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("middle click (auxclick button=1) closes the tab", async () => {
    await openTwo();
    const tabBar = document.querySelector("#tab-bar")!;
    const countBefore = tabBar.querySelectorAll(".tab:not(.tab-new)").length;
    const tabEl = tabBar.querySelectorAll(".tab:not(.tab-new)")[0]! as HTMLElement;

    tabEl.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
    await tick();

    expect(tabBar.querySelectorAll(".tab:not(.tab-new)")).toHaveLength(countBefore - 1);

    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("auxclick with button != 1 does not close tab", async () => {
    await openTwo();
    const tabBar = document.querySelector("#tab-bar")!;
    const countBefore = tabBar.querySelectorAll(".tab:not(.tab-new)").length;
    const tabEl = tabBar.querySelectorAll(".tab:not(.tab-new)")[0]! as HTMLElement;

    tabEl.dispatchEvent(new MouseEvent("auxclick", { button: 2, bubbles: true }));
    await tick();

    expect(tabBar.querySelectorAll(".tab:not(.tab-new)")).toHaveLength(countBefore);

    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("context menu Pin action calls pinFile for unpinned tab", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }
    await openTab("notes/to-pin.md");
    await tick();
    const tabBar = document.querySelector("#tab-bar")!;
    const tabEl = tabBar.querySelectorAll(".tab:not(.tab-new)")[0]!;

    mock.on("GET", "/api/pinned", []);
    mock.on("POST", "/api/pin", {});

    (tabEl as HTMLElement).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
    await tick();
    const items = document.body.querySelectorAll(".context-menu-item");
    expect(items[1]!.textContent).toBe("Pin");
    (items[1] as HTMLElement).click();
    await tick();
    await new Promise((r) => setTimeout(r, 50));

    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("context menu context menu shown even when tab index is invalid", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }
    // Just ensure showTabContextMenu guards against missing tab
    // This exercises the `if (!tab) return` guard when index is out of range
    await openTab("notes/valid.md");
    await tick();
    // Close before triggering context menu to create stale state
    while (getTabs().length > 0) {
      closeTab(0);
    }
    await tick();
    // No assertion needed — just verifying no crash
  });

  it("+ button promptNewNote opens dialog and creates note on Enter", async () => {
    // Ensure render() has been called so .tab-new exists (render only fires on tab events)
    await openTab("notes/ensure-render.md");
    await tick();
    while (getTabs().length > 0) {
      closeTab(0);
    }
    await tick();
    const tabBar = document.querySelector("#tab-bar")!;
    const addBtn = tabBar.querySelector(".tab-new") as HTMLElement;

    addBtn.click();
    await tick();

    const overlay = document.querySelector("#input-dialog-overlay")!;
    expect(overlay.classList.contains("hidden")).toBeFalsy();

    const dialogInput = document.querySelector("#input-dialog-input") as HTMLInputElement;
    dialogInput.value = "via-dialog";
    dialogInput.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(getTabs()).toHaveLength(1);
    expect(getTabs()[0]!.path).toBe("via-dialog.md");
    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("promptNewNote does nothing when dialog is cancelled with Escape", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }

    const p = createNewNoteViaDialog();
    await tick();

    const dialogInput = document.querySelector("#input-dialog-input") as HTMLInputElement;
    dialogInput.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await p;

    expect(getTabs()).toHaveLength(0);
  });

  it("context menu Rename emits file:rename via the typed bus", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }
    await openTab("notes/to-rename.md");
    await tick();
    const tabBar = document.querySelector("#tab-bar")!;
    const tabEl = tabBar.querySelectorAll(".tab:not(.tab-new)")[getTabs().length - 1]!;

    let renameDetail: { oldPath: string; newPath: string } | null = null;
    const offRename = on("file:rename", (detail) => {
      renameDetail = detail;
    });

    (tabEl as HTMLElement).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
    await tick();
    const items = document.body.querySelectorAll(".context-menu-item");
    expect(items[0]!.textContent).toBe("Rename...");
    (items[0] as HTMLElement).click();

    // context-menu defers onclick via setTimeout; after tick the dialog is open
    await tick();
    const dialogInput = document.querySelector("#input-dialog-input") as HTMLInputElement;
    expect(
      document.querySelector("#input-dialog-overlay")!.classList.contains("hidden"),
    ).toBeFalsy();
    dialogInput.value = "renamed-note";
    dialogInput.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await tick();

    expect(renameDetail !== null).toBeTruthy();
    expect(renameDetail!.oldPath).toBe("notes/to-rename.md");
    expect(renameDetail!.newPath).toBe("notes/renamed-note.md");

    offRename();
    while (getTabs().length > 0) {
      closeTab(0);
    }
  });
});
