import { createSignal } from "solid-js";

import { NOTIFICATION_AUTO_DISMISS_MS } from "./constants.ts";
import { createModalManager, modalManager } from "./modal-manager.ts";

export type NotificationState = {
  hidden: boolean;
  msg: string;
  type: "error" | "info" | "success";
};

type ModalManager = ReturnType<typeof createModalManager>;

export function createUiStore(manager: ModalManager = modalManager) {
  const [isSearchRequestedOpen, setSearchRequestedOpen] = createSignal(false);
  const [searchScopePath, setSearchScopePath] = createSignal<string | null>(null);
  const [isPaletteRequestedOpen, setPaletteRequestedOpen] = createSignal(false);
  const [isSettingsRequestedOpen, setSettingsRequestedOpen] = createSignal(false);
  const [serverStatus, setServerStatusSignal] = createSignal("");
  const [notification, setNotification] = createSignal<NotificationState>({
    hidden: true,
    msg: "",
    type: "error",
  });

  let notificationTimer: ReturnType<typeof setTimeout> | null = null;

  function clearNotificationTimer() {
    if (notificationTimer) {
      clearTimeout(notificationTimer);
      notificationTimer = null;
    }
  }

  function hideNotification() {
    clearNotificationTimer();
    setNotification((current) => ({ ...current, hidden: true }));
  }

  function showNotification(
    msg: string,
    type: "error" | "info" | "success" = "error",
    autoDismissMs = NOTIFICATION_AUTO_DISMISS_MS,
  ) {
    clearNotificationTimer();
    setNotification({ hidden: false, msg, type });
    notificationTimer = setTimeout(() => {
      hideNotification();
    }, autoDismissMs);
  }

  function resetSearchModal() {
    setSearchRequestedOpen(false);
    setSearchScopePath(null);
  }

  function resetPaletteModal() {
    setPaletteRequestedOpen(false);
  }

  function resetSettingsModal() {
    setSettingsRequestedOpen(false);
  }

  return {
    searchVisibleOpen: () => isSearchRequestedOpen() && manager.isActive("search"),
    isSearchRequestedOpen,
    searchScopePath,
    paletteVisibleOpen: () => isPaletteRequestedOpen() && manager.isActive("palette"),
    isPaletteRequestedOpen,
    settingsVisibleOpen: () => isSettingsRequestedOpen() && manager.isActive("settings"),
    isSettingsRequestedOpen,
    serverStatus,
    notification,
    openSearch(scopePath?: string) {
      manager.replace("search", resetSearchModal);
      setSearchScopePath(scopePath ?? null);
      setSearchRequestedOpen(true);
    },
    closeSearch() {
      resetSearchModal();
      manager.close("search", { skipDismiss: true });
    },
    toggleSearch(scopePath?: string) {
      if (isSearchRequestedOpen()) {
        resetSearchModal();
        manager.close("search", { skipDismiss: true });
      } else {
        manager.replace("search", resetSearchModal);
        setSearchScopePath(scopePath ?? null);
        setSearchRequestedOpen(true);
      }
    },
    openPalette() {
      manager.replace("palette", resetPaletteModal);
      setPaletteRequestedOpen(true);
    },
    closePalette() {
      resetPaletteModal();
      manager.close("palette", { skipDismiss: true });
    },
    togglePalette() {
      if (isPaletteRequestedOpen()) {
        resetPaletteModal();
        manager.close("palette", { skipDismiss: true });
      } else {
        manager.replace("palette", resetPaletteModal);
        setPaletteRequestedOpen(true);
      }
    },
    openSettings() {
      manager.replace("settings", resetSettingsModal);
      setSettingsRequestedOpen(true);
    },
    closeSettings() {
      resetSettingsModal();
      manager.close("settings", { skipDismiss: true });
    },
    toggleSettings() {
      if (isSettingsRequestedOpen()) {
        resetSettingsModal();
        manager.close("settings", { skipDismiss: true });
      } else {
        manager.replace("settings", resetSettingsModal);
        setSettingsRequestedOpen(true);
      }
    },
    setServerStatus(msg: string) {
      setServerStatusSignal(msg);
    },
    clearServerStatus() {
      setServerStatusSignal("");
    },
    showNotification,
    hideNotification,
  };
}

export const uiStore = createUiStore();
export type UiStore = ReturnType<typeof createUiStore>;
