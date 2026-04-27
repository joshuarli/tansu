import { stemFromPath } from "@joshuarli98/md-wysiwyg";
import { ErrorBoundary, onCleanup, onMount } from "solid-js";

import {
  renameNote,
  getNote,
  listNotes,
  getStatus,
  unlockWithRecoveryKey,
  unlockWithPrf,
  type AppStatus,
} from "./api.ts";
import {
  bootApp,
  checkBrowserSupport,
  createBackoff,
  createNotificationController,
  createServerStatusController,
  createSseLifecycle,
  showUnlockScreen as renderUnlockScreen,
  showUnsupportedPage,
} from "./bootstrap.ts";
import {
  MIN_SUPPORTED_FIREFOX_VERSION,
  NOTIFICATION_AUTO_DISMISS_MS,
  SSE_BACKOFF_DELAYS_MS,
} from "./constants.ts";
import { initEditor, invalidateNoteCache, type EditorInstance } from "./editor.ts";
import { emit, on } from "./events.ts";
import { initFileNav } from "./filenav.tsx";
import { openStore } from "./local-store.ts";
import { createPalette, matchesKey } from "./palette.tsx";
import { initSearch } from "./search.tsx";
import { createSettings } from "./settings.tsx";
import {
  closeActiveTab,
  nextTab,
  prevTab,
  getActiveTab,
  openTab,
  updateTabPath,
  updateTabContent,
  restoreSession,
  reopenClosedTab,
  syncToServer,
} from "./tab-state.ts";
import { promptNewNote } from "./tabs.tsx";
import { TabBarShell } from "./tabs.tsx";
import { initVaultSwitcher, refreshVaultSwitcher } from "./vault-switcher.tsx";
import { isPrfLikelySupported, getPrfKey } from "./webauthn.ts";
import { registerWikiLinkClickHandler } from "./wikilinks.ts";

