import { setupDOM, assertEqual, assert, mockFetch } from "./test-helper.ts";
const cleanup = setupDOM();
const mock = mockFetch();

// Mock API responses needed by tabs
mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
mock.on("PUT", "/api/state", {});
mock.on("GET", "/api/state", { tabs: [], active: -1 });
mock.on("DELETE", "/api/note", {});
mock.on("POST", "/api/note", { mtime: 2000 });

const {
  openTab,
  closeTab,
  getActiveTab,
  getTabs,
  getActiveIndex,
  nextTab,
  prevTab,
  markDirty,
  markClean,
  updateTabContent,
  updateTabPath,
  closeActiveTab,
} = await import("./tabs.ts");
const { on } = await import("./events.ts");

// Clean up any leaked state from other test files sharing the module
while (getTabs().length > 0) closeTab(0);

assertEqual(getActiveTab(), null, "no active tab initially");
assertEqual(getTabs().length, 0, "no tabs initially");
assertEqual(getActiveIndex(), -1, "active index -1");

// Track tab changes
let changeCount = 0;
const offChange = on("tab:change", () => {
  changeCount++;
});

// Open a tab
const tab1 = await openTab("notes/hello.md");
assertEqual(tab1.path, "notes/hello.md", "tab1 path");
assertEqual(tab1.title, "hello", "tab1 title");
assertEqual(tab1.content, "# Test", "tab1 content from api");
assertEqual(tab1.dirty, false, "tab1 not dirty");
assertEqual(getTabs().length, 1, "one tab");
assertEqual(getActiveIndex(), 0, "active is 0");
assert(changeCount > 0, "tab change callback fired");

// Open same tab again — should not duplicate
const tab1Again = await openTab("notes/hello.md");
assertEqual(getTabs().length, 1, "no duplicate tab");
assertEqual(tab1Again.path, tab1.path, "same tab returned");

// Open second tab
await openTab("notes/world.md");
assertEqual(getTabs().length, 2, "two tabs");
assertEqual(getActiveIndex(), 1, "active is 1");
assertEqual(getActiveTab()!.path, "notes/world.md", "active is tab2");

// nextTab / prevTab
await nextTab();
assertEqual(getActiveIndex(), 0, "next wraps to 0");
await prevTab();
assertEqual(getActiveIndex(), 1, "prev wraps to 1");

// markDirty / markClean
markDirty("notes/hello.md");
assertEqual(getTabs()[0]!.dirty, true, "tab1 dirty");
markClean("notes/hello.md", "# Updated", 2000);
assertEqual(getTabs()[0]!.dirty, false, "tab1 clean");
assertEqual(getTabs()[0]!.content, "# Updated", "tab1 content updated");
assertEqual(getTabs()[0]!.mtime, 2000, "tab1 mtime updated");

// updateTabContent
updateTabContent("notes/world.md", "# World", 3000);
assertEqual(getTabs()[1]!.content, "# World", "tab2 content updated");

// updateTabPath
updateTabPath("notes/world.md", "notes/earth.md");
assertEqual(getTabs()[1]!.path, "notes/earth.md", "tab2 path renamed");
assertEqual(getTabs()[1]!.title, "earth", "tab2 title after rename");

// closeTab
closeTab(0);
assertEqual(getTabs().length, 1, "one tab after close");
assertEqual(getActiveTab()!.path, "notes/earth.md", "remaining tab");

// closeActiveTab
closeActiveTab();
assertEqual(getTabs().length, 0, "no tabs after close active");
assertEqual(getActiveTab(), null, "no active after close all");

// DOM rendering tests — the render() function in tabs.ts fires on "tab:render",
// which notifyChange() emits after every state mutation. We test the resulting DOM.

const tabBar = document.getElementById("tab-bar")!;
const emptyState = document.getElementById("empty-state")!;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// Open two tabs and check DOM.
await openTab("notes/alpha.md");
await openTab("notes/beta.md");
await tick();

const tabEls = tabBar.querySelectorAll(".tab:not(.tab-new)");
assertEqual(tabEls.length, 2, "two tab elements rendered");
assertEqual(emptyState.style.display, "none", "empty-state hidden when tabs exist");

// Active tab (index 1, beta) has .active class; alpha does not.
assert(tabEls[1]!.classList.contains("active"), "second tab has .active class");
assert(!tabEls[0]!.classList.contains("active"), "first tab lacks .active class");

// Tab labels match titles.
const labels = tabBar.querySelectorAll(".tab:not(.tab-new) span:not(.close):not(.dirty)");
assertEqual(labels[0]!.textContent, "alpha", "first tab label is alpha");
assertEqual(labels[1]!.textContent, "beta", "second tab label is beta");

// "+" button is still present alongside real tabs.
const addBtn = tabBar.querySelector(".tab-new");
assert(addBtn !== null, '"+" button present with tabs');
assertEqual(addBtn!.textContent, "+", '"+" button text is "+"');

// Dirty indicator: no dot before markDirty.
assert(tabEls[0]!.querySelector(".dirty") === null, "no dirty dot before markDirty");
markDirty("notes/alpha.md");
await tick();

const tabElsAfterDirty = tabBar.querySelectorAll(".tab:not(.tab-new)");
assert(tabElsAfterDirty[0]!.querySelector(".dirty") !== null, "dirty dot appears after markDirty");
assert(tabElsAfterDirty[1]!.querySelector(".dirty") === null, "clean tab has no dirty dot");

// Close button triggers closeTab: click the close button on the first tab.
const closeBtn = tabElsAfterDirty[0]!.querySelector(".close") as HTMLElement;
assert(closeBtn !== null, "close button present on tab");
closeBtn.click();
await tick();

const tabElsAfterClose = tabBar.querySelectorAll(".tab:not(.tab-new)");
assertEqual(tabElsAfterClose.length, 1, "one tab remains after close-button click");
assertEqual(
  tabElsAfterClose[0]!.querySelector("span:not(.close):not(.dirty)")!.textContent,
  "beta",
  "remaining tab is beta",
);

// Context menu: right-clicking a tab should create .context-menu in the body.
// Open a second tab first so we have something to right-click on.
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
assert(menu !== null, "context menu appears on right-click");

// Context menu items: Rename, Delete, Close.
const items = menu!.querySelectorAll(".context-menu-item");
assertEqual(items.length, 3, "context menu has 3 items");
assertEqual(items[0]!.textContent, "Rename...", "first item is Rename");
assertEqual(items[1]!.textContent, "Delete", "second item is Delete");
assertEqual(items[2]!.textContent, "Close", "third item is Close");

// Clicking "Close" in the context menu removes the tab and hides the menu.
const tabCountBeforeCtxClose = tabBar.querySelectorAll(".tab:not(.tab-new)").length;
(items[2] as HTMLElement).click();
await tick();

const menuAfter = document.body.querySelector(".context-menu");
assert(menuAfter === null, "context menu hidden after Close click");
const tabCountAfterCtxClose = tabBar.querySelectorAll(".tab:not(.tab-new)").length;
assertEqual(
  tabCountAfterCtxClose,
  tabCountBeforeCtxClose - 1,
  "one fewer tab after context-menu Close",
);

// Close all remaining tabs so state is clean for teardown.
while (getTabs().length > 0) {
  closeTab(0);
  await tick();
}

assertEqual(emptyState.style.display, "flex", "empty-state visible again after all tabs closed");

mock.restore();
offChange();
cleanup();
console.log("All tabs tests passed");
