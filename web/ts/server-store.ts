import { stemFromPath } from "@joshuarli98/md-wysiwyg";
import { createSignal } from "solid-js";

import { getNote } from "./api.ts";
import { createBackoff, createSseLifecycle } from "./bootstrap.ts";
import { SSE_BACKOFF_DELAYS_MS } from "./constants.ts";
import { uiStore } from "./ui-store.ts";

type FileChange = {
  version: number;
  savedPath: string | null;
};

type ServerStoreDeps = {
  invalidateNoteCache: () => void;
  getActivePath: () => string | null;
  reloadActiveNote: (content: string, mtime: number) => void;
  closeActiveTab: () => void;
  syncSessionToServer: () => Promise<void>;
  refreshVaultSwitcher: () => Promise<void>;
  showUnlockScreen: () => void;
};

function createServerStore() {
  const [fileChange, setFileChange] = createSignal<FileChange>({ version: 0, savedPath: null });
  const [pinnedVersion, setPinnedVersion] = createSignal(0);
  const [vaultVersion, setVaultVersion] = createSignal(0);

  let deps: ServerStoreDeps | null = null;
  let backoff = createBackoff([...SSE_BACKOFF_DELAYS_MS]);
  let lifecycle: ReturnType<typeof createSseLifecycle> | null = null;

  function notifyFilesChanged(savedPath?: string) {
    setFileChange((current) => ({ version: current.version + 1, savedPath: savedPath ?? null }));
  }

  function notifyPinnedChanged() {
    setPinnedVersion((version) => version + 1);
  }

  async function handleVaultSwitched() {
    deps?.invalidateNoteCache();
    setVaultVersion((version) => version + 1);
    notifyFilesChanged();
    await deps?.refreshVaultSwitcher();
  }

  function connect() {
    if (!deps || !lifecycle) {
      return;
    }

    const existing = lifecycle.getSse();
    if (existing) {
      existing.close();
      lifecycle.setSse(null);
    }
    const timer = lifecycle.getReconnectTimer();
    if (timer) {
      clearTimeout(timer);
      lifecycle.setReconnectTimer(null);
    }
    if (lifecycle.isPageUnloading()) {
      return;
    }

    const es = new EventSource("/events");
    lifecycle.setSse(es);

    es.addEventListener("connected", () => {
      if (lifecycle?.getSse() !== es) {
        return;
      }
      backoff.reset();
      backoff.wasUnavailable = false;
      uiStore.clearServerStatus();
      void deps?.syncSessionToServer();
    });

    es.addEventListener("changed", async (e) => {
      const path = e.data;
      const currentDeps = deps;
      notifyFilesChanged(path);
      if (!currentDeps || currentDeps.getActivePath() !== path) {
        return;
      }
      try {
        const note = await getNote(path);
        currentDeps.reloadActiveNote(note.content, note.mtime);
      } catch {
        /* ignore reload failures */
      }
    });

    es.addEventListener("deleted", (e) => {
      const path = e.data;
      const currentDeps = deps;
      if (!currentDeps) {
        return;
      }
      currentDeps.invalidateNoteCache();
      notifyFilesChanged();
      if (currentDeps.getActivePath() === path) {
        uiStore.showNotification(`"${stemFromPath(path)}" was deleted externally.`, "info");
        currentDeps.closeActiveTab();
      }
    });

    es.addEventListener("locked", () => {
      if (lifecycle?.getSse() !== es) {
        return;
      }
      es.close();
      lifecycle?.setSse(null);
      deps?.showUnlockScreen();
    });

    es.addEventListener("vault_switched", () => {
      if (lifecycle?.getSse() !== es) {
        return;
      }
      void handleVaultSwitched();
    });

    es.onerror = () => {
      if (lifecycle?.getSse() !== es) {
        return;
      }
      es.close();
      lifecycle?.setSse(null);
      if (lifecycle?.isPageUnloading()) {
        return;
      }
      backoff.wasUnavailable = true;
      const delay = backoff.next();
      uiStore.setServerStatus(`Server unavailable. Retrying in ${backoff.format(delay)}...`);
      lifecycle?.setReconnectTimer(
        setTimeout(() => {
          lifecycle?.setReconnectTimer(null);
          connect();
        }, delay),
      );
    };
  }

  return {
    fileChange,
    pinnedVersion,
    vaultVersion,
    configure(nextDeps: ServerStoreDeps) {
      deps = nextDeps;
      lifecycle = createSseLifecycle({ connectSse: connect });
    },
    start() {
      if (!lifecycle) {
        throw new Error("server store not configured");
      }
      if (!lifecycle.getSse()) {
        connect();
      }
      window.addEventListener("pagehide", lifecycle.closeForUnload);
      window.addEventListener("beforeunload", lifecycle.closeForUnload);
      window.addEventListener("focus", lifecycle.requestImmediateReconnect);
      document.addEventListener("visibilitychange", lifecycle.onVisibilityChange);
    },
    stop() {
      if (!lifecycle) {
        return;
      }
      window.removeEventListener("pagehide", lifecycle.closeForUnload);
      window.removeEventListener("beforeunload", lifecycle.closeForUnload);
      window.removeEventListener("focus", lifecycle.requestImmediateReconnect);
      document.removeEventListener("visibilitychange", lifecycle.onVisibilityChange);
      lifecycle.closeForUnload();
    },
    notifyFilesChanged,
    notifyPinnedChanged,
    handleVaultSwitched,
  };
}

export const serverStore = createServerStore();
