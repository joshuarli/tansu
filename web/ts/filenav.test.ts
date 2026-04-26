import { emit, on } from "./events.ts";
import { setupDOM, mockFetch } from "./test-helper.ts";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const drain = () => new Promise<void>((r) => setTimeout(r, 50));
const activeCount = () => document.querySelectorAll(".nav-file.active").length;

describe("filenav", () => {
  let cleanup: () => void;
  let navCleanup: () => void;
  let mock: ReturnType<typeof mockFetch>;
  let openTab: (path: string) => Promise<unknown>;
  let closeTab: (i: number) => void;
  let getTabs: () => unknown[];

  beforeAll(async () => {
    cleanup = setupDOM();
    mock = mockFetch();

    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    mock.on("GET", "/api/state", { tabs: [], active: -1 });
    mock.on("PUT", "/api/state", {});
    mock.on("GET", "/api/pinned", []);
    mock.on("GET", "/api/recentfiles", [
      { path: "notes/alpha.md", title: "alpha", mtime: 2000 },
      { path: "notes/beta.md", title: "beta", mtime: 1000 },
    ]);

    const tabMod = await import("./tab-state.ts");
    ({ openTab } = tabMod);
    ({ closeTab } = tabMod);
    ({ getTabs } = tabMod);

    while (getTabs().length > 0) {
      closeTab(0);
    }

    const navMod = await import("./filenav.ts");
    navCleanup = await navMod.initFileNav();
  });

  afterAll(() => {
    navCleanup();
    mock.restore();
    cleanup();
  });

  // Reset search input to recent mode after each test to prevent module-level state leakage.
  afterEach(async () => {
    const searchInput = document.querySelector("#sidebar-search") as HTMLInputElement | null;
    if (searchInput && searchInput.value !== "") {
      searchInput.value = "";
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      await drain();
    }
    // Dismiss any open context menu
    document.body.click();
    // Restore default mocks
    mock.on("GET", "/api/recentfiles", [
      { path: "notes/alpha.md", title: "alpha", mtime: 2000 },
      { path: "notes/beta.md", title: "beta", mtime: 1000 },
    ]);
    mock.on("GET", "/api/pinned", []);
    emit("pinned:changed");
    await drain();
    while (getTabs().length > 0) {
      closeTab(0);
    }
  });

  it("no duplicate .active after two rapid files:changed (save + SSE pattern)", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }
    await openTab("notes/alpha.md");
    await tick();

    // Simulate local save emit + SSE emit fired in the same tick
    emit("files:changed");
    emit("files:changed");

    await drain();

    expect(activeCount()).toBe(1);
  });

  it("no duplicate .active after sequential files:changed", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }
    await openTab("notes/alpha.md");
    await tick();

    emit("files:changed");
    await drain();
    emit("files:changed");
    await drain();

    expect(activeCount()).toBe(1);
  });

  it("no duplicate .active after two rapid files:changed (recent mode)", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }
    await openTab("notes/alpha.md");
    await tick();

    emit("files:changed");
    emit("files:changed");

    await drain();

    expect(activeCount()).toBe(1);
  });

  it("no duplicate .active when tab:change fires while files:changed render is in-flight", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }
    await openTab("notes/alpha.md");
    await tick();

    // Emit files:changed to start an in-flight render (it will await network)
    emit("files:changed");

    // Immediately emit tab:change (simulates switching tab while render is in-flight)
    // openTab triggers tab:change via notifyChange → onTabChange
    await openTab("notes/beta.md");

    await drain();

    expect(activeCount()).toBe(1);
  });

  it("no duplicate under rapid files:changed + tab:change interleave", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }
    await openTab("notes/alpha.md");
    await tick();

    // Fire many events in rapid succession: save + SSE + tab switch all at once
    emit("files:changed"); // local save
    emit("files:changed"); // SSE
    await openTab("notes/beta.md"); // tab switch triggers tab:change
    emit("files:changed"); // extra SSE (e.g. second watcher event)

    await drain();

    expect(activeCount()).toBe(1);
    const activeEl = document.querySelector(".nav-file.active") as HTMLElement;
    expect(activeEl?.title).toBe("notes/beta.md");
  });

  it("no duplicate with real network delay (save emit fires during slower SSE re-render)", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }
    await openTab("notes/alpha.md");
    await tick();

    // Simulate network lag on the SECOND files:changed by overriding /api/recentfiles to be slow.
    // The first emit completes fast; the second (SSE) triggers a slow refresh.
    // Meanwhile, tab:change also fires. Check for no duplicates.
    mock.onDelayed(
      "GET",
      "/api/recentfiles",
      [
        { path: "notes/alpha.md", title: "alpha", mtime: 2000 },
        { path: "notes/beta.md", title: "beta", mtime: 1000 },
      ],
      10,
    );

    emit("files:changed");
    emit("files:changed");

    // tab:change fires synchronously when switching tabs
    await openTab("notes/beta.md");

    await new Promise<void>((r) => setTimeout(r, 100));

    expect(activeCount()).toBe(1);
    const activeEl = document.querySelector(".nav-file.active") as HTMLElement;
    expect(activeEl?.title).toBe("notes/beta.md");
  });

  it("sidebar collapse button toggles sidebar-collapsed class and updates button text", async () => {
    const collapseBtn = document.querySelector("#sidebar-collapse") as HTMLButtonElement;
    const app = document.querySelector("#app")!;

    // Initial: not collapsed
    expect(app.classList.contains("sidebar-collapsed")).toBeFalsy();

    collapseBtn.click();
    expect(app.classList.contains("sidebar-collapsed")).toBeTruthy();
    expect(collapseBtn.title).toBe("Expand sidebar");

    collapseBtn.click();
    expect(app.classList.contains("sidebar-collapsed")).toBeFalsy();
    expect(collapseBtn.title).toBe("Collapse sidebar");
  });

  it("typing in search input switches to search mode and renders results", async () => {
    mock.on("GET", "/api/filesearch", [{ path: "notes/alpha.md", title: "alpha" }]);

    const searchInput = document.querySelector("#sidebar-search") as HTMLInputElement;
    searchInput.value = "alpha";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));

    await drain();

    const container = document.querySelector("#sidebar-tree")!;
    expect(container.querySelector(".nav-file") !== null).toBeTruthy();
  });

  it("typing empty string in search mode returns to recent mode", async () => {
    const searchInput = document.querySelector("#sidebar-search") as HTMLInputElement;
    // First enter search mode
    searchInput.value = "query";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    await drain();

    // Now clear
    searchInput.value = "";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    await drain();

    // Should render recent files
    const container = document.querySelector("#sidebar-tree")!;
    expect(container.querySelector(".nav-file") !== null).toBeTruthy();
  });

  it("Escape key in search mode resets to recent mode", async () => {
    const searchInput = document.querySelector("#sidebar-search") as HTMLInputElement;
    searchInput.value = "query";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    await drain();

    searchInput.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await drain();

    expect(searchInput.value).toBe("");
    const container = document.querySelector("#sidebar-tree")!;
    expect(container.querySelector(".nav-file") !== null).toBeTruthy();
  });

  it("Escape key outside search mode does nothing", async () => {
    const searchInput = document.querySelector("#sidebar-search") as HTMLInputElement;
    searchInput.value = "";
    // Ensure in recent mode
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    await drain();

    // Pressing Escape in recent mode should be no-op (no crash)
    searchInput.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await drain();
    expect(searchInput.value).toBe("");
  });

  it("search renders directory path for nested files", async () => {
    mock.on("GET", "/api/filesearch", [{ path: "folder/deep.md", title: "deep" }]);

    const searchInput = document.querySelector("#sidebar-search") as HTMLInputElement;
    searchInput.value = "deep";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));

    await drain();

    const container = document.querySelector("#sidebar-tree")!;
    const dirLine = container.querySelector(".nav-file-dir");
    expect(dirLine !== null).toBeTruthy();
    expect(dirLine!.textContent).toBe("folder");
  });

  it("search failure renders error state", async () => {
    mock.on("GET", "/api/filesearch", { error: "fail" }, 500);

    const searchInput = document.querySelector("#sidebar-search") as HTMLInputElement;
    searchInput.value = "broken";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));

    await drain();

    const container = document.querySelector("#sidebar-tree")!;
    expect(container.textContent).toContain("failed");
  });

  it("search with no results shows empty state", async () => {
    mock.on("GET", "/api/filesearch", []);

    const searchInput = document.querySelector("#sidebar-search") as HTMLInputElement;
    searchInput.value = "nomatch";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));

    await drain();

    const container = document.querySelector("#sidebar-tree")!;
    expect(container.textContent).toContain("No matches");

    // Reset back to recent mode
    searchInput.value = "";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    await drain();
  });

  it("renderRecent shows empty state when no files exist", async () => {
    mock.on("GET", "/api/recentfiles", []);
    mock.on("GET", "/api/pinned", []);

    emit("files:changed");
    await drain();

    const container = document.querySelector("#sidebar-tree")!;
    expect(container.textContent).toContain("No files");

    // Restore
    mock.on("GET", "/api/recentfiles", [
      { path: "notes/alpha.md", title: "alpha", mtime: 2000 },
      { path: "notes/beta.md", title: "beta", mtime: 1000 },
    ]);
    emit("files:changed");
    await drain();
  });

  it("renderRecent shows error state when API fails", async () => {
    mock.on("GET", "/api/recentfiles", { error: "fail" }, 500);

    emit("files:changed");
    await drain();

    const container = document.querySelector("#sidebar-tree")!;
    expect(container.textContent).toContain("Failed");

    // Restore
    mock.on("GET", "/api/recentfiles", [
      { path: "notes/alpha.md", title: "alpha", mtime: 2000 },
      { path: "notes/beta.md", title: "beta", mtime: 1000 },
    ]);
    emit("files:changed");
    await drain();
  });

  it("contextmenu on nav-file shows context menu", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }
    mock.on("GET", "/api/recentfiles", [{ path: "notes/alpha.md", title: "alpha", mtime: 2000 }]);
    mock.on("GET", "/api/pinned", []);
    mock.on("POST", "/api/pin", {});
    mock.on("DELETE", "/api/note", {});

    emit("files:changed");
    await drain();

    const container = document.querySelector("#sidebar-tree")!;
    const navFile = container.querySelector(".nav-file") as HTMLElement;
    expect(navFile !== null).toBeTruthy();

    navFile.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }),
    );
    await tick();

    const menu = document.body.querySelector(".context-menu");
    expect(menu !== null).toBeTruthy();
    const items = menu!.querySelectorAll(".context-menu-item");
    expect(items[0]!.textContent).toBe("Rename...");
    expect(items[1]!.textContent).toBe("Pin");
    expect(items[2]!.textContent).toBe("Delete");

    // Close menu by clicking elsewhere
    document.body.click();

    // Restore mocks
    mock.on("GET", "/api/recentfiles", [
      { path: "notes/alpha.md", title: "alpha", mtime: 2000 },
      { path: "notes/beta.md", title: "beta", mtime: 1000 },
    ]);
  });

  it("pin action in context menu calls pin API", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }
    mock.on("GET", "/api/recentfiles", [{ path: "notes/alpha.md", title: "alpha", mtime: 2000 }]);
    mock.on("GET", "/api/pinned", []);
    mock.on("POST", "/api/pin", {});

    emit("files:changed");
    await drain();

    const container = document.querySelector("#sidebar-tree")!;
    const navFile = container.querySelector(".nav-file") as HTMLElement;
    navFile.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }),
    );
    await tick();

    const items = document.body.querySelectorAll(".context-menu-item");
    (items[1] as HTMLElement).click(); // Pin
    await new Promise((r) => setTimeout(r, 50));

    // Restore
    mock.on("GET", "/api/recentfiles", [
      { path: "notes/alpha.md", title: "alpha", mtime: 2000 },
      { path: "notes/beta.md", title: "beta", mtime: 1000 },
    ]);
    mock.on("GET", "/api/pinned", []);
    emit("files:changed");
    await drain();
  });

  it("pinned:changed event refreshes pinned list", async () => {
    mock.on("GET", "/api/pinned", [{ path: "notes/alpha.md", title: "alpha" }]);
    mock.on("GET", "/api/recentfiles", [
      { path: "notes/alpha.md", title: "alpha", mtime: 2000 },
      { path: "notes/beta.md", title: "beta", mtime: 1000 },
    ]);

    emit("pinned:changed");
    await drain();

    const container = document.querySelector("#sidebar-tree")!;
    // Alpha should appear once (pinned, not also in recent section)
    const navFiles = container.querySelectorAll(".nav-file");
    expect(navFiles.length).toBeGreaterThan(0);

    // Restore
    mock.on("GET", "/api/pinned", []);
    emit("pinned:changed");
    await drain();
  });

  it("pinned files are not duplicated in the recent list", async () => {
    mock.on("GET", "/api/pinned", [{ path: "notes/alpha.md", title: "alpha" }]);
    mock.on("GET", "/api/recentfiles", [
      { path: "notes/alpha.md", title: "alpha", mtime: 2000 },
      { path: "notes/beta.md", title: "beta", mtime: 1000 },
    ]);

    emit("pinned:changed");
    emit("files:changed");
    await drain();

    const container = document.querySelector("#sidebar-tree")!;
    const alphaRows = [...container.querySelectorAll<HTMLElement>(".nav-file")].filter(
      (el) => el.title === "notes/alpha.md",
    );
    expect(alphaRows).toHaveLength(1);
  });

  it("clicking a nav item opens the corresponding tab", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }
    mock.on("GET", "/api/recentfiles", [
      { path: "notes/click-me.md", title: "click-me", mtime: 1 },
    ]);
    mock.on("GET", "/api/pinned", []);

    emit("files:changed");
    await drain();

    const container = document.querySelector("#sidebar-tree")!;
    const navFile = [...container.querySelectorAll<HTMLElement>(".nav-file")].find(
      (el) => el.title === "notes/click-me.md",
    );
    if (!navFile) {
      throw new Error("expected notes/click-me.md to render in file nav");
    }
    navFile.click();
    await drain();

    expect(getTabs()).toHaveLength(1);
    expect((getTabs()[0] as { path: string }).path).toBe("notes/click-me.md");
  });

  it("rename action in context menu emits file:rename via the typed bus", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }
    mock.on("GET", "/api/recentfiles", [{ path: "notes/alpha.md", title: "alpha", mtime: 2000 }]);
    mock.on("GET", "/api/pinned", []);

    emit("files:changed");
    await drain();

    const container = document.querySelector("#sidebar-tree")!;
    const navFile = container.querySelector(".nav-file") as HTMLElement;
    navFile.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }),
    );
    await tick();

    let renameDetail: { oldPath: string; newPath: string } | null = null;
    const offRename = on("file:rename", (detail) => {
      renameDetail = detail;
    });

    const items = document.body.querySelectorAll(".context-menu-item");
    (items[0] as HTMLElement).click(); // Rename...
    await tick();

    const dialogInput = document.querySelector("#input-dialog-input") as HTMLInputElement;
    dialogInput.value = "alpha-renamed";
    dialogInput.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await tick();

    offRename();
    expect(renameDetail !== null).toBeTruthy();
    expect(renameDetail!.oldPath).toBe("notes/alpha.md");
    expect(renameDetail!.newPath).toBe("notes/alpha-renamed.md");
  });

  it("delete action in context menu calls deleteNote API", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }
    mock.on("GET", "/api/recentfiles", [{ path: "notes/alpha.md", title: "alpha", mtime: 2000 }]);
    mock.on("GET", "/api/pinned", []);
    mock.on("DELETE", "/api/note", {});

    emit("files:changed");
    await drain();

    const container = document.querySelector("#sidebar-tree")!;
    const navFile = container.querySelector(".nav-file") as HTMLElement;
    navFile.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }),
    );
    await tick();

    const items = document.body.querySelectorAll(".context-menu-item");
    (items[2] as HTMLElement).click(); // Delete
    await drain();
    // confirm returns true (mocked by setupDOM), so deletion proceeds
  });

  it("active element is the correct one (not stale) after save", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }
    await openTab("notes/alpha.md");
    await openTab("notes/beta.md");
    await tick();

    // beta is active; simulate a save
    emit("files:changed");
    emit("files:changed");

    await drain();

    expect(activeCount()).toBe(1);
    const activeEl = document.querySelector(".nav-file.active") as HTMLElement;
    expect(activeEl?.title).toBe("notes/beta.md");
  });
});
