import { setupDOM, assertEqual, assert, assertContains, mockFetch } from "./test-helper.ts";
const cleanup = setupDOM();
const mock = mockFetch();

// Mock APIs needed at import time
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
mock.on("GET", "/api/note", { content: "", mtime: 1000 });
mock.on("PUT", "/api/state", {});
mock.on("GET", "/api/state", { tabs: [], active: -1 });
mock.on("GET", "/api/search", [
  {
    path: "a.md",
    title: "Alpha",
    excerpt: "test",
    score: 1.5,
    field_scores: { title: 1, headings: 0.5, tags: 0, content: 0 },
  },
]);

const { createSearch } = await import("./search.ts");
const {
  toggle: toggleSearch,
  open: openSearch,
  close: closeSearch,
  isOpen: isSearchOpen,
} = createSearch({
  openTab: async () => {},
  invalidateNoteCache: () => {},
});

// Initially closed
assertEqual(isSearchOpen(), false, "initially closed");

// Open
openSearch();
assertEqual(isSearchOpen(), true, "opened");
const overlay = document.getElementById("search-overlay")!;
assert(!overlay.classList.contains("hidden"), "overlay visible");

// Input is focused and cleared
const input = document.getElementById("search-input")! as HTMLInputElement;
assertEqual(input.value, "", "input cleared");

// Close
closeSearch();
assertEqual(isSearchOpen(), false, "closed");
assert(overlay.classList.contains("hidden"), "overlay hidden");

// Toggle
toggleSearch();
assertEqual(isSearchOpen(), true, "toggle opens");
toggleSearch();
assertEqual(isSearchOpen(), false, "toggle closes");

// Open with scope
openSearch("notes/a.md");
assertEqual(isSearchOpen(), true, "scoped open");
assertEqual(input.placeholder, "Find in note...", "scoped placeholder");
closeSearch();

// Open without scope
openSearch();
assertEqual(input.placeholder, "Search notes...", "unscoped placeholder");

// Keyboard: Escape closes
input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
assertEqual(isSearchOpen(), false, "escape closes");

// Overlay click closes
openSearch();
overlay.click();
// The click handler checks e.target === overlay — direct click should close
assertEqual(isSearchOpen(), false, "overlay click closes");

// --- New tests: results rendering, keyboard nav, Enter, Create, click ---

// Use a fresh search instance with a tracked openTab
let openTabCalled = false;
let openTabPath = "";
const { open: openSearch2, close: closeSearch2, isOpen: isSearchOpen2 } = createSearch({
  openTab: async (path: string) => { openTabCalled = true; openTabPath = path; },
  invalidateNoteCache: () => {},
});

// Type in search box → results render after debounce
openSearch2();
input.value = "alpha";
input.dispatchEvent(new Event("input"));
await new Promise((r) => setTimeout(r, 200));
const resultsEl = document.getElementById("search-results")!;
assert(resultsEl.children.length > 0, "results rendered after debounce");

// Results show title and path
const firstResult = resultsEl.children[0]! as HTMLElement;
assertContains(firstResult.textContent!, "Alpha", "result shows title");
assertContains(firstResult.textContent!, "a.md", "result shows path");

// Score breakdown rendered (show_score_breakdown: true in mock)
assertContains(firstResult.textContent!, "title:", "score breakdown rendered");

// Create option appears for non-empty query
const createEl = Array.from(resultsEl.children).find((el) =>
  el.textContent?.startsWith('Create "')
) as HTMLElement | undefined;
assert(createEl !== undefined, "Create option appears");
assertContains(createEl!.textContent!, "alpha", "Create option contains query");

// Count selected items before navigation — should be exactly one
const selectedBefore = Array.from(resultsEl.children).filter((el) =>
  el.classList.contains("selected")
).length;
assertEqual(selectedBefore, 1, "exactly one item selected initially");

// ArrowDown moves selection
input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
// After one ArrowDown from the createSearch2 instance, check exactly one selected item
const selectedAfterDown = Array.from(resultsEl.children).filter((el) =>
  el.classList.contains("selected")
).length;
assertEqual(selectedAfterDown, 1, "exactly one item selected after ArrowDown");

// ArrowUp moves selection: still exactly one selected item
input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
const selectedAfterUp = Array.from(resultsEl.children).filter((el) =>
  el.classList.contains("selected")
).length;
assertEqual(selectedAfterUp, 1, "exactly one item selected after ArrowUp");

// Enter on selected result closes search and calls openTab
openTabCalled = false;
input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await new Promise((r) => setTimeout(r, 10));
assertEqual(isSearchOpen2(), false, "Enter closes search");
assert(openTabCalled, "Enter calls openTab");
assertEqual(openTabPath, "a.md", "openTab called with result path");

// Click on result closes search
openSearch2();
input.value = "alpha";
input.dispatchEvent(new Event("input"));
await new Promise((r) => setTimeout(r, 200));
openTabCalled = false;
const clickResult = resultsEl.children[0]! as HTMLElement;
clickResult.click();
await new Promise((r) => setTimeout(r, 10));
assertEqual(isSearchOpen2(), false, "click on result closes search");
assert(openTabCalled, "click on result calls openTab");

// Empty query clears results (no search results, no Create option)
openSearch2();
input.value = "";
input.dispatchEvent(new Event("input"));
await new Promise((r) => setTimeout(r, 200));
assertEqual(resultsEl.children.length, 0, "empty query clears results");
closeSearch2();

mock.restore();
cleanup();
console.log("All search tests passed");
