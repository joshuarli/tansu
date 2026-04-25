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
      recency_boost: 2,
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
        tags: ["rust", "docs"],
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

  it("search basic lifecycle", () => {
    // Initially closed
    expect(isSearchOpen()).toBeFalsy();

    // Open
    openSearch();
    expect(isSearchOpen()).toBeTruthy();
    const overlay = document.querySelector("#search-overlay") as HTMLElement;
    expect(overlay.classList.contains("hidden")).toBeFalsy();

    // Input is focused and cleared
    const input = document.querySelector("#search-input")! as HTMLInputElement;
    expect(input.value).toBe("");

    // Close
    closeSearch();
    expect(isSearchOpen()).toBeFalsy();
    expect(overlay.classList.contains("hidden")).toBeTruthy();

    // Toggle
    toggleSearch();
    expect(isSearchOpen()).toBeTruthy();
    toggleSearch();
    expect(isSearchOpen()).toBeFalsy();

    // Open with scope
    openSearch("notes/a.md");
    expect(isSearchOpen()).toBeTruthy();
    expect(input.placeholder).toBe("Find in note...");
    closeSearch();

    // Open without scope
    openSearch();
    expect(input.placeholder).toBe("Search notes...");

    // Keyboard: Escape closes
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(isSearchOpen()).toBeFalsy();

    // Overlay click closes
    openSearch();
    overlay.click();
    expect(isSearchOpen()).toBeFalsy();
  });

  it("search results and keyboard nav", async () => {
    const input = document.querySelector("#search-input")! as HTMLInputElement;
    const resultsEl = document.querySelector("#search-results")!;
    mock.on("GET", "/api/search", [
      {
        path: "a.md",
        title: "Alpha",
        tags: ["rust", "docs"],
        excerpt: "test",
        score: 1.5,
        field_scores: { title: 1, headings: 0.5, tags: 0, content: 0 },
      },
    ]);

    // Type in search box → results render
    openSearch2();
    input.value = "alpha";
    input.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 200));
    expect(resultsEl.children.length).toBeGreaterThan(0);

    // Results show title and path
    const firstResult = resultsEl.children[0]! as HTMLElement;
    expect(firstResult.textContent!).toContain("Alpha");
    expect(firstResult.textContent!).toContain("a.md");
    expect(firstResult.querySelectorAll(".tag-pill")).toHaveLength(2);

    // Score breakdown rendered (show_score_breakdown: true in mock)
    expect(firstResult.textContent!).toContain("title:");

    // Create option appears for non-empty query
    const createEl = [...resultsEl.children].find((el) => el.textContent?.startsWith('Create "')) as
      | HTMLElement
      | undefined;
    expect(createEl !== undefined).toBeTruthy();
    expect(createEl!.textContent!).toContain("alpha");

    // Count selected items before navigation — should be exactly one
    const selectedBefore = [...resultsEl.children].filter((el) =>
      el.classList.contains("selected"),
    ).length;
    expect(selectedBefore).toBe(1);

    // ArrowDown moves selection
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    const selectedAfterDown = [...resultsEl.children].filter((el) =>
      el.classList.contains("selected"),
    ).length;
    expect(selectedAfterDown).toBe(1);

    // ArrowUp moves selection: still exactly one selected item
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    const selectedAfterUp = [...resultsEl.children].filter((el) =>
      el.classList.contains("selected"),
    ).length;
    expect(selectedAfterUp).toBe(1);

    // Enter on selected result closes search and calls openTab
    openTabCalled = false;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(isSearchOpen2()).toBeFalsy();
    expect(openTabCalled).toBeTruthy();
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
    expect(isSearchOpen2()).toBeFalsy();
    expect(openTabCalled).toBeTruthy();

    // Empty query clears results (no search results, no Create option)
    openSearch2();
    input.value = "";
    input.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 200));
    expect(resultsEl.children).toHaveLength(0);
    closeSearch2();
  });

  it("search API error clears results", async () => {
    const input = document.querySelector("#search-input")! as HTMLInputElement;
    const resultsEl = document.querySelector("#search-results")!;

    // Override search to return 500
    mock.on("GET", "/api/search", { error: "fail" }, 500);

    openSearch();
    input.value = "broken query";
    input.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 200));

    // Should show only the "Create" option, no search results
    const searchResults = resultsEl.querySelectorAll(".search-result");
    expect(searchResults).toHaveLength(0);

    // Create option should still appear for the typed query
    const createEl = resultsEl.querySelector(".search-create") as HTMLElement | null;
    expect(createEl !== null).toBeTruthy();
    expect(createEl!.textContent!).toContain("broken query");

    closeSearch();

    // Restore working search mock
    mock.on("GET", "/api/search", [
      {
        path: "a.md",
        title: "Alpha",
        tags: [],
        excerpt: "test",
        score: 1.5,
        field_scores: { title: 1, headings: 0.5, tags: 0, content: 0 },
      },
    ]);
  });

  it("create note option calls createNote API", async () => {
    const input = document.querySelector("#search-input")! as HTMLInputElement;
    const resultsEl = document.querySelector("#search-results")!;

    // Return empty results so "Create" is the only option
    mock.on("GET", "/api/search", []);
    mock.on("POST", "/api/note", { mtime: 9999 });

    openTabCalled = false;
    openSearch2();
    input.value = "my new note";
    input.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 200));

    // The create option should be present
    const createEl = resultsEl.querySelector(".search-create") as HTMLElement | null;
    expect(createEl !== null).toBeTruthy();
    expect(createEl!.textContent!).toContain("my new note");

    // Click the create option directly
    createEl!.click();
    await new Promise((r) => setTimeout(r, 50));

    expect(openTabCalled).toBeTruthy();
    expect(openTabPath).toBe("my new note.md");
    expect(isSearchOpen2()).toBeFalsy();

    // Restore search mock
    mock.on("GET", "/api/search", [
      {
        path: "a.md",
        title: "Alpha",
        tags: [],
        excerpt: "test",
        score: 1.5,
        field_scores: { title: 1, headings: 0.5, tags: 0, content: 0 },
      },
    ]);
  });

  it("open() handles getSettings failure gracefully without crashing", async () => {
    mock.on("GET", "/api/settings", { error: "fail" }, 500);
    openSearch();
    await new Promise((r) => setTimeout(r, 100));
    expect(isSearchOpen()).toBeTruthy();
    closeSearch();
    mock.on("GET", "/api/settings", {
      weight_title: 10,
      weight_headings: 5,
      weight_tags: 2,
      weight_content: 1,
      fuzzy_distance: 1,
      recency_boost: 2,
      result_limit: 20,
      show_score_breakdown: true,
      excluded_folders: [],
    });
  });

  it("ignores stale search responses", async () => {
    const input = document.querySelector("#search-input")! as HTMLInputElement;
    const resultsEl = document.querySelector("#search-results")!;

    mock.onDelayed(
      "GET",
      /\/api\/search\?q=alpha(?:&|$)/,
      [
        {
          path: "a.md",
          title: "Alpha",
          tags: [],
          excerpt: "alpha result",
          score: 1,
          field_scores: { title: 1, headings: 0, tags: 0, content: 0 },
        },
      ],
      100,
    );
    mock.on("GET", /\/api\/search\?q=beta(?:&|$)/, [
      {
        path: "b.md",
        title: "Beta",
        tags: [],
        excerpt: "beta result",
        score: 1,
        field_scores: { title: 1, headings: 0, tags: 0, content: 0 },
      },
    ]);

    openSearch2();
    input.value = "alpha";
    input.dispatchEvent(new Event("input"));
    input.value = "beta";
    input.dispatchEvent(new Event("input"));

    await new Promise((r) => setTimeout(r, 150));

    const firstResult = resultsEl.querySelector(".search-result") as HTMLElement | null;
    expect(firstResult).not.toBeNull();
    expect(firstResult!.textContent!).toContain("Beta");
    expect(firstResult!.textContent!).not.toContain("Alpha");
  });
});