export function App() {
  let notifRef!: HTMLDivElement;
  let statusRef!: HTMLDivElement;

  onMount(() => {
    const appEl = document.querySelector("#app") as HTMLElement;
    let appInitialized = false;
    let editor: EditorInstance | null = null;
    let palette: ReturnType<typeof createPalette> | null = null;
    let search: ReturnType<typeof initSearch> | null = null;
    let settings: ReturnType<typeof createSettings> | null = null;

    function showUnlockScreen(status?: AppStatus) {
      renderUnlockScreen({
        appEl,
        ...(status ? { status } : {}),
        isPrfLikelySupported,
        getPrfKey,
        unlockWithPrf,
        unlockWithRecoveryKey,
        onUnlocked: () => {
          void startApp();
        },
      });
    }

    async function startApp() {
      if (!appInitialized) {
        initApp();
        appInitialized = true;
      }
      await openStore();
      if (!sseLifecycle?.getSse()) connectSSE();
      restoreSession();
    }

    function initApp() {
      editor = initEditor();
      initFileNav();
      void initVaultSwitcher();
      palette = createPalette();
      settings = createSettings();
      search = initSearch({ openTab, invalidateNoteCache });

      registerWikiLinkClickHandler(async (target: string) => {
        const notes = await listNotes();
        const normalized = target.toLowerCase().replaceAll(/\s+/g, "-");
        const match = notes.find((n) => {
          const stem = stemFromPath(n.path).toLowerCase().replaceAll(/\s+/g, "-");
          return stem === normalized;
        });

        if (match) {
          await openTab(match.path);
        } else {
          const path = `${target}.md`;
          const { createNote } = await import("./api.ts");
          await createNote(path);
          invalidateNoteCache();
          await openTab(path);
        }
      });

      on("tab:change", (tab) => {
        if (tab) {
          editor?.showEditor(tab.path, tab.content, tab.tags);
        } else {
          editor?.hideEditor();
        }
      });

      palette.registerCommands([
        {
          label: "Search notes",
          shortcut: "⌘K",
          keys: { key: "k", meta: true },
          action: () => search?.toggle(),
        },
        {
          label: "Search in current note",
          shortcut: "⌘F",
          keys: { key: "f", meta: true },
          action: () => {
            const tab = getActiveTab();
            if (tab) {
              search?.open(tab.path);
            } else {
              search?.open();
            }
          },
        },
        {
          label: "Global search",
          shortcut: "⇧⌘F",
          keys: { key: "f", meta: true, shift: true },
          action: () => search?.open(),
        },
        {
          label: "New note",
          shortcut: "⌘N",
          keys: { key: "n", meta: true },
          action: () => promptNewNote(),
        },
        {
          label: "Reopen closed tab",
          shortcut: "⇧⌘T",
          keys: { key: "t", meta: true, shift: true },
          action: () => reopenClosedTab(),
        },
        {
          label: "Save",
          shortcut: "⌘S",
          keys: { key: "s", meta: true },
          action: () => editor?.saveCurrentNote(),
        },
        {
          label: "Close tab",
          shortcut: "⌘W",
          keys: { key: "w", meta: true },
          action: () => closeActiveTab(),
        },
        {
          label: "Next tab",
          shortcut: "⇧⌘]",
          keys: { key: "]", meta: true, shift: true },
          action: () => nextTab(),
        },
        {
          label: "Previous tab",
          shortcut: "⇧⌘[",
          keys: { key: "[", meta: true, shift: true },
          action: () => prevTab(),
        },
        {
          label: "Settings",
          shortcut: "⇧⌘S",
          keys: { key: "s", meta: true, shift: true },
          action: () => settings?.toggle(),
        },
      ]);

      on("file:rename", async ({ oldPath, newPath }) => {
        try {
          const result = await renameNote(oldPath, newPath);
          invalidateNoteCache();
          emit("files:changed");
          updateTabPath(oldPath, newPath);

          await Promise.all(
            result.updated.map(async (updated) => {
              try {
                const note = await getNote(updated);
                updateTabContent(updated, note.content, note.mtime, note.tags);
              } catch {
                /* reload failed silently */
              }
            }),
          );

          const active = getActiveTab();
          if (active && active.path === newPath) {
            editor?.showEditor(active.path, active.content, active.tags);
          }
        } catch {
          /* rename failed silently */
        }
      });
    }

    let notificationController: ReturnType<typeof createNotificationController> | null = null;
    let serverStatusController: ReturnType<typeof createServerStatusController> | null = null;
    let sseBackoff: ReturnType<typeof createBackoff> | null = null;
    let sseLifecycle: ReturnType<typeof createSseLifecycle> | null = null;

    function connectSSE() {
      const sl = sseLifecycle!;
      const sb = sseBackoff!;
      const nc = notificationController!;
      const sc = serverStatusController!;

      const existing = sl.getSse();
      if (existing) {
        existing.close();
        sl.setSse(null);
      }
      const timer = sl.getReconnectTimer();
      if (timer) {
        clearTimeout(timer);
        sl.setReconnectTimer(null);
      }
      if (sl.isPageUnloading()) {
        return;
      }
      const es = new EventSource("/events");
      sl.setSse(es);

      es.addEventListener("connected", () => {
        if (sl.getSse() !== es) return;
        sb.reset();
        if (sb.wasUnavailable) {
          sb.wasUnavailable = false;
        }
        sc.hide();
        syncToServer();
      });

      es.addEventListener("changed", async (e) => {
        const path = e.data;
        emit("files:changed", { savedPath: path });
        const active = getActiveTab();
        if (active && active.path === path) {
          try {
            const note = await getNote(path);
            editor?.reloadFromDisk(note.content, note.mtime);
          } catch {
            /* reload failed silently */
          }
        }
      });

      es.addEventListener("deleted", (e) => {
        const path = e.data;
        invalidateNoteCache();
        emit("files:changed", {});
        const active = getActiveTab();
        if (active && active.path === path) {
          nc.show(`"${stemFromPath(path)}" was deleted externally.`);
          closeActiveTab();
        }
      });

      es.addEventListener("locked", () => {
        if (sl.getSse() !== es) return;
        es.close();
        sl.setSse(null);
        showUnlockScreen();
      });

      es.addEventListener("vault_switched", () => {
        if (sl.getSse() !== es) return;
        void refreshVaultSwitcher();
        emit("vault:switched");
        emit("files:changed", {});
      });

      es.onerror = () => {
        if (sl.getSse() !== es) return;
        es.close();
        sl.setSse(null);
        if (sl.isPageUnloading()) {
          return;
        }
        sb.wasUnavailable = true;
        const delay = sb.next();
        sc.show(`Server unavailable. Retrying in ${sb.format(delay)}...`);
        sl.setReconnectTimer(
          setTimeout(() => {
            sl.setReconnectTimer(null);
            connectSSE();
          }, delay),
        );
      };
    }

    function globalKeydown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (palette?.isOpen()) {
          e.preventDefault();
          palette.close();
          return;
        }
        if (settings?.isOpen()) {
          e.preventDefault();
          settings.close();
          return;
        }
        if (search?.isOpen()) {
          e.preventDefault();
          search.close();
          return;
        }
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key === "p") {
        e.preventDefault();
        palette?.toggle();
        return;
      }

      if (palette) {
        for (const cmd of palette.getCommands()) {
          if (cmd.keys && matchesKey(e, cmd.keys)) {
            e.preventDefault();
            cmd.action();
            return;
          }
        }
      }
    }

    notificationController = createNotificationController(notifRef, NOTIFICATION_AUTO_DISMISS_MS);
    serverStatusController = createServerStatusController(statusRef);
    on("notification", ({ msg, type }) => notificationController!.show(msg, type));
    sseBackoff = createBackoff([...SSE_BACKOFF_DELAYS_MS]);
    sseLifecycle = createSseLifecycle({ connectSse: connectSSE });

    document.addEventListener("keydown", globalKeydown);
    window.addEventListener("pagehide", sseLifecycle.closeForUnload);
    window.addEventListener("beforeunload", sseLifecycle.closeForUnload);
    window.addEventListener("focus", sseLifecycle.requestImmediateReconnect);
    document.addEventListener("visibilitychange", sseLifecycle.onVisibilityChange);

    void bootApp({
      checkBrowserSupport,
      showUnsupportedPage: (missing) => {
        showUnsupportedPage(
          document.body,
          missing,
          navigator.userAgent,
          MIN_SUPPORTED_FIREFOX_VERSION,
        );
      },
      getStatus,
      showUnlockScreen,
      startApp,
    });

    onCleanup(() => {
      document.removeEventListener("keydown", globalKeydown);
      window.removeEventListener("pagehide", sseLifecycle!.closeForUnload);
      window.removeEventListener("beforeunload", sseLifecycle!.closeForUnload);
      window.removeEventListener("focus", sseLifecycle!.requestImmediateReconnect);
      document.removeEventListener("visibilitychange", sseLifecycle!.onVisibilityChange);
      sseLifecycle!.closeForUnload();
      notificationController?.dispose();
    });
  });

  return (
    <ErrorBoundary
      fallback={
        <div style={{ "font-family": "sans-serif", padding: "2rem" }}>
          Something went wrong. Please reload the page.
        </div>
      }
    >
      <div id="sidebar">
        <div class="sidebar-header">
          <input
            id="sidebar-search"
            type="text"
            placeholder="Filter files..."
            aria-label="Filter files"
            autocomplete="off"
            spellcheck={false}
          />
          <button id="sidebar-collapse" title="Collapse sidebar" aria-label="Collapse sidebar">
            &#x2039;
          </button>
        </div>
        <div id="vault-switcher"></div>
        <div id="sidebar-tree"></div>
      </div>
      <div class="app-main">
        <div
          class="notification hidden"
          aria-live="assertive"
          aria-atomic="true"
          ref={notifRef}
        ></div>
        <div id="tab-bar">
          <TabBarShell />
        </div>
        <div class="server-status hidden" aria-live="polite" ref={statusRef}></div>
        <div id="editor-area">
          <div id="empty-state">
            Press <kbd>Cmd+K</kbd> to search &middot; <kbd>Cmd+P</kbd> for commands
          </div>
        </div>
      </div>
      <div id="search-root"></div>
      <div id="settings-root"></div>
      <div id="input-dialog-overlay" class="hidden"></div>
      <div id="palette-root"></div>
    </ErrorBoundary>
  );
}
