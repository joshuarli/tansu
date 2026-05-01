import { createModalManager, modalManager } from "./modal-manager.ts";
import { createServerStore } from "./server-store.ts";
import { createTabsStore } from "./tab-state.ts";
import { setupDOM } from "./test-helper.ts";
import { createUiStore, type UiStore } from "./ui-store.ts";

function configureServerStore(store: ReturnType<typeof createServerStore>, uiStore: UiStore) {
  store.configure({
    invalidateNoteCache: () => {},
    getActivePath: () => null,
    reloadActiveNote: () => {},
    closeActiveTab: () => {},
    syncSessionToServer: async () => {},
    refreshVaultSwitcher: async () => {},
    showUnlockScreen: () => {},
    clearServerStatus: () => uiStore.clearServerStatus(),
    setServerStatus: (msg) => uiStore.setServerStatus(msg),
    showNotification: (msg, type) => uiStore.showNotification(msg, type),
  });
}

class MockEventSource extends EventTarget {
  static instances: MockEventSource[] = [];
  onerror: ((event: Event) => void) | null = null;
  readonly url: string;
  closed = false;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    MockEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }
}

describe("store factories", () => {
  afterEach(() => {
    while (modalManager.activeModal()) {
      modalManager.closeTop({ skipRestoreFocus: true });
    }
  });

  it("creates isolated UI stores", () => {
    const first = createUiStore(createModalManager());
    const second = createUiStore(createModalManager());

    first.openSearch("a.md");
    second.openPalette();

    expect(first.searchVisibleOpen()).toBeTruthy();
    expect(first.searchScopePath()).toBe("a.md");
    expect(first.paletteVisibleOpen()).toBeFalsy();
    expect(second.searchVisibleOpen()).toBeFalsy();
    expect(second.paletteVisibleOpen()).toBeTruthy();
  });

  it("keeps exclusive modals mutually exclusive within a UI store", () => {
    const store = createUiStore(createModalManager());

    store.openSearch("a.md");
    expect(store.searchVisibleOpen()).toBeTruthy();
    expect(store.searchScopePath()).toBe("a.md");

    store.openSettings();
    expect(store.searchVisibleOpen()).toBeFalsy();
    expect(store.searchScopePath()).toBeNull();
    expect(store.settingsVisibleOpen()).toBeTruthy();
    expect(store.paletteVisibleOpen()).toBeFalsy();

    store.openPalette();
    expect(store.settingsVisibleOpen()).toBeFalsy();
    expect(store.paletteVisibleOpen()).toBeTruthy();

    store.toggleSearch("b.md");
    expect(store.searchVisibleOpen()).toBeTruthy();
    expect(store.searchScopePath()).toBe("b.md");
    expect(store.paletteVisibleOpen()).toBeFalsy();
    expect(store.settingsVisibleOpen()).toBeFalsy();
  });

  it("tracks requested and visible modal state separately when a stacked dialog obscures a modal", () => {
    const manager = createModalManager();
    const store = createUiStore(manager);

    store.openSettings();
    expect(store.isSettingsRequestedOpen()).toBeTruthy();
    expect(store.settingsVisibleOpen()).toBeTruthy();

    manager.push("input-dialog");
    expect(store.isSettingsRequestedOpen()).toBeTruthy();
    expect(store.settingsVisibleOpen()).toBeFalsy();

    manager.closeTop({ skipRestoreFocus: true });
    expect(store.isSettingsRequestedOpen()).toBeTruthy();
    expect(store.settingsVisibleOpen()).toBeTruthy();
  });

  it("creates isolated tab stores", () => {
    const first = createTabsStore();
    const second = createTabsStore();

    first.setCursor("a.md", 10);
    second.setCursor("a.md", 20);

    expect(first.getTabs()).toStrictEqual([]);
    expect(second.getTabs()).toStrictEqual([]);
    expect(first.getCursor("a.md")).toBe(10);
    expect(second.getCursor("a.md")).toBe(20);
  });

  it("creates isolated server stores", () => {
    const first = createServerStore();
    const second = createServerStore();

    first.notifyFilesChanged("a.md");
    second.notifyPinnedChanged();

    expect(first.fileChange()).toStrictEqual({ version: 1, savedPath: "a.md" });
    expect(second.fileChange()).toStrictEqual({ version: 0, savedPath: null });
    expect(first.pinnedVersion()).toBe(0);
    expect(second.pinnedVersion()).toBe(1);
  });

  it("does not start SSE before server store dependencies are configured", () => {
    const store = createServerStore();

    expect(() => store.start()).toThrow("server store not configured");
  });

  it("tracks connected and retrying SSE states", () => {
    const cleanup = setupDOM();
    const originalEventSource = globalThis.EventSource;
    MockEventSource.instances = [];
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;

    try {
      const uiStore = createUiStore();
      const store = createServerStore();
      configureServerStore(store, uiStore);
      sessionStorage.setItem("tansu_vault", "0");

      store.start();
      expect(store.connectionState()).toStrictEqual({ type: "connecting" });
      expect(MockEventSource.instances[0]!.url).toBe("/events?vault=0");

      MockEventSource.instances[0]!.dispatchEvent(new Event("connected"));
      expect(store.connectionState()).toStrictEqual({ type: "connected" });

      MockEventSource.instances[0]!.onerror?.(new Event("error"));
      expect(store.connectionState().type).toBe("retrying");
      expect(uiStore.serverStatus()).toContain("Server unavailable");

      store.stop();
      expect(store.connectionState()).toStrictEqual({ type: "unavailable" });
    } finally {
      globalThis.EventSource = originalEventSource;
      cleanup();
    }
  });

  it("tracks locked SSE state", () => {
    const cleanup = setupDOM();
    const originalEventSource = globalThis.EventSource;
    MockEventSource.instances = [];
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;

    try {
      const store = createServerStore();
      configureServerStore(store, createUiStore());
      sessionStorage.setItem("tansu_vault", "0");

      store.start();
      MockEventSource.instances[0]!.dispatchEvent(new Event("locked"));

      expect(store.connectionState()).toStrictEqual({ type: "locked" });
      expect(MockEventSource.instances[0]!.closed).toBeTruthy();
    } finally {
      globalThis.EventSource = originalEventSource;
      cleanup();
    }
  });

  it("reconnects SSE after a vault switch while started", async () => {
    const cleanup = setupDOM();
    const originalEventSource = globalThis.EventSource;
    MockEventSource.instances = [];
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;

    try {
      const store = createServerStore();
      configureServerStore(store, createUiStore());
      sessionStorage.setItem("tansu_vault", "0");

      store.start();
      MockEventSource.instances[0]!.dispatchEvent(new Event("connected"));
      sessionStorage.setItem("tansu_vault", "1");

      await store.handleVaultSwitched();

      expect(MockEventSource.instances[0]!.closed).toBeTruthy();
      expect(MockEventSource.instances).toHaveLength(2);
      expect(MockEventSource.instances[1]!.url).toBe("/events?vault=1");
      expect(store.connectionState()).toStrictEqual({ type: "connecting" });
    } finally {
      globalThis.EventSource = originalEventSource;
      cleanup();
    }
  });
});
