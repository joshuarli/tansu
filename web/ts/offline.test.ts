/// Tests for offline resilience: closed-tab stack, IDB caching, and offline fallback.
/// Uses fake-indexeddb so the full IDB paths are exercised.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";

import "fake-indexeddb/auto";
import type { SessionState } from "./api.ts";
import { on } from "./events.ts";
import { openStore, closeStore, kvGet, kvPut, noteGet, notePut } from "./local-store.ts";
import { setupDOM, mockFetch } from "./test-helper.ts";

describe("offline resilience", () => {
  let cleanup: () => void;
  let mock: ReturnType<typeof mockFetch>;
  let openTab: (path: string) => Promise<any>;
  let closeTab: (i: number) => void;
  let switchTab: (index: number) => Promise<void>;
  let getTabs: () => any[];
  let markClean: (path: string, content: string, mtime: number) => void;
  let reopenClosedTab: () => Promise<void>;
  let clearClosedTabs: () => void;
  let syncToServer: () => Promise<void>;
  let restoreSession: () => Promise<void>;
  let offRender: () => void;
  let offChange: () => void;

  function cleanState() {
    while (getTabs().length > 0) closeTab(0);
    clearClosedTabs();
  }

  beforeAll(async () => {
    cleanup = setupDOM();
    mock = mockFetch();
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    mock.on("PUT", "/api/state", {});
    mock.on("GET", "/api/state", { tabs: [], active: -1 });
    mock.on("POST", "/api/note", { mtime: 2000 });

    await openStore();

    const mod = await import("./tab-state.ts");
    openTab = mod.openTab;
    closeTab = mod.closeTab;
    switchTab = mod.switchTab;
    getTabs = mod.getTabs;
    markClean = mod.markClean;
    reopenClosedTab = mod.reopenClosedTab;
    clearClosedTabs = mod.clearClosedTabs;
    syncToServer = mod.syncToServer;
    restoreSession = mod.restoreSession;

    offRender = on("tab:render", () => {});
    offChange = on("tab:change", () => {});
  });

  afterAll(() => {
    offRender();
    offChange();
    mock.restore();
    closeStore();
    cleanup();
  });

  test("openTab caches note content to IDB", async () => {
    cleanState();
    mock.on("GET", "/api/note", { content: "# Cached", mtime: 3000 });

    await openTab("notes/cached.md");
    await new Promise((r) => setTimeout(r, 10));

    const cached = await noteGet("notes/cached.md");
    expect(cached).toEqual({ content: "# Cached", mtime: 3000 });

    cleanState();
  });

  test("openTab falls back to IDB cache when server is down", async () => {
    cleanState();

    // Cache a note via successful open
    mock.on("GET", "/api/note", { content: "# Hello", mtime: 5000 });
    await openTab("notes/offline.md");
    await new Promise((r) => setTimeout(r, 10));
    closeTab(0);
    clearClosedTabs();

    // Server goes down
    mock.on("GET", "/api/note", "server error", 500);

    const tab = await openTab("notes/offline.md");
    expect(tab.content).toBe("# Hello");
    expect(tab.mtime).toBe(5000);

    cleanState();
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
  });

  test("openTab throws when server is down and no cache exists", async () => {
    cleanState();
    mock.on("GET", "/api/note", "server error", 500);

    let threw = false;
    try {
      await openTab("notes/never-seen.md");
    } catch (e: any) {
      threw = true;
      expect(e.message).toContain("not available offline");
    }
    expect(threw).toBe(true);

    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
  });

  test("switchTab falls back to IDB cache when server is down", async () => {
    cleanState();

    // Open two tabs while online
    mock.on("GET", "/api/note", { content: "# First", mtime: 1000 });
    await openTab("notes/first.md");
    mock.on("GET", "/api/note", { content: "# Second", mtime: 2000 });
    await openTab("notes/second.md");
    await new Promise((r) => setTimeout(r, 10));

    // Simulate lazy tab state (mtime=0 means not yet loaded)
    const tab0 = getTabs()[0]!;
    tab0.content = "";
    tab0.mtime = 0;

    // Server goes down
    mock.on("GET", "/api/note", "server error", 500);

    await switchTab(0);

    expect(getTabs()[0]!.content).toBe("# First");
    expect(getTabs()[0]!.mtime).toBe(1000);

    cleanState();
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
  });

  test("markClean caches updated content to IDB", async () => {
    cleanState();
    mock.on("GET", "/api/note", { content: "# Original", mtime: 1000 });

    await openTab("notes/saved.md");
    markClean("notes/saved.md", "# Edited", 2000);
    await new Promise((r) => setTimeout(r, 10));

    const cached = await noteGet("notes/saved.md");
    expect(cached).toEqual({ content: "# Edited", mtime: 2000 });

    cleanState();
  });

  test("closeTab caches note content to IDB", async () => {
    cleanState();
    mock.on("GET", "/api/note", { content: "# Closing", mtime: 7000 });

    await openTab("notes/closing.md");
    closeTab(0);
    await new Promise((r) => setTimeout(r, 10));

    const cached = await noteGet("notes/closing.md");
    expect(cached).toEqual({ content: "# Closing", mtime: 7000 });

    clearClosedTabs();
  });

  test("persistState writes session state including closed tabs to IDB", async () => {
    cleanState();
    mock.on("GET", "/api/note", { content: "# A", mtime: 1000 });

    await openTab("notes/a.md");
    await openTab("notes/b.md");
    closeTab(0); // close a — pushes to closed stack
    await new Promise((r) => setTimeout(r, 10));

    const state = await kvGet<SessionState>("session");
    expect(state).toBeDefined();
    expect(state!.tabs).toEqual(["notes/b.md"]);
    expect(state!.active).toBe(0);
    expect(state!.closed).toContain("notes/a.md");

    cleanState();
  });

  test("restoreSession falls back to IDB when server is down", async () => {
    cleanState();

    // Seed IDB with session state and note cache
    await kvPut("session", {
      tabs: ["notes/offline-a.md"],
      active: 0,
      closed: ["notes/old.md"],
    } satisfies SessionState);
    await notePut("notes/offline-a.md", "# Offline A", 9000);

    // Server is completely down
    mock.on("GET", "/api/state", "server error", 500);
    mock.on("GET", "/api/note", "server error", 500);

    await restoreSession();

    expect(getTabs().length).toBe(1);
    expect(getTabs()[0]!.path).toBe("notes/offline-a.md");
    expect(getTabs()[0]!.content).toBe("# Offline A");
    expect(getTabs()[0]!.mtime).toBe(9000);

    cleanState();
    mock.on("GET", "/api/state", { tabs: [], active: -1 });
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
  });

  test("syncToServer pushes cached state to server", async () => {
    cleanState();
    mock.on("GET", "/api/note", { content: "# X", mtime: 1000 });

    await openTab("notes/x.md");
    await new Promise((r) => setTimeout(r, 10));

    const cached = await kvGet<SessionState>("session");
    expect(cached).toBeDefined();
    expect(cached!.tabs).toContain("notes/x.md");

    // syncToServer reads from IDB and pushes to server (mock accepts the PUT)
    await syncToServer();

    cleanState();
  });

  test("syncToServer is a no-op when IDB has no cached state", async () => {
    cleanState();
    // Clear IDB session state
    await kvPut("session", undefined);

    // Should not throw
    await syncToServer();
  });

  test("restoreSession restores closed-tab stack even with no open tabs", async () => {
    cleanState();

    mock.on("GET", "/api/state", {
      tabs: [],
      active: -1,
      closed: ["notes/orphan-1.md", "notes/orphan-2.md"],
    });

    await restoreSession();

    // No tabs open
    expect(getTabs().length).toBe(0);

    // But closed stack was restored — reopen works
    mock.on("GET", "/api/note", { content: "# Orphan 2", mtime: 1000 });
    await reopenClosedTab();
    expect(getTabs().length).toBe(1);
    expect(getTabs()[0]!.path).toBe("notes/orphan-2.md");

    cleanState();
    mock.on("GET", "/api/state", { tabs: [], active: -1 });
  });
});

