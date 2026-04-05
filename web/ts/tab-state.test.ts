/// Tests for tab-state.ts — pure data logic, but needs DOM because
/// tabs.ts registers a render listener on the shared event bus.

import { on } from "./events.ts";
import { setupDOM, assertEqual, assert, mockFetch } from "./test-helper.ts";

const cleanup = setupDOM();
const mock = mockFetch();
mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
mock.on("PUT", "/api/state", {});
mock.on("GET", "/api/state", { tabs: [], active: -1 });
mock.on("DELETE", "/api/note", {});
mock.on("POST", "/api/note", { mtime: 2000 });

import {
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
  titleFromPath,
} from "./tab-state.ts";

// Track renders and tab changes
let renderCount = 0;
let changeCount = 0;
const offRender = on("tab:render", () => {
  renderCount++;
});
const offChange = on("tab:change", () => {
  changeCount++;
});

// titleFromPath (pure function)
assertEqual(titleFromPath("notes/hello.md"), "hello", "titleFromPath basic");
assertEqual(titleFromPath("hello.md"), "hello", "titleFromPath no dir");
assertEqual(titleFromPath("deep/path/note.MD"), "note", "titleFromPath case insensitive");

// Initially empty
assertEqual(getActiveTab(), null, "no active tab");
assertEqual(getTabs().length, 0, "no tabs");
assertEqual(getActiveIndex(), -1, "index -1");

// Open tab
const tab1 = await openTab("notes/hello.md");
assertEqual(tab1.path, "notes/hello.md", "tab1 path");
assertEqual(tab1.title, "hello", "tab1 title");
assertEqual(tab1.content, "# Test", "tab1 content");
assertEqual(tab1.dirty, false, "tab1 not dirty");
assertEqual(getTabs().length, 1, "one tab");
assertEqual(getActiveIndex(), 0, "active is 0");
assert(renderCount > 0, "render called");
assert(changeCount > 0, "change called");

// Reopen same tab — no duplicate
await openTab("notes/hello.md");
assertEqual(getTabs().length, 1, "no duplicate");

// Open second tab
await openTab("notes/world.md");
assertEqual(getTabs().length, 2, "two tabs");
assertEqual(getActiveIndex(), 1, "active is 1");

// nextTab / prevTab
await nextTab();
assertEqual(getActiveIndex(), 0, "next wraps");
await prevTab();
assertEqual(getActiveIndex(), 1, "prev wraps");

// markDirty / markClean
markDirty("notes/hello.md");
assertEqual(getTabs()[0]!.dirty, true, "dirty");
markClean("notes/hello.md", "# Updated", 2000);
assertEqual(getTabs()[0]!.dirty, false, "clean");
assertEqual(getTabs()[0]!.content, "# Updated", "clean content");

// updateTabContent
updateTabContent("notes/world.md", "# World", 3000);
assertEqual(getTabs()[1]!.content, "# World", "updated content");

// updateTabPath
updateTabPath("notes/world.md", "notes/earth.md");
assertEqual(getTabs()[1]!.path, "notes/earth.md", "renamed path");
assertEqual(getTabs()[1]!.title, "earth", "renamed title");

// closeTab
closeTab(0);
assertEqual(getTabs().length, 1, "one after close");

// closeActiveTab
closeActiveTab();
assertEqual(getTabs().length, 0, "none after close active");

mock.restore();
offRender();
offChange();
cleanup();
console.log("All tab-state tests passed");
