import { describe, test, expect, beforeAll, afterAll } from "bun:test";

import { setupDOM, mockFetch } from "./test-helper.ts";

describe("search", () => {
  let cleanup: () => void;
  let mock: ReturnType<typeof mockFetch>;
  let toggleSearch: () => void;
  let openSearch: (scope?: string) => void;
  let closeSearch: () => void;
  let isSearchOpen: () => boolean;
  let openSearch2: (scope?: string) => void;
  let closeSearch2: () => void;
  let isSearchOpen2: () => boolean;
  let openTabCalled = false;
  let openTabPath = "";

  beforeAll(async () => {
    cleanup = setupDOM();
    mock = mockFetch();

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
    const s1 = createSearch({
      openTab: async () => {},
      invalidateNoteCache: () => {},
    });
    toggleSearch = s1.toggle;
    openSearch = s1.open;
    closeSearch = s1.close;
    isSearchOpen = s1.isOpen;

    const s2 = createSearch({
      openTab: async (path: string) => {
        openTabCalled = true;
        openTabPath = path;
      },
      invalidateNoteCache: () => {},
    });
    openSearch2 = s2.open;
    closeSearch2 = s2.close;
    isSearchOpen2 = s2.isOpen;
  });

  afterAll(() => {
    mock.restore();
    cleanup();
  });

  test("search basic lifecycle", () => {
    // Initially closed
    expect(isSearchOpen()).toBe(false);

    // Open
    openSearch();
    expect(isSearchOpen()).toBe(true);
    const overlay = document.getElementById("search-overlay")!;
    expect(overlay.classList.contains("hidden")).toBe(false);

    // Input is focused and cleared
    const input = document.getElementById("search-input")! as HTMLInputElement;
    expect(input.value).toBe("");

    // Close
    closeSearch();
    expect(isSearchOpen()).toBe(false);
    expect(overlay.classList.contains("hidden")).toBe(true);

    // Toggle
    toggleSearch();
    expect(isSearchOpen()).toBe(true);
    toggleSearch();
    expect(isSearchOpen()).toBe(false);

    // Open with scope
    openSearch("notes/a.md");
    expect(isSearchOpen()).toBe(true);
    expect(input.placeholder).toBe("Find in note...");
    closeSearch();

    // Open without scope
    openSearch();
    expect(input.placeholder).toBe("Search notes...");

    // Keyboard: Escape closes
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(isSearchOpen()).toBe(false);

    // Overlay click closes
    openSearch();
    overlay.click();
    expect(isSearchOpen()).toBe(false);
  });

  test("search results and keyboard nav", async () => {
    const input = document.getElementById("search-input")! as HTMLInputElement;
    const resultsEl = document.getElementById("search-results")!;

    // Type in search box → results render after debounce
    openSearch2();
    input.value = "alpha";
    input.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 200));
    expect(resultsEl.children.length > 0).toBe(true);

    // Results show title and path
    const firstResult = resultsEl.children[0]! as HTMLElement;
    expect(firstResult.textContent!).toContain("Alpha");
    expect(firstResult.textContent!).toContain("a.md");

    // Score breakdown rendered (show_score_breakdown: true in mock)
    expect(firstResult.textContent!).toContain("title:");

    // Create option appears for non-empty query
    const createEl = Array.from(resultsEl.children).find((el) =>
      el.textContent?.startsWith('Create "'),
    ) as HTMLElement | undefined;
    expect(createEl !== undefined).toBe(true);
    expect(createEl!.textContent!).toContain("alpha");

    // Count selected items before navigation — should be exactly one
    const selectedBefore = Array.from(resultsEl.children).filter((el) =>
      el.classList.contains("selected"),
    ).length;
    expect(selectedBefore).toBe(1);

    // ArrowDown moves selection
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    const selectedAfterDown = Array.from(resultsEl.children).filter((el) =>
      el.classList.contains("selected"),
    ).length;
    expect(selectedAfterDown).toBe(1);

    // ArrowUp moves selection: still exactly one selected item
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    const selectedAfterUp = Array.from(resultsEl.children).filter((el) =>
      el.classList.contains("selected"),
    ).length;
    expect(selectedAfterUp).toBe(1);

    // Enter on selected result closes search and calls openTab
    openTabCalled = false;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(isSearchOpen2()).toBe(false);
    expect(openTabCalled).toBe(true);
    expect(openTabPath).toBe("a.md");

    // Click on result closes search
    openSearch2();
    input.value = "alpha";
    input.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 200));
    openTabCalled = false;
    const clickResult = resultsEl.children[0]! as HTMLElement;
    clickResult.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(isSearchOpen2()).toBe(false);
    expect(openTabCalled).toBe(true);

    // Empty query clears results (no search results, no Create option)
    openSearch2();
    input.value = "";
    input.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 200));
    expect(resultsEl.children.length).toBe(0);
    closeSearch2();
  });
});
