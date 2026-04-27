import type { AppStatus } from "./api.ts";

export type BrowserSupportProbe = {
  hasIndexedDb: boolean;
  hasEventSource: boolean;
  hasSetHtml: boolean;
};

function getDefaultBrowserSupportProbe(): BrowserSupportProbe {
  return {
    hasIndexedDb: "indexedDB" in window,
    hasEventSource: "EventSource" in window,
    hasSetHtml: "setHTML" in Element.prototype,
  };
}

export function checkBrowserSupport(
  probe: BrowserSupportProbe = getDefaultBrowserSupportProbe(),
): string[] {
  const missing: string[] = [];
  if (!probe.hasIndexedDb) {
    missing.push("IndexedDB");
  }
  if (!probe.hasEventSource) {
    missing.push("Server-Sent Events");
  }
  if (!probe.hasSetHtml) {
    missing.push("HTML Sanitizer API");
  }
  return missing;
}

export function showUnsupportedPage(
  body: HTMLElement,
  missing: readonly string[],
  userAgent: string,
  minSupportedFirefoxVersion: number,
): void {
  body.innerHTML = `<div style="font-family:sans-serif;max-width:560px;margin:80px auto;padding:0 24px;line-height:1.6">
    <h2 style="margin-top:0">Browser not supported</h2>
    <p>tansu requires features your browser doesn't support:</p>
    <ul>${missing.map((f) => `<li>${f}</li>`).join("")}</ul>
    <p>Please upgrade to <strong>Firefox ${minSupportedFirefoxVersion}</strong> or later.</p>
    <p style="color:#888;font-size:0.85em;word-break:break-all">Your browser: ${userAgent}</p>
  </div>`;
}

export function createNotificationController(
  notifEl: HTMLElement,
  autoDismissMs: number,
): {
  show(msg: string, type?: "error" | "info" | "success"): void;
  hide(): void;
  dispose(): void;
} {
  let notifTimer: ReturnType<typeof setTimeout> | null = null;

  function hide() {
    if (notifTimer) {
      clearTimeout(notifTimer);
      notifTimer = null;
    }
    notifEl.className = "notification hidden";
  }

  function show(msg: string, type: "error" | "info" | "success" = "error") {
    notifEl.textContent = msg;
    notifEl.className = `notification ${type}`;
    if (notifTimer) {
      clearTimeout(notifTimer);
    }
    notifTimer = setTimeout(() => {
      hide();
    }, autoDismissMs);
  }

  notifEl.addEventListener("click", hide);

  return {
    show,
    hide,
    dispose() {
      hide();
      notifEl.removeEventListener("click", hide);
    },
  };
}

export function createServerStatusController(serverStatusEl: HTMLElement): {
  show(msg: string): void;
  hide(): void;
} {
  return {
    show(msg: string) {
      serverStatusEl.textContent = msg;
      serverStatusEl.className = "server-status";
    },
    hide() {
      serverStatusEl.textContent = "";
      serverStatusEl.className = "server-status hidden";
    },
  };
}

export function createBackoff(delays: readonly number[]) {
  let attempt = 0;
  let unavailable = false;
  return {
    next(): number {
      const delay = delays[Math.min(attempt, delays.length - 1)]!;
      attempt++;
      return delay;
    },
    format(delay: number): string {
      return delay < 1000 ? `${delay}ms` : `${Math.round(delay / 1000)}s`;
    },
    reset() {
      attempt = 0;
    },
    get wasUnavailable() {
      return unavailable;
    },
    set wasUnavailable(v: boolean) {
      unavailable = v;
    },
  };
}

type UnlockScreenOptions = {
  appEl: HTMLElement;
  status?: AppStatus;
  document?: Document;
  isPrfLikelySupported: () => boolean;
  getPrfKey: (credentialIds: string[]) => Promise<string>;
  unlockWithPrf: (prfKeyB64: string) => Promise<boolean>;
  unlockWithRecoveryKey: (key: string) => Promise<boolean>;
  onUnlocked: () => void;
};

