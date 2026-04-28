import { getStatus, unlockWithPrf, unlockWithRecoveryKey, type AppStatus } from "./api.ts";
import {
  bootApp,
  checkBrowserSupport,
  showUnlockScreen as renderUnlockScreen,
  showUnsupportedPage,
} from "./bootstrap.ts";
import { MIN_SUPPORTED_FIREFOX_VERSION } from "./constants.ts";
import { openStore } from "./local-store.ts";
import { serverStore } from "./server-store.ts";
import { restoreSession } from "./tab-state.ts";
import { isPrfLikelySupported, getPrfKey } from "./webauthn.ts";

type AppBootOptions = {
  appEl: HTMLElement;
  initApp: () => void;
};

export function createAppBootController(opts: Readonly<AppBootOptions>): {
  showUnlockScreen(status?: AppStatus): void;
  boot(): Promise<void>;
} {
  let appInitialized = false;

  async function startApp() {
    if (!appInitialized) {
      opts.initApp();
      appInitialized = true;
    }
    await openStore();
    await restoreSession();
    serverStore.start();
  }

  function showUnlockScreen(status?: AppStatus) {
    renderUnlockScreen({
      appEl: opts.appEl,
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

  return {
    showUnlockScreen,
    async boot() {
      await bootApp({
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
    },
  };
}
