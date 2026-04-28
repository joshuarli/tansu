import { stemFromPath } from "@joshuarli98/md-wysiwyg";
import { createSignal } from "solid-js";

import { getNote } from "./api.ts";
import { createBackoff, createSseLifecycle } from "./bootstrap.ts";
import { SSE_BACKOFF_DELAYS_MS } from "./constants.ts";
import type { ServerConnectionState } from "./features/sync/connection-state.ts";

type FileChange = {
  version: number;
  savedPath: string | null;
};

export type { ServerConnectionState };

type ServerStoreDeps = {
  invalidateNoteCache: () => void;
  getActivePath: () => string | null;
  reloadActiveNote: (content: string, mtime: number) => void;
  closeActiveTab: () => void;
  syncSessionToServer: () => Promise<void>;
  refreshVaultSwitcher: () => Promise<void>;
  showUnlockScreen: () => void;
  clearServerStatus: () => void;
  setServerStatus: (msg: string) => void;
  showNotification: (msg: string, type: "error" | "info" | "success") => void;
};

export function createServerStore() {
  const [fileChange, setFileChange] = createSignal<FileChange>({ version: 0, savedPath: null });
  const [pinnedVersion, setPinnedVersion] = createSignal(0);
  const [vaultVersion, setVaultVersion] = createSignal(0);
  const [connectionState, setConnectionState] = createSignal<ServerConnectionState>({
    type: "unavailable",
  });

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

    setConnectionState({ type: "connecting" });
    const es = new EventSource("/events");
    lifecycle.setSse(es);

    es.addEventListener("connected", () => {
      if (lifecycle?.getSse() !== es) {
        return;
      }
      backoff.reset();
      backoff.wasUnavailable = false;
      setConnectionState({ type: "connected" });
      deps?.clearServerStatus();
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
        currentDeps.showNotification(`"${stemFromPath(path)}" was deleted externally.`, "info");
        currentDeps.closeActiveTab();
      }
    });

    es.addEventListener("locked", () => {
      if (lifecycle?.getSse() !== es) {
        return;
      }
      es.close();
      lifecycle?.setSse(null);
      setConnectionState({ type: "locked" });
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
      const message = `Server unavailable. Retrying in ${backoff.format(delay)}...`;
      setConnectionState({ type: "retrying", delayMs: delay, message });
      deps?.setServerStatus(message);
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
    connectionState,
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
      setConnectionState({ type: "unavailable" });
    },
    notifyFilesChanged,
    notifyPinnedChanged,
    handleVaultSwitched,
  };
}

export const serverStore = createServerStore();
export type ServerStore = ReturnType<typeof createServerStore>;
