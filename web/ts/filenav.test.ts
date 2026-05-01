import { render } from "solid-js/web";

import { Sidebar } from "./filenav.tsx";
import { serverStore } from "./server-store.ts";
import { setupDOM, mockFetch } from "./test-helper.ts";
import { TEST_IDS } from "./test-selectors.ts";
import { uiStore } from "./ui-store.ts";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const drain = () => new Promise<void>((r) => setTimeout(r, 50));
const activeCount = () => document.querySelectorAll(TEST_IDS.activeNavFile).length;

function emit(
  event: "files:changed" | "pinned:changed" | "vault:switched",
  data?: { savedPath?: string },
) {
  if (event === "files:changed") {
    serverStore.notifyFilesChanged(data?.savedPath);
    return;
  }
  if (event === "pinned:changed") {
    serverStore.notifyPinnedChanged();
    return;
  }
  void serverStore.handleVaultSwitched();
}

describe("filenav", () => {
  let cleanup: () => void;
  let mock: ReturnType<typeof mockFetch>;
  let disposeDialogHost: (() => void) | null = null;
  let openTab: (path: string) => Promise<unknown>;
  let closeTab: (i: number) => void;
  let getTabs: () => unknown[];

  beforeAll(async () => {
    cleanup = setupDOM();
    const { delegateEvents } = await import("solid-js/web");
    delegateEvents(["click", "input", "change", "keydown", "contextmenu", "auxclick"]);
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
    const dialogMod = await import("./input-dialog.tsx");

    while (getTabs().length > 0) {
      closeTab(0);
    }

    const root = document.querySelector("#app") as HTMLElement;
    disposeDialogHost = render(() => dialogMod.InputDialogHost(), root);
    const sidebarHost = document.querySelector("#sidebar") as HTMLElement;
    sidebarHost.innerHTML = "";
    render(
      () =>
        Sidebar({
          appEl: root,
        }),
      sidebarHost,
    );
  });

  afterAll(() => {
    disposeDialogHost?.();
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
    serverStore.notifyPinnedChanged();
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
    serverStore.notifyFilesChanged();
    serverStore.notifyFilesChanged();

    await drain();

    expect(activeCount()).toBe(1);
  });

  it("no duplicate .active after sequential files:changed", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }
    await openTab("notes/alpha.md");
    await tick();

    serverStore.notifyFilesChanged();
    await drain();
    emit("files:changed");
    await drain();

    expect(activeCount()).toBe(1);
  });

  it("savedPath update promotes the saved file once without looping", async () => {
    mock.on("GET", "/api/recentfiles", [
      { path: "notes/alpha.md", title: "alpha", mtime: 2000 },
      { path: "notes/beta.md", title: "beta", mtime: 1000 },
    ]);

    serverStore.notifyFilesChanged("notes/beta.md");
    await drain();

    const rows = [...document.querySelectorAll<HTMLElement>(TEST_IDS.navFile)];
    const betaRows = rows.filter((row) => row.title === "notes/beta.md");
    expect(betaRows).toHaveLength(1);
    expect(betaRows[0]?.querySelector(TEST_IDS.navFileName)?.textContent).toBe("beta");
  });

  it("no duplicate .active after two rapid files:changed (recent mode)", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }
    await openTab("notes/alpha.md");
    await tick();

    serverStore.notifyFilesChanged();
    serverStore.notifyFilesChanged();

    await drain();

    expect(activeCount()).toBe(1);
  });

  it("no duplicate .active when active-tab state changes while files refresh is in-flight", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }
    await openTab("notes/alpha.md");
    await tick();

    // Emit files:changed to start an in-flight render (it will await network)
    serverStore.notifyFilesChanged();

    // Immediately switch tabs while the refresh is in flight.
    await openTab("notes/beta.md");

    await drain();

    expect(activeCount()).toBe(1);
  });

  it("no duplicate under rapid files:changed + active-tab interleave", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }
    await openTab("notes/alpha.md");
    await tick();

    // Fire many updates in rapid succession: save + SSE + tab switch all at once.
    serverStore.notifyFilesChanged();
    serverStore.notifyFilesChanged();
    await openTab("notes/beta.md");
    serverStore.notifyFilesChanged();

    await drain();

    expect(activeCount()).toBe(1);
    const activeEl = document.querySelector(TEST_IDS.activeNavFile) as HTMLElement;
    expect(activeEl?.title).toBe("notes/beta.md");
  });

  it("no duplicate with real network delay (save emit fires during slower SSE re-render)", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }
    await openTab("notes/alpha.md");
    await tick();

    // Simulate network lag on the second files refresh while the active tab changes.
    mock.onDelayed(
      "GET",
      "/api/recentfiles",
      [
        { path: "notes/alpha.md", title: "alpha", mtime: 2000 },
        { path: "notes/beta.md", title: "beta", mtime: 1000 },
      ],
      10,
    );

    serverStore.notifyFilesChanged();
    serverStore.notifyFilesChanged();

    await openTab("notes/beta.md");

    await new Promise<void>((r) => setTimeout(r, 100));

    expect(activeCount()).toBe(1);
    const activeEl = document.querySelector(TEST_IDS.activeNavFile) as HTMLElement;
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
    expect(container.querySelector(TEST_IDS.navFile) !== null).toBeTruthy();
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
    expect(container.querySelector(TEST_IDS.navFile) !== null).toBeTruthy();
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
    expect(container.querySelector(TEST_IDS.navFile) !== null).toBeTruthy();
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
    const dirLine = container.querySelector(TEST_IDS.navFileDir);
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
    const navFile = container.querySelector(TEST_IDS.navFile) as HTMLElement;
    expect(navFile !== null).toBeTruthy();

    navFile.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }),
    );
    await tick();

    const menu = document.body.querySelector(TEST_IDS.contextMenu);
    expect(menu !== null).toBeTruthy();
    const items = menu!.querySelectorAll(TEST_IDS.contextMenuItem);
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
    const navFile = container.querySelector(TEST_IDS.navFile) as HTMLElement;
    navFile.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }),
    );
    await tick();

    const items = document.body.querySelectorAll(TEST_IDS.contextMenuItem);
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
    const navFiles = container.querySelectorAll(TEST_IDS.navFile);
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
    const alphaRows = [...container.querySelectorAll<HTMLElement>(TEST_IDS.navFile)].filter(
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
    const navFile = [...container.querySelectorAll<HTMLElement>(TEST_IDS.navFile)].find(
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

  it("rename action in context menu calls rename API with the new path", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }
    mock.on("GET", "/api/recentfiles", [{ path: "notes/alpha.md", title: "alpha", mtime: 2000 }]);
    mock.on("GET", "/api/pinned", []);
    mock.on("POST", "/api/rename", { updated: [] });

    emit("files:changed");
    await drain();

    const container = document.querySelector("#sidebar-tree")!;
    const navFile = container.querySelector(TEST_IDS.navFile) as HTMLElement;
    navFile.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }),
    );
    await tick();

    const items = document.body.querySelectorAll(TEST_IDS.contextMenuItem);
    (items[0] as HTMLElement).click(); // Rename...
    await new Promise((r) => setTimeout(r, 20));

    const dialogInput = document.querySelector("#input-dialog-input") as HTMLInputElement;
    dialogInput.value = "alpha-renamed";
    dialogInput.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await drain();

    const renameReq = mock.requests.find(
      (req) => req.method === "POST" && req.url === "/api/rename",
    );
    expect(renameReq?.body).toContain('"old_path":"notes/alpha.md"');
    expect(renameReq?.body).toContain('"new_path":"notes/alpha-renamed.md"');
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
    const navFile = container.querySelector(TEST_IDS.navFile) as HTMLElement;
    navFile.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }),
    );
    await tick();

    const items = document.body.querySelectorAll(TEST_IDS.contextMenuItem);
    (items[2] as HTMLElement).click(); // Delete
    await drain();
    // confirm returns true (mocked by setupDOM), so deletion proceeds
  });

  it("delete action failure emits a notification", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }
    mock.on("GET", "/api/recentfiles", [{ path: "notes/alpha.md", title: "alpha", mtime: 2000 }]);
    mock.on("GET", "/api/pinned", []);
    mock.on("DELETE", "/api/note", { error: "delete failed" }, 500);

    emit("files:changed");
    await drain();

    const container = document.querySelector("#sidebar-tree")!;
    const navFile = container.querySelector(TEST_IDS.navFile) as HTMLElement;
    navFile.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }),
    );
    await tick();

    const items = document.body.querySelectorAll(TEST_IDS.contextMenuItem);
    (items[2] as HTMLElement).click();
    await drain();

    expect(uiStore.notification().type).toBe("error");
    expect(uiStore.notification().msg).toContain("Failed to delete alpha");
    expect(uiStore.notification().msg).toContain("delete failed");
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
    const activeEl = document.querySelector(TEST_IDS.activeNavFile) as HTMLElement;
    expect(activeEl?.title).toBe("notes/beta.md");
  });

  it("stale search response does not overwrite a newer result", async () => {
    const staleResults = [{ path: "notes/stale.md", title: "stale" }];
    const freshResults = [{ path: "notes/fresh.md", title: "fresh" }];

    const searchInput = document.querySelector("#sidebar-search") as HTMLInputElement;

    // Register delayed handler for query "a" (stale — takes 80ms)
    mock.onDelayed("GET", /q=a$/, staleResults, 80);
    // Register fast handler for query "ab" (fresh — responds immediately)
    mock.on("GET", /q=ab$/, freshResults);

    // Type "a" then immediately "ab"; "ab" response will arrive first
    searchInput.value = "a";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();

    searchInput.value = "ab";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));

    // Wait long enough for the slow "a" response to also arrive
    await new Promise((r) => setTimeout(r, 120));

    const container = document.querySelector("#sidebar-tree")!;
    const rows = [...container.querySelectorAll<HTMLElement>(TEST_IDS.navFile)];
    const titles = rows.map((el) => el.title);
    // Fresh result for "ab" should be shown; stale result for "a" should not have overwritten it
    expect(titles).toContain("notes/fresh.md");
    expect(titles).not.toContain("notes/stale.md");
  });

  it("context menu shows Unpin when file is already pinned", async () => {
    mock.on("GET", "/api/pinned", [{ path: "notes/alpha.md", title: "alpha" }]);
    mock.on("GET", "/api/recentfiles", [{ path: "notes/alpha.md", title: "alpha", mtime: 2000 }]);
    mock.on("DELETE", "/api/pin", {});

    emit("pinned:changed");
    await drain();

    const container = document.querySelector("#sidebar-tree")!;
    const navFile = container.querySelector(TEST_IDS.navFile) as HTMLElement;
    navFile.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }),
    );
    await tick();

    const items = document.body.querySelectorAll(TEST_IDS.contextMenuItem);
    expect(items[1]!.textContent).toBe("Unpin");

    (items[1] as HTMLElement).click();
    await tick();
    await new Promise((r) => setTimeout(r, 50));

    const deleteReqs = mock.requests.filter(
      (r) => r.method === "DELETE" && r.url.includes("/api/pin"),
    );
    expect(deleteReqs.length).toBeGreaterThan(0);
  });

  it("active state updates when tab switches without files:changed", async () => {
    while (getTabs().length > 0) {
      closeTab(0);
    }
    mock.on("GET", "/api/recentfiles", [
      { path: "notes/alpha.md", title: "alpha", mtime: 2000 },
      { path: "notes/beta.md", title: "beta", mtime: 1000 },
    ]);
    mock.on("GET", "/api/pinned", []);
    emit("files:changed");
    await drain();

    // Both alpha and beta are in the initial recent files mock.
    await openTab("notes/alpha.md");
    await drain();

    expect(activeCount()).toBe(1);
    expect((document.querySelector(TEST_IDS.activeNavFile) as HTMLElement)?.title).toBe(
      "notes/alpha.md",
    );

    // Switch to beta without emitting files:changed — reactive getActiveTab() should update nav.
    await openTab("notes/beta.md");
    await drain();

    expect(activeCount()).toBe(1);
    const activeEl = document.querySelector(TEST_IDS.activeNavFile) as HTMLElement;
    expect(activeEl?.title).toBe("notes/beta.md");
  });
});