describe("closed-tab stack", () => {
  let cleanup: () => void;
  let mock: ReturnType<typeof mockFetch>;
  let openTab: (path: string) => Promise<any>;
  let closeTab: (i: number) => void;
  let getTabs: () => any[];
  let reopenClosedTab: () => Promise<void>;
  let clearClosedTabs: () => void;
  let restoreSession: () => Promise<void>;
  let offRender: () => void;
  let offChange: () => void;

  function cleanState() {
    while (getTabs().length > 0) closeTab(0);
    clearClosedTabs();
  }

  beforeAll(async () => {
    cleanup = setupDOM();
    mock = mockFetch();
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
    mock.on("PUT", "/api/state", {});
    mock.on("GET", "/api/state", { tabs: [], active: -1 });

    await openStore();

    const mod = await import("./tab-state.ts");
    openTab = mod.openTab;
    closeTab = mod.closeTab;
    getTabs = mod.getTabs;
    reopenClosedTab = mod.reopenClosedTab;
    clearClosedTabs = mod.clearClosedTabs;
    restoreSession = mod.restoreSession;

    offRender = on("tab:render", () => {});
    offChange = on("tab:change", () => {});
  });

  afterAll(() => {
    offRender();
    offChange();
    mock.restore();
    closeStore();
    cleanup();
  });

  test("close pushes to stack, reopen pops in LIFO order", async () => {
    cleanState();

    await openTab("notes/a.md");
    await openTab("notes/b.md");
    await openTab("notes/c.md");

    closeTab(2); // c
    closeTab(1); // b

    expect(getTabs().length).toBe(1);

    // LIFO: b first
    await reopenClosedTab();
    expect(getTabs().length).toBe(2);
    expect(getTabs()[1]!.path).toBe("notes/b.md");

    // Then c
    await reopenClosedTab();
    expect(getTabs().length).toBe(3);
    expect(getTabs()[2]!.path).toBe("notes/c.md");

    cleanState();
  });

  test("reopenClosedTab handles unavailable note gracefully", async () => {
    cleanState();
    mock.on("GET", "/api/note", { content: "# Soon gone", mtime: 1000 });

    await openTab("notes/doomed.md");
    closeTab(0);

    // Server is down, note was never cached (clear it)
    const { noteDel } = await import("./local-store.ts");
    await noteDel("notes/doomed.md");

    mock.on("GET", "/api/note", "server error", 500);

    const warnSpy = console.warn;
    let warned = false;
    console.warn = (..._args: unknown[]) => {
      warned = true;
    };

    // Should not throw — the error is caught and logged
    await reopenClosedTab();

    console.warn = warnSpy;
    expect(warned).toBe(true);
    // Tab was not created (openTab failed)
    expect(getTabs().length).toBe(0);

    // Path was consumed — pressing again shouldn't retry the same note
    await reopenClosedTab();
    expect(getTabs().length).toBe(0);

    cleanState();
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
  });

  test("reopenClosedTab does nothing when stack is empty", async () => {
    cleanState();

    await openTab("notes/only.md");
    expect(getTabs().length).toBe(1);

    await reopenClosedTab();
    expect(getTabs().length).toBe(1);

    cleanState();
  });

  test("reopening already-open tab switches to it instead of duplicating", async () => {
    cleanState();

    await openTab("notes/dup.md");
    closeTab(0);

    // Manually reopen the same path
    await openTab("notes/dup.md");
    expect(getTabs().length).toBe(1);

    // Reopen from stack — same path, should just switch
    await reopenClosedTab();
    expect(getTabs().length).toBe(1);
    expect(getTabs()[0]!.path).toBe("notes/dup.md");

    cleanState();
  });

  test("closed stack is bounded to 20", async () => {
    cleanState();

    // Open all 25, then close all 25
    for (let i = 0; i < 25; i++) {
      await openTab(`notes/bulk-${i}.md`);
    }
    expect(getTabs().length).toBe(25);

    // Close all — each pushes to closed stack
    for (let i = 24; i >= 0; i--) {
      closeTab(i);
    }
    expect(getTabs().length).toBe(0);

    // Reopen all — should get at most 20
    let reopened = 0;
    for (let i = 0; i < 25; i++) {
      const before = getTabs().length;
      await reopenClosedTab();
      if (getTabs().length > before) reopened++;
    }
    expect(reopened).toBe(20);

    // Oldest 5 (bulk-20 through bulk-24, closed first) should be evicted.
    // bulk-0 was closed last so it's most recent on the stack.
    const paths = getTabs().map((t: any) => t.path);
    expect(paths).toContain("notes/bulk-0.md");
    expect(paths).toContain("notes/bulk-4.md");
    expect(paths).not.toContain("notes/bulk-24.md");
    expect(paths).not.toContain("notes/bulk-20.md");

    cleanState();
  });

  test("restoreSession restores closed-tab stack", async () => {
    cleanState();

    mock.on("GET", "/api/state", {
      tabs: ["notes/active.md"],
      active: 0,
      closed: ["notes/was-closed-1.md", "notes/was-closed-2.md"],
    });
    mock.on("GET", "/api/note", { content: "# Active", mtime: 1000 });

    await restoreSession();

    expect(getTabs().length).toBe(1);
    expect(getTabs()[0]!.path).toBe("notes/active.md");

    // LIFO: was-closed-2 first
    await reopenClosedTab();
    expect(getTabs().length).toBe(2);
    expect(getTabs()[1]!.path).toBe("notes/was-closed-2.md");

    await reopenClosedTab();
    expect(getTabs().length).toBe(3);
    expect(getTabs()[2]!.path).toBe("notes/was-closed-1.md");

    cleanState();
    mock.on("GET", "/api/state", { tabs: [], active: -1 });
    mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
  });
});
