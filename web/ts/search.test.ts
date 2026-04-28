import { render } from "solid-js/web";

import { SearchModal } from "./search.tsx";
import { setupDOM, mockFetch } from "./test-helper.ts";
import { uiStore } from "./ui-store.ts";

describe("search", () => {
  let cleanup: () => void;
  let mock: ReturnType<typeof mockFetch>;
  let openTabCalled = false;
  let openTabPath = "";

  async function openSearch(scopePath?: string) {
    uiStore.openSearch(scopePath);
    await new Promise((r) => setTimeout(r, 0));
  }

  async function closeSearch() {
    uiStore.closeSearch();
    await new Promise((r) => setTimeout(r, 0));
  }

  beforeAll(async () => {
    cleanup = setupDOM();
    const { delegateEvents } = await import("solid-js/web");
    delegateEvents(["click", "input", "change", "keydown", "contextmenu", "auxclick"]);
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

    render(
      () =>
        SearchModal({
          openTab: async (path: string) => {
            openTabCalled = true;
            openTabPath = path;
          },
          invalidateNoteCache: () => {},
        }),
      document.querySelector("#search-root") as HTMLElement,
    );
  });

  afterAll(() => {
    mock.restore();
    cleanup();
  });

  beforeEach(() => {
    uiStore.closeSearch();
    openTabCalled = false;
    openTabPath = "";
  });

  it("search basic lifecycle", async () => {
    // Initially closed
    expect(uiStore.searchOpen()).toBeFalsy();

    // Open
    await openSearch();
    expect(uiStore.searchOpen()).toBeTruthy();
    const overlay = document.querySelector("#search-overlay") as HTMLElement;
    expect(overlay.classList.contains("hidden")).toBeFalsy();

    // Input is focused and cleared
    const input = document.querySelector("#search-input")! as HTMLInputElement;
    expect(input.value).toBe("");

    // Close
    await closeSearch();
    expect(uiStore.searchOpen()).toBeFalsy();
    expect(overlay.classList.contains("hidden")).toBeTruthy();

    // Toggle
    uiStore.toggleSearch();
    await new Promise((r) => setTimeout(r, 0));
    expect(uiStore.searchOpen()).toBeTruthy();
    uiStore.toggleSearch();
    await new Promise((r) => setTimeout(r, 0));
    expect(uiStore.searchOpen()).toBeFalsy();

    // Open with scope
    await openSearch("notes/a.md");
    expect(uiStore.searchOpen()).toBeTruthy();
    expect(input.placeholder).toBe("Find in note...");
    await closeSearch();

    // Open without scope
    await openSearch();
    expect(input.placeholder).toBe("Search notes...");

    // Keyboard: Escape closes
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(uiStore.searchOpen()).toBeFalsy();

    // Overlay click closes
    await openSearch();
    overlay.click();
    expect(uiStore.searchOpen()).toBeFalsy();
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
    await openSearch();
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
    expect(uiStore.searchOpen()).toBeFalsy();
    expect(openTabCalled).toBeTruthy();
    expect(openTabPath).toBe("a.md");

    // Click on result closes search
    await openSearch();
    input.value = "alpha";
    input.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 200));
    openTabCalled = false;
    const clickResult = resultsEl.children[0]! as HTMLElement;
    clickResult.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(uiStore.searchOpen()).toBeFalsy();
    expect(openTabCalled).toBeTruthy();

    // Empty query clears results (no search results, no Create option)
    await openSearch();
    input.value = "";
    input.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 200));
    expect(resultsEl.children).toHaveLength(0);
    await closeSearch();
  });

  it("scoped search sends the path and suppresses the create-note option", async () => {
    const input = document.querySelector("#search-input")! as HTMLInputElement;
    const resultsEl = document.querySelector("#search-results")!;

    mock.clearRequests();
    mock.on("GET", /\/api\/search\?q=alpha&path=notes%2Falpha\.md/, [
      {
        path: "notes/alpha.md",
        title: "Alpha",
        tags: [],
        excerpt: "scoped alpha",
        score: 1,
        field_scores: { title: 1, headings: 0, tags: 0, content: 0 },
      },
    ]);

    await openSearch("notes/alpha.md");
    input.value = "alpha";
    input.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 200));

    expect(
      mock.requests.some((req) => req.url === "/api/search?q=alpha&path=notes%2Falpha.md"),
    ).toBeTruthy();
    expect(resultsEl.querySelector(".search-result")?.textContent).toContain("Alpha");
    expect(resultsEl.querySelector(".search-create")).toBeNull();

    await closeSearch();
  });

  it("score breakdown is hidden when the setting is disabled", async () => {
    const input = document.querySelector("#search-input")! as HTMLInputElement;
    const resultsEl = document.querySelector("#search-results")!;

    mock.on("GET", "/api/settings", {
      weight_title: 10,
      weight_headings: 5,
      weight_tags: 2,
      weight_content: 1,
      fuzzy_distance: 1,
      recency_boost: 2,
      result_limit: 20,
      show_score_breakdown: false,
      excluded_folders: [],
    });
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

    await openSearch();
    await new Promise((r) => setTimeout(r, 50));
    input.value = "alpha";
    input.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 200));

    const firstResult = resultsEl.querySelector(".search-result") as HTMLElement | null;
    expect(firstResult).not.toBeNull();
    expect(firstResult!.querySelector(".score")).toBeNull();
    expect(firstResult!.textContent!).not.toContain("title:");

    await closeSearch();
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

  it("arrow navigation wraps between first and last items", async () => {
    const input = document.querySelector("#search-input")! as HTMLInputElement;
    const resultsEl = document.querySelector("#search-results")!;

    mock.on("GET", "/api/search", [
      {
        path: "a.md",
        title: "Alpha",
        tags: [],
        excerpt: "alpha",
        score: 1,
        field_scores: { title: 1, headings: 0, tags: 0, content: 0 },
      },
      {
        path: "b.md",
        title: "Beta",
        tags: [],
        excerpt: "beta",
        score: 1,
        field_scores: { title: 1, headings: 0, tags: 0, content: 0 },
      },
    ]);

    await openSearch();
    input.value = "alpha";
    input.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 200));

    const children = [...resultsEl.children];
    expect(children).toHaveLength(3);
    expect(children[0]!.classList.contains("selected")).toBeTruthy();

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(children[2]!.classList.contains("selected")).toBeTruthy();

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(children[0]!.classList.contains("selected")).toBeTruthy();

    await closeSearch();
  });

  it("search API error clears results", async () => {
    const input = document.querySelector("#search-input")! as HTMLInputElement;
    const resultsEl = document.querySelector("#search-results")!;

    mock.on("GET", "/api/search", { error: "fail" }, 500);

    await openSearch();
    input.value = "broken query";
    input.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 200));

    const searchResults = resultsEl.querySelectorAll(".search-result");
    expect(searchResults).toHaveLength(0);

    const createEl = resultsEl.querySelector(".search-create") as HTMLElement | null;
    expect(createEl !== null).toBeTruthy();
    expect(createEl!.textContent!).toContain("broken query");

    await closeSearch();

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

    mock.on("GET", "/api/search", []);
    mock.on("POST", "/api/note", { mtime: 9999 });

    openTabCalled = false;
    await openSearch();
    input.value = "my new note";
    input.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 200));

    const createEl = resultsEl.querySelector(".search-create") as HTMLElement | null;
    expect(createEl !== null).toBeTruthy();
    expect(createEl!.textContent!).toContain("my new note");

    createEl!.click();
    await new Promise((r) => setTimeout(r, 50));

    expect(openTabCalled).toBeTruthy();
    expect(openTabPath).toBe("my new note.md");
    expect(uiStore.searchOpen()).toBeFalsy();

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
    await openSearch();
    await new Promise((r) => setTimeout(r, 100));
    expect(uiStore.searchOpen()).toBeTruthy();
    await closeSearch();
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

  it("Enter on create option creates note without clicking", async () => {
    const input = document.querySelector("#search-input")! as HTMLInputElement;
    const resultsEl = document.querySelector("#search-results")!;

    mock.on("GET", "/api/search", []);
    mock.on("POST", "/api/note", { mtime: 9999 });

    openTabCalled = false;
    await openSearch();
    input.value = "enter-create-test";
    input.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 200));

    const createEl = resultsEl.querySelector(".search-create");
    expect(createEl !== null).toBeTruthy();

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(createEl!.classList.contains("selected")).toBeTruthy();

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));

    expect(openTabCalled).toBeTruthy();
    expect(openTabPath).toBe("enter-create-test.md");
    expect(uiStore.searchOpen()).toBeFalsy();

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

  it("click on result at index > 0 opens that result, not index 0", async () => {
    const input = document.querySelector("#search-input")! as HTMLInputElement;
    const resultsEl = document.querySelector("#search-results")!;

    mock.on("GET", "/api/search", [
      {
        path: "first.md",
        title: "First",
        tags: [],
        excerpt: "first",
        score: 2,
        field_scores: { title: 2, headings: 0, tags: 0, content: 0 },
      },
      {
        path: "second.md",
        title: "Second",
        tags: [],
        excerpt: "second",
        score: 1,
        field_scores: { title: 1, headings: 0, tags: 0, content: 0 },
      },
    ]);

    openTabCalled = false;
    openTabPath = "";
    await openSearch();
    input.value = "test";
    input.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 200));

    const secondResult = resultsEl.querySelectorAll<HTMLElement>(".search-result")[1];
    expect(secondResult !== null).toBeTruthy();
    secondResult!.click();
    await new Promise((r) => setTimeout(r, 10));

    expect(openTabCalled).toBeTruthy();
    expect(openTabPath).toBe("second.md");

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

  it("stale response from an old scope is ignored", async () => {
    const input = document.querySelector("#search-input")! as HTMLInputElement;
    const resultsEl = document.querySelector("#search-results")!;

    mock.onDelayed(
      "GET",
      /path=file-a\.md/,
      [
        {
          path: "scoped-a.md",
          title: "ScopedA",
          tags: [],
          excerpt: "from a",
          score: 1,
          field_scores: { title: 1, headings: 0, tags: 0, content: 0 },
        },
      ],
      100,
    );
    mock.on("GET", /path=file-b\.md/, [
      {
        path: "scoped-b.md",
        title: "ScopedB",
        tags: [],
        excerpt: "from b",
        score: 1,
        field_scores: { title: 1, headings: 0, tags: 0, content: 0 },
      },
    ]);

    await openSearch("file-a.md");
    input.value = "scoped";
    input.dispatchEvent(new Event("input"));
    await closeSearch();
    await openSearch("file-b.md");
    input.value = "scoped";
    input.dispatchEvent(new Event("input"));

    await new Promise((r) => setTimeout(r, 200));

    const results = [...resultsEl.querySelectorAll<HTMLElement>(".search-result")];
    const titles = results.map((el) => el.textContent ?? "");
    expect(titles.some((t) => t.includes("ScopedB"))).toBeTruthy();
    expect(titles.some((t) => t.includes("ScopedA"))).toBeFalsy();
    await closeSearch();

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
        field_scores: { title: 1, headings: 0.5, tags: 0, content: 0 },
      },
    ]);

    await openSearch();
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
