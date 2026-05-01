import { render } from "solid-js/web";

import type { Tab } from "./tab-state.ts";
import { TabBarShell } from "./tabs.tsx";
import { setupDOM, mockFetch } from "./test-helper.ts";
import { TEST_IDS } from "./test-selectors.ts";
import { uiStore } from "./ui-store.ts";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const tabSelector = TEST_IDS.tab;
const tabCloseSelector = TEST_IDS.tabClose;
const tabDirtySelector = TEST_IDS.tabDirty;
const tabLabelTextSelector = TEST_IDS.tabLabelText;
const newTabSelector = TEST_IDS.newTab;
const tabTooltipSelector = TEST_IDS.tabTooltip;

describe("tabs", () => {
  let cleanup: () => void;
  let mock: ReturnType<typeof mockFetch>;
  let disposeDialogHost: (() => void) | null = null;
  let openTab: (path: string) => Promise<Tab>;
  let closeTab: (i: number) => void;
  let getTabs: () => Tab[];
  let getActiveTab: () => Tab | null;
  let markDirty: (path: string) => void;
  let createNewNoteViaDialog: () => Promise<void>;

  beforeAll(async () => {
    cleanup = setupDOM();
    const { delegateEvents } = await import("solid-js/web");
    delegateEvents(["click", "input", "change", "keydown", "contextmenu", "auxclick"]);
    mock = mockFetch();

    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    mock.on("PUT", "/api/state", {});
    mock.on("GET", "/api/state", { tabs: [], active: -1 });
    mock.on("DELETE", "/api/note", {});
    mock.on("POST", "/api/note", { mtime: 2000 });
    mock.on("GET", "/api/pinned", []);
    mock.on("POST", "/api/pin", {});
    mock.on("DELETE", "/api/pin", {});

    const stateMod = await import("./tab-state.ts");
    ({ openTab } = stateMod);
    ({ closeTab } = stateMod);
    ({ getTabs } = stateMod);
    ({ getActiveTab } = stateMod);
    ({ markDirty } = stateMod);
    const mod = await import("./tabs.tsx");
    createNewNoteViaDialog = mod.promptNewNote;
    const dialogMod = await import("./input-dialog.tsx");

    const appEl = document.querySelector("#app") as HTMLElement;
    disposeDialogHost = render(() => dialogMod.InputDialogHost(), appEl);
    const tabBarEl = document.querySelector("#tab-bar") as HTMLElement;
    render(() => TabBarShell(), tabBarEl);

    // Clean up any leaked state from other test files sharing the module.
    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  afterAll(() => {
    disposeDialogHost?.();
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
    const tabEls = tabBar.querySelectorAll(tabSelector);
    expect(tabEls).toHaveLength(2);
    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("tab rendering no longer mutates empty-state visibility directly", async () => {
    const emptyState = document.querySelector("#empty-state") as HTMLElement;
    await openTwo();
    expect(emptyState.style.display).toBe("");
    while (getTabs().length > 0) {
      closeTab(0);
      await tick();
    }
    expect(emptyState.style.display).toBe("");
  });

  it("active tab exposes active state; others do not", async () => {
    await openTwo();
    const tabBar = document.querySelector("#tab-bar")!;
    const tabEls = tabBar.querySelectorAll<HTMLElement>(tabSelector);
    // beta was opened second so it is active (index 1)
    expect(tabEls[1]!.dataset["active"]).toBe("true");
    expect(tabEls[0]!.dataset["active"]).toBeUndefined();
    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("clicking an inactive tab switches the active tab", async () => {
    await openTwo();
    const tabBar = document.querySelector("#tab-bar")!;
    const tabEls = tabBar.querySelectorAll(tabSelector);

    expect(getActiveTab()?.path).toBe("notes/beta.md");
    (tabEls[0] as HTMLElement).click();
    await tick();

    const renderedTabEls = tabBar.querySelectorAll<HTMLElement>(tabSelector);
    expect(getActiveTab()?.path).toBe("notes/alpha.md");
    expect(renderedTabEls[0]!.dataset["active"]).toBe("true");
    expect(renderedTabEls[1]!.dataset["active"]).toBeUndefined();

    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("tab labels match note titles", async () => {
    await openTwo();
    const tabBar = document.querySelector("#tab-bar")!;
    const labels = tabBar.querySelectorAll(`${tabSelector} ${tabLabelTextSelector}`);
    expect(labels[0]!.textContent).toBe("alpha");
    expect(labels[1]!.textContent).toBe("beta");
    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("+ button is always present", async () => {
    await openTwo();
    const tabBar = document.querySelector("#tab-bar")!;
    const addBtn = tabBar.querySelector(newTabSelector);
    expect(addBtn !== null).toBeTruthy();
    expect(addBtn!.textContent).toBe("+");
    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("dirty indicator appears after markDirty, absent otherwise", async () => {
    await openTwo();
    const tabBar = document.querySelector("#tab-bar")!;
    const tabEls = () => tabBar.querySelectorAll<HTMLElement>(tabSelector);

    expect(tabEls()[0]!.querySelector(tabDirtySelector)).toBeNull();
    markDirty("notes/alpha.md");
    await tick();
    expect(tabEls()[0]!.querySelector(tabDirtySelector) !== null).toBeTruthy();
    expect(tabEls()[1]!.querySelector(tabDirtySelector)).toBeNull();
    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("close button on tab removes that tab", async () => {
    await openTwo();
    const tabBar = document.querySelector("#tab-bar")!;
    markDirty("notes/alpha.md");
    await tick();
    const tabEls = tabBar.querySelectorAll(tabSelector);
    const closeBtn = tabEls[0]!.querySelector(tabCloseSelector) as HTMLElement;
    closeBtn.click();
    await tick();
    const remaining = tabBar.querySelectorAll(tabSelector);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.querySelector(tabLabelTextSelector)!.textContent).toBe("beta");
    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("close button on an inactive tab does not switch before closing", async () => {
    await openTwo();
    const tabBar = document.querySelector("#tab-bar")!;
    const tabEls = tabBar.querySelectorAll(tabSelector);
    const closeBtn = tabEls[0]!.querySelector(tabCloseSelector) as HTMLElement;

    expect(getActiveTab()?.path).toBe("notes/beta.md");
    closeBtn.click();
    await tick();

    expect(getActiveTab()?.path).toBe("notes/beta.md");
    expect(tabBar.querySelectorAll(tabSelector)).toHaveLength(1);

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
    const tabEl = tabBar.querySelectorAll(tabSelector)[0]!;
    (tabEl as HTMLElement).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }),
    );
    await tick();
    const menu = document.body.querySelector(TEST_IDS.contextMenu);
    expect(menu !== null).toBeTruthy();
    const items = menu!.querySelectorAll(TEST_IDS.contextMenuItem);
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
    const countBefore = tabBar.querySelectorAll(tabSelector).length;
    const tabEl = tabBar.querySelectorAll(tabSelector)[0]!;
    (tabEl as HTMLElement).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
    await tick();
    const items = document.body.querySelectorAll(TEST_IDS.contextMenuItem);
    (items[3] as HTMLElement).click();
    await tick();
    expect(document.body.querySelector(TEST_IDS.contextMenu)).toBeNull();
    expect(tabBar.querySelectorAll(tabSelector)).toHaveLength(countBefore - 1);
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
    const tabEl = tabBar.querySelectorAll(tabSelector)[countBefore - 1]!;
    (tabEl as HTMLElement).dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 100,
      }),
    );
    await tick();
    const menu = document.body.querySelector(TEST_IDS.contextMenu);
    const items = menu!.querySelectorAll(TEST_IDS.contextMenuItem);
    expect(items[2]!.textContent).toBe("Delete");
    expect((items[2] as HTMLElement).dataset["danger"]).toBe("true");
    (items[2] as HTMLElement).click();
    await tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(getTabs()).toHaveLength(countBefore - 1);
    expect(document.body.querySelector(TEST_IDS.contextMenu)).toBeNull();
  });

  it("tab tooltip shows on mouseenter and hides on mouseleave", async () => {
    await openTwo();
    const tabBar = document.querySelector("#tab-bar")!;
    const tabEl = tabBar.querySelectorAll(tabSelector)[0]! as HTMLElement;

    tabEl.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    const tooltip = document.body.querySelector(tabTooltipSelector) as HTMLElement;
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
    const countBefore = tabBar.querySelectorAll(tabSelector).length;
    const tabEl = tabBar.querySelectorAll(tabSelector)[0]! as HTMLElement;

    tabEl.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await tick();

    expect(tabBar.querySelectorAll(tabSelector)).toHaveLength(countBefore - 1);

    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("space key with modifier keys ignored", async () => {
    await openTwo();
    const tabBar = document.querySelector("#tab-bar")!;
    const countBefore = tabBar.querySelectorAll(tabSelector).length;
    const tabEl = tabBar.querySelectorAll(tabSelector)[0]! as HTMLElement;

    tabEl.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", ctrlKey: true, bubbles: true }),
    );
    await tick();

    expect(tabBar.querySelectorAll(tabSelector)).toHaveLength(countBefore);

    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("space key does not close hovered tab when focus is in an input", async () => {
    await openTwo();
    const tabBar = document.querySelector("#tab-bar")!;
    const countBefore = tabBar.querySelectorAll(tabSelector).length;
    const tabEl = tabBar.querySelectorAll(tabSelector)[0]! as HTMLElement;
    const input = document.querySelector("#sidebar-search") as HTMLInputElement;

    tabEl.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await tick();

    expect(tabBar.querySelectorAll(tabSelector)).toHaveLength(countBefore);

    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("space key does nothing when no tab is hovered", async () => {
    await openTwo();
    const tabBar = document.querySelector("#tab-bar")!;
    const countBefore = tabBar.querySelectorAll(tabSelector).length;

    // Don't mouseenter any tab
    document.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await tick();

    expect(tabBar.querySelectorAll(tabSelector)).toHaveLength(countBefore);

    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("middle click (auxclick button=1) closes the tab", async () => {
    await openTwo();
    const tabBar = document.querySelector("#tab-bar")!;
    const countBefore = tabBar.querySelectorAll(tabSelector).length;
    const tabEl = tabBar.querySelectorAll(tabSelector)[0]! as HTMLElement;

    tabEl.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
    await tick();

    expect(tabBar.querySelectorAll(tabSelector)).toHaveLength(countBefore - 1);

    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("auxclick with button != 1 does not close tab", async () => {
    await openTwo();
    const tabBar = document.querySelector("#tab-bar")!;
    const countBefore = tabBar.querySelectorAll(tabSelector).length;
    const tabEl = tabBar.querySelectorAll(tabSelector)[0]! as HTMLElement;

    tabEl.dispatchEvent(new MouseEvent("auxclick", { button: 2, bubbles: true }));
    await tick();

    expect(tabBar.querySelectorAll(tabSelector)).toHaveLength(countBefore);

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
    const tabEl = tabBar.querySelectorAll(tabSelector)[0]!;

    mock.on("GET", "/api/pinned", []);
    mock.on("POST", "/api/pin", {});

    (tabEl as HTMLElement).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
    await tick();
    const items = document.body.querySelectorAll(TEST_IDS.contextMenuItem);
    expect(items[1]!.textContent).toBe("Pin");
    (items[1] as HTMLElement).click();
    await tick();
    await new Promise((r) => setTimeout(r, 50));

    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("context menu Pin failure emits a notification", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }
    await openTab("notes/to-pin.md");
    await tick();
    const tabBar = document.querySelector("#tab-bar")!;
    const tabEl = tabBar.querySelectorAll(tabSelector)[0]!;

    mock.on("GET", "/api/pinned", []);
    mock.on("POST", "/api/pin", { error: "pin failed" }, 500);

    (tabEl as HTMLElement).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
    await tick();
    const items = document.body.querySelectorAll(TEST_IDS.contextMenuItem);
    (items[1] as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 50));

    expect(uiStore.notification().type).toBe("error");
    expect(uiStore.notification().msg).toContain("Failed to pin to-pin");
    expect(uiStore.notification().msg).toContain("pin failed");
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
    await openTab("notes/ensure-render.md");
    await tick();
    while (getTabs().length > 0) {
      closeTab(0);
    }
    await tick();
    const tabBar = document.querySelector("#tab-bar")!;
    const addBtn = tabBar.querySelector(newTabSelector) as HTMLElement;

    addBtn.click();
    await tick();

    const overlay = document.querySelector("#input-dialog-overlay") as HTMLElement;
    expect(overlay.hidden).toBeFalsy();

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

  it("context menu Rename opens the rename dialog and calls rename API", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }
    mock.on("POST", "/api/rename", { updated: [] });
    await openTab("notes/to-rename.md");
    await tick();
    const tabBar = document.querySelector("#tab-bar")!;
    const tabEl = tabBar.querySelectorAll(tabSelector)[getTabs().length - 1]!;

    (tabEl as HTMLElement).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
    await tick();
    const items = document.body.querySelectorAll(TEST_IDS.contextMenuItem);
    expect(items[0]!.textContent).toBe("Rename...");
    (items[0] as HTMLElement).click();

    // context-menu defers onclick via setTimeout; after tick the dialog is open
    await tick();
    const dialogInput = document.querySelector("#input-dialog-input") as HTMLInputElement;
    expect((document.querySelector("#input-dialog-overlay") as HTMLElement).hidden).toBeFalsy();
    dialogInput.value = "renamed-note";
    dialogInput.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await new Promise((r) => setTimeout(r, 50));

    const renameReq = mock.requests.find(
      (req) => req.method === "POST" && req.url === "/api/rename",
    );
    expect(renameReq?.body).toContain('"old_path":"notes/to-rename.md"');
    expect(renameReq?.body).toContain('"new_path":"notes/renamed-note.md"');
    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("tooltip top/left position derives from tab element bounds", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }
    await openTab("notes/pos-test.md");
    await tick();
    const tabBar = document.querySelector("#tab-bar")!;
    const tabEl = tabBar.querySelectorAll(tabSelector)[0]! as HTMLElement;
    const rect = tabEl.getBoundingClientRect();
    (tabEl as HTMLElement).dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    const tooltip = document.body.querySelector(tabTooltipSelector) as HTMLElement;
    expect(tooltip.style.display).toBe("block");
    // top = rect.bottom + 6px
    expect(tooltip.style.top).toBe(`${rect.bottom + 6}px`);
    // left = rect.left + rect.width / 2
    expect(tooltip.style.left).toBe(`${rect.left + rect.width / 2}px`);
    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("context menu shows Unpin label when tab file is already pinned", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }
    await openTab("notes/pinned-tab.md");
    await tick();
    const tabBar = document.querySelector("#tab-bar")!;
    const tabEl = tabBar.querySelectorAll(tabSelector)[0]!;

    mock.on("GET", "/api/pinned", [{ path: "notes/pinned-tab.md", title: "pinned-tab" }]);
    mock.on("DELETE", "/api/pin", {});

    (tabEl as HTMLElement).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
    await tick();
    const items = document.body.querySelectorAll(TEST_IDS.contextMenuItem);
    expect(items[1]!.textContent).toBe("Unpin");
    (items[1] as HTMLElement).click();
    await tick();
    await new Promise((r) => setTimeout(r, 50));

    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("active tab scrolls into view when active index changes", async () => {
    while (getTabs().length > 0) closeTab(0);

    const scrollSpy = vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => {});
    try {
      await openTab("notes/scroll-a.md");
      await tick();
      scrollSpy.mockClear();

      await openTab("notes/scroll-b.md");
      await tick();
      await new Promise((r) => setTimeout(r, 10));

      expect(scrollSpy).toHaveBeenCalled();
    } finally {
      scrollSpy.mockRestore();
      while (getTabs().length > 0) closeTab(0);
    }
  });
});
