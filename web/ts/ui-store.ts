import { createSignal } from "solid-js";

import { NOTIFICATION_AUTO_DISMISS_MS } from "./constants.ts";

export type NotificationState = {
  hidden: boolean;
  msg: string;
  type: "error" | "info" | "success";
};

function createUiStore() {
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [searchScopePath, setSearchScopePath] = createSignal<string | null>(null);
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
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

  return {
    searchOpen,
    searchScopePath,
    paletteOpen,
    settingsOpen,
    serverStatus,
    notification,
    openSearch(scopePath?: string) {
      setSearchScopePath(scopePath ?? null);
      setSearchOpen(true);
    },
    closeSearch() {
      setSearchOpen(false);
      setSearchScopePath(null);
    },
    toggleSearch(scopePath?: string) {
      if (searchOpen()) {
        setSearchOpen(false);
        setSearchScopePath(null);
      } else {
        setSearchScopePath(scopePath ?? null);
        setSearchOpen(true);
      }
    },
    openPalette() {
      setPaletteOpen(true);
    },
    closePalette() {
      setPaletteOpen(false);
    },
    togglePalette() {
      setPaletteOpen((open) => !open);
    },
    openSettings() {
      setSettingsOpen(true);
    },
    closeSettings() {
      setSettingsOpen(false);
    },
    toggleSettings() {
      setSettingsOpen((open) => !open);
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