export function showUnlockScreen(opts: UnlockScreenOptions): HTMLElement {
  const doc = opts.document ?? document;
  opts.appEl.style.display = "none";

  const existingScreen = doc.querySelector("#unlock-screen");
  let screen: HTMLElement;
  if (existingScreen instanceof HTMLElement) {
    screen = existingScreen;
  } else {
    screen = doc.createElement("div");
    screen.id = "unlock-screen";
    doc.body.append(screen);
  }

  const hasPrf =
    Boolean(opts.status) &&
    opts.status.prf_credential_ids.length > 0 &&
    opts.isPrfLikelySupported();

  screen.innerHTML = `
    <h1>tansu</h1>
    <p>This vault is locked.</p>
    ${hasPrf ? '<button id="unlock-biometric" type="button">Unlock with biometrics</button>' : ""}
    <form id="unlock-form">
      <input id="unlock-key" type="text" placeholder="Recovery key" autocomplete="off" spellcheck="false" />
      <button type="submit">Unlock with recovery key</button>
      <div id="unlock-error"></div>
      <div id="unlock-status"></div>
    </form>
  `;

  const form = screen.querySelector("#unlock-form") as HTMLFormElement;
  const input = screen.querySelector("#unlock-key") as HTMLInputElement;
  const errorEl = screen.querySelector("#unlock-error") as HTMLElement;
  const statusEl = screen.querySelector("#unlock-status") as HTMLElement;

  function onUnlockSuccess() {
    statusEl.textContent = "Unlocked. Loading...";
    screen.remove();
    opts.appEl.style.display = "";
    opts.onUnlocked();
  }

  if (hasPrf && opts.status) {
    const bioBtn = screen.querySelector("#unlock-biometric") as HTMLButtonElement | null;
    if (bioBtn) {
      bioBtn.addEventListener("click", async () => {
        errorEl.textContent = "";
        statusEl.textContent = "Waiting for biometrics...";
        try {
          const prfKeyB64 = await opts.getPrfKey(opts.status!.prf_credential_ids);
          statusEl.textContent = "Unlocking...";
          const ok = await opts.unlockWithPrf(prfKeyB64);
          if (ok) {
            onUnlockSuccess();
          } else {
            errorEl.textContent = "Biometric unlock failed.";
            statusEl.textContent = "";
          }
        } catch (error) {
          errorEl.textContent = error instanceof Error ? error.message : "Biometric unlock failed.";
          statusEl.textContent = "";
        }
      });
      bioBtn.click();
    }
  } else {
    input.focus();
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const key = input.value.trim();
    if (!key) {
      return;
    }

    errorEl.textContent = "";
    statusEl.textContent = "Unlocking...";
    const btn = form.querySelector("button[type=submit]") as HTMLButtonElement;
    btn.disabled = true;

    try {
      const ok = await opts.unlockWithRecoveryKey(key);
      if (ok) {
        onUnlockSuccess();
        return;
      }
    } catch {
      // Network error or server crash
    }
    errorEl.textContent = "Unlock failed. Check your recovery key.";
    statusEl.textContent = "";
    btn.disabled = false;
    input.focus();
    input.select();
  });

  return screen;
}

type BootAppOptions = {
  checkBrowserSupport: () => string[];
  showUnsupportedPage: (missing: string[]) => void;
  getStatus: () => Promise<AppStatus>;
  showUnlockScreen: (status?: AppStatus) => void;
  startApp: () => void | Promise<void>;
};

export async function bootApp(opts: BootAppOptions): Promise<void> {
  const missingFeatures = opts.checkBrowserSupport();
  if (missingFeatures.length > 0) {
    opts.showUnsupportedPage(missingFeatures);
    return;
  }

  try {
    const status = await opts.getStatus();
    if (status.locked) {
      opts.showUnlockScreen(status);
    } else {
      await opts.startApp();
    }
  } catch {
    await opts.startApp();
  }
}

type Closeable = { close(): void };

type SseLifecycleOptions<T extends Closeable> = {
  getSse: () => T | null;
  setSse: (value: T | null) => void;
  getReconnectTimer: () => ReturnType<typeof setTimeout> | null;
  setReconnectTimer: (value: ReturnType<typeof setTimeout> | null) => void;
  getPageUnloading: () => boolean;
  setPageUnloading: (value: boolean) => void;
  connectSse: () => void;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  document?: Document;
};

export function createSseLifecycle<T extends Closeable>(
  opts: SseLifecycleOptions<T>,
): {
  requestImmediateReconnect(): void;
  closeForUnload(): void;
  onVisibilityChange(): void;
} {
  const clearTimer = opts.clearTimer ?? clearTimeout;
  const doc = opts.document ?? document;

  function requestImmediateReconnect() {
    if (opts.getPageUnloading() || opts.getSse()) {
      return;
    }
    const timer = opts.getReconnectTimer();
    if (timer) {
      clearTimer(timer);
      opts.setReconnectTimer(null);
    }
    opts.connectSse();
  }

  function closeForUnload() {
    opts.setPageUnloading(true);
    const timer = opts.getReconnectTimer();
    if (timer) {
      clearTimer(timer);
      opts.setReconnectTimer(null);
    }
    const sse = opts.getSse();
    if (sse) {
      sse.close();
      opts.setSse(null);
    }
  }

  function onVisibilityChange() {
    if (doc.visibilityState === "visible") {
      requestImmediateReconnect();
    }
  }

  return { requestImmediateReconnect, closeForUnload, onVisibilityChange };
}
