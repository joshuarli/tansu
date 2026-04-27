import { stemFromPath } from "@joshuarli98/md-wysiwyg";

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
import { createSearch } from "./search.tsx";
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
import { initVaultSwitcher, refreshVaultSwitcher } from "./vault-switcher.tsx";
import { isPrfLikelySupported, getPrfKey } from "./webauthn.ts";
import { registerWikiLinkClickHandler } from "./wikilinks.ts";

const appEl = document.querySelector("#app") as HTMLElement;
let appInitialized = false;
let editor: EditorInstance | null = null;
let palette: ReturnType<typeof createPalette> | null = null;
let search: ReturnType<typeof createSearch> | null = null;
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
  if (!sseLifecycle.getSse()) connectSSE();
  restoreSession();
}

function initApp() {
  editor = initEditor();
  initFileNav();
  void initVaultSwitcher();
  palette = createPalette();
  settings = createSettings();
  search = createSearch({ openTab, invalidateNoteCache });

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
      shortcut: "\u2318K",
      keys: { key: "k", meta: true },
      action: () => search?.toggle(),
    },
    {
      label: "Search in current note",
      shortcut: "\u2318F",
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
      shortcut: "\u21E7\u2318F",
      keys: { key: "f", meta: true, shift: true },
      action: () => search?.open(),
    },
    {
      label: "New note",
      shortcut: "\u2318N",
      keys: { key: "n", meta: true },
      action: () => promptNewNote(),
    },
    {
      label: "Reopen closed tab",
      shortcut: "\u21E7\u2318T",
      keys: { key: "t", meta: true, shift: true },
      action: () => reopenClosedTab(),
    },
    {
      label: "Save",
      shortcut: "\u2318S",
      keys: { key: "s", meta: true },
      action: () => editor?.saveCurrentNote(),
    },
    {
      label: "Close tab",
      shortcut: "\u2318W",
      keys: { key: "w", meta: true },
      action: () => closeActiveTab(),
    },
    {
      label: "Next tab",
      shortcut: "\u21E7\u2318]",
      keys: { key: "]", meta: true, shift: true },
      action: () => nextTab(),
    },
    {
      label: "Previous tab",
      shortcut: "\u21E7\u2318[",
      keys: { key: "[", meta: true, shift: true },
      action: () => prevTab(),
    },
    {
      label: "Settings",
      shortcut: "\u21E7\u2318S",
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

// Notification pill
const notif = document.querySelector("#notification") as HTMLElement;
const serverStatus = document.querySelector("#server-status") as HTMLElement;
const notificationController = createNotificationController(notif, NOTIFICATION_AUTO_DISMISS_MS);
const serverStatusController = createServerStatusController(serverStatus);

on("notification", ({ msg, type }) => notificationController.show(msg, type));

const sseBackoff = createBackoff([...SSE_BACKOFF_DELAYS_MS]);
const sseLifecycle = createSseLifecycle({ connectSse: connectSSE });

function connectSSE() {
  const existing = sseLifecycle.getSse();
  if (existing) {
    existing.close();
    sseLifecycle.setSse(null);
  }
  const timer = sseLifecycle.getReconnectTimer();
  if (timer) {
    clearTimeout(timer);
    sseLifecycle.setReconnectTimer(null);
  }
  if (sseLifecycle.isPageUnloading()) {
    return;
  }
  const es = new EventSource("/events");
  sseLifecycle.setSse(es);

  es.addEventListener("connected", () => {
    if (sseLifecycle.getSse() !== es) return;
    sseBackoff.reset();
    if (sseBackoff.wasUnavailable) {
      sseBackoff.wasUnavailable = false;
    }
    serverStatusController.hide();
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
      notificationController.show(`"${stemFromPath(path)}" was deleted externally.`);
      closeActiveTab();
    }
  });

  es.addEventListener("locked", () => {
    if (sseLifecycle.getSse() !== es) return;
    es.close();
    sseLifecycle.setSse(null);
    showUnlockScreen();
  });

  es.addEventListener("vault_switched", () => {
    if (sseLifecycle.getSse() !== es) return;
    void refreshVaultSwitcher();
    emit("vault:switched");
    emit("files:changed", {});
  });

  es.onerror = () => {
    if (sseLifecycle.getSse() !== es) return;
    es.close();
    sseLifecycle.setSse(null);
    if (sseLifecycle.isPageUnloading()) {
      return;
    }
    sseBackoff.wasUnavailable = true;
    const delay = sseBackoff.next();
    serverStatusController.show(`Server unavailable. Retrying in ${sseBackoff.format(delay)}...`);
    sseLifecycle.setReconnectTimer(
      setTimeout(() => {
        sseLifecycle.setReconnectTimer(null);
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

function teardownApp() {
  document.removeEventListener("keydown", globalKeydown);
}

export function bootLegacyApp() {
  document.addEventListener("keydown", globalKeydown);
  window.addEventListener("pagehide", teardownApp);
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
}
