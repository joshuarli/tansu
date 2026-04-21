import { describe, test, expect, beforeAll, afterAll } from "bun:test";

import { emit } from "./events.ts";
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

    // Register /api/note before /api/notes so the more specific one wins
    // (mock searches in reverse — last registered has highest priority)
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    mock.on("GET", "/api/state", { tabs: [], active: -1 });
    mock.on("PUT", "/api/state", {});
    mock.on("GET", "/api/pinned", []);
    mock.on("GET", "/api/recentfiles", [
      { path: "notes/alpha.md", title: "alpha", mtime: 2000 },
      { path: "notes/beta.md", title: "beta", mtime: 1000 },
    ]);
    // /api/notes must be last so it takes priority over /api/note for list fetches
    mock.on("GET", "/api/notes", [
      { path: "notes/alpha.md", title: "alpha" },
      { path: "notes/beta.md", title: "beta" },
    ]);

    // Import tab-state first so openTab is available
    const tabMod = await import("./tab-state.ts");
    openTab = tabMod.openTab;
    closeTab = tabMod.closeTab;
    getTabs = tabMod.getTabs;

    // Clean any state from other test files
    while (getTabs().length > 0) closeTab(0);

    const navMod = await import("./filenav.ts");
    navCleanup = await navMod.initFileNav();
  });

  afterAll(() => {
    navCleanup();
    mock.restore();
    cleanup();
  });

  test("tree: no duplicate .active after two rapid files:changed (save + SSE pattern)", async () => {
    while (getTabs().length > 0) closeTab(0);
    await openTab("notes/alpha.md");
    await tick();

    // Simulate local save emit + SSE emit fired in the same tick
    emit("files:changed", undefined);
    emit("files:changed", undefined);

    await drain();

    expect(activeCount()).toBe(1);
  });

  test("tree: no duplicate .active after sequential files:changed", async () => {
    while (getTabs().length > 0) closeTab(0);
    await openTab("notes/alpha.md");
    await tick();

    emit("files:changed", undefined);
    await drain();
    emit("files:changed", undefined);
    await drain();

    expect(activeCount()).toBe(1);
  });

  test("recent: no duplicate .active after two rapid files:changed", async () => {
    while (getTabs().length > 0) closeTab(0);
    await openTab("notes/alpha.md");
    await tick();

    // Switch to recent mode
    const recentBtn = document.getElementById("sidebar-recent-btn") as HTMLButtonElement;
    recentBtn.click();
    await drain();

    emit("files:changed", undefined);
    emit("files:changed", undefined);

    await drain();

    expect(activeCount()).toBe(1);

    // Reset to tree mode
    recentBtn.click();
    await tick();
  });

  test("tree: no duplicate .active when tab:change fires while files:changed render is in-flight", async () => {
    while (getTabs().length > 0) closeTab(0);
    await openTab("notes/alpha.md");
    await tick();

    // Emit files:changed to start an in-flight render (it will await network)
    emit("files:changed", undefined);

    // Immediately emit tab:change (simulates switching tab while render is in-flight)
    // openTab triggers tab:change via notifyChange → onTabChange → renderTree
    await openTab("notes/beta.md");

    await drain();

    expect(activeCount()).toBe(1);
  });

  test("tree: no duplicate under rapid files:changed + tab:change interleave", async () => {
    while (getTabs().length > 0) closeTab(0);
    await openTab("notes/alpha.md");
    await tick();

    // Fire many events in rapid succession: save + SSE + tab switch all at once
    emit("files:changed", undefined); // local save
    emit("files:changed", undefined); // SSE
    await openTab("notes/beta.md"); // tab switch triggers tab:change
    emit("files:changed", undefined); // extra SSE (e.g. second watcher event)

    await drain();

    expect(activeCount()).toBe(1);
    const activeEl = document.querySelector(".nav-file.active") as HTMLElement;
    expect(activeEl?.title).toBe("notes/beta.md");
  });

  test("tree: no duplicate with real network delay (save emit fires during slower SSE re-render)", async () => {
    while (getTabs().length > 0) closeTab(0);
    await openTab("notes/alpha.md");
    await tick();

    // Simulate network lag on the SECOND files:changed by overriding /api/notes to be slow.
    // The first emit completes fast; the second (SSE) triggers a slow refresh.
    // Meanwhile, tab:change also fires. Check for no duplicates.
    mock.onDelayed(
      "GET",
      "/api/notes",
      [
        { path: "notes/alpha.md", title: "alpha" },
        { path: "notes/beta.md", title: "beta" },
      ],
      10,
    );

    emit("files:changed", undefined);
    emit("files:changed", undefined);

    // tab:change fires synchronously when switching tabs
    await openTab("notes/beta.md");

    await new Promise<void>((r) => setTimeout(r, 100));

    expect(activeCount()).toBe(1);
    const activeEl = document.querySelector(".nav-file.active") as HTMLElement;
    expect(activeEl?.title).toBe("notes/beta.md");
  });

  test("tree: active element is the correct one (not stale) after save", async () => {
    while (getTabs().length > 0) closeTab(0);
    await openTab("notes/alpha.md");
    await openTab("notes/beta.md");
    await tick();

    // beta is active; simulate a save
    emit("files:changed", undefined);
    emit("files:changed", undefined);

    await drain();

    expect(activeCount()).toBe(1);
    const activeEl = document.querySelector(".nav-file.active") as HTMLElement;
    expect(activeEl?.title).toBe("notes/beta.md");
  });
});
