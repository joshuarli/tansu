import { createEffect, createSignal } from "solid-js";
import { render } from "solid-js/web";

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
  const [state, setState] = createSignal<{
    hidden: boolean;
    msg: string;
    type: "error" | "info" | "success";
  }>({
    hidden: true,
    msg: "",
    type: "error",
  });

  const disposeView = render(() => {
    createEffect(() => {
      const current = state();
      notifEl.className = current.hidden ? "notification hidden" : `notification ${current.type}`;
      notifEl.textContent = current.msg;
    });
    return null;
  }, notifEl);

  function hide() {
    if (notifTimer) {
      clearTimeout(notifTimer);
      notifTimer = null;
    }
    setState((current) => ({ ...current, hidden: true }));
  }

  function show(msg: string, type: "error" | "info" | "success" = "error") {
    setState({ hidden: false, msg, type });
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
      disposeView();
    },
  };
}

export function createServerStatusController(serverStatusEl: HTMLElement): {
  show(msg: string): void;
  hide(): void;
} {
  const [state, setState] = createSignal({ hidden: true, msg: "" });
  render(() => {
    createEffect(() => {
      const current = state();
      serverStatusEl.className = current.hidden ? "server-status hidden" : "server-status";
      serverStatusEl.textContent = current.msg;
    });
    return null;
  }, serverStatusEl);

  return {
    show(msg: string) {
      setState({ hidden: false, msg });
    },
    hide() {
      setState({ hidden: true, msg: "" });
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

type UnlockScreenViewProps = {
  hasPrf: boolean;
  credentialIds: string[];
  isPrfLikelySupported: () => boolean;
  getPrfKey: (credentialIds: string[]) => Promise<string>;
  unlockWithPrf: (prfKeyB64: string) => Promise<boolean>;
  unlockWithRecoveryKey: (key: string) => Promise<boolean>;
  onUnlockSuccess: () => void;
};

let disposeUnlockScreen: (() => void) | null = null;

function mountUnlockScreen(
  screen: HTMLElement,
  props: Readonly<UnlockScreenViewProps>,
): () => void {
  screen.textContent = "";

  const titleEl = document.createElement("h1");
  titleEl.textContent = "tansu";
  screen.append(titleEl);

  const descEl = document.createElement("p");
  descEl.textContent = "This vault is locked.";
  screen.append(descEl);

  const form = document.createElement("form");
  form.id = "unlock-form";

  const inputEl = document.createElement("input");
  inputEl.id = "unlock-key";
  inputEl.type = "text";
  inputEl.placeholder = "Recovery key";
  inputEl.autocomplete = "off";
  inputEl.spellcheck = false;

  const submitBtn = document.createElement("button");
  submitBtn.type = "submit";
  submitBtn.textContent = "Unlock with recovery key";

  const errorEl = document.createElement("div");
  errorEl.id = "unlock-error";

  const statusEl = document.createElement("div");
  statusEl.id = "unlock-status";

  let bioBtn: HTMLButtonElement | null = null;
  if (props.hasPrf) {
    bioBtn = document.createElement("button");
    bioBtn.id = "unlock-biometric";
    bioBtn.type = "button";
    bioBtn.textContent = "Unlock with biometrics";
    screen.append(bioBtn);
  }

  form.append(inputEl, submitBtn, errorEl, statusEl);
  screen.append(form);

  async function runBiometricUnlock() {
    errorEl.textContent = "";
    statusEl.textContent = "Waiting for biometrics...";
    try {
      const prfKeyB64 = await props.getPrfKey(props.credentialIds);
      statusEl.textContent = "Unlocking...";
      const ok = await props.unlockWithPrf(prfKeyB64);
      if (ok) {
        props.onUnlockSuccess();
      } else {
        errorEl.textContent = "Biometric unlock failed.";
        statusEl.textContent = "";
      }
    } catch (error) {
      errorEl.textContent = error instanceof Error ? error.message : "Biometric unlock failed.";
      statusEl.textContent = "";
    }
  }

  const onSubmit = (e: Event) => {
    e.preventDefault();
    const key = inputEl.value.trim();
    if (!key) {
      return;
    }

    errorEl.textContent = "";
    statusEl.textContent = "Unlocking...";
    submitBtn.disabled = true;

    void props
      .unlockWithRecoveryKey(key)
      .then((ok) => {
        if (ok) {
          props.onUnlockSuccess();
          return;
        }
        errorEl.textContent = "Unlock failed. Check your recovery key.";
        statusEl.textContent = "";
        submitBtn.disabled = false;
        inputEl.focus();
        inputEl.select();
      })
      .catch(() => {
        errorEl.textContent = "Unlock failed. Check your recovery key.";
        statusEl.textContent = "";
        submitBtn.disabled = false;
        inputEl.focus();
        inputEl.select();
      });
  };

  form.addEventListener("submit", onSubmit);
  const onBiometricClick = () => {
    void runBiometricUnlock();
  };

  bioBtn?.addEventListener("click", onBiometricClick);

  if (props.hasPrf && props.isPrfLikelySupported()) {
    queueMicrotask(() => {
      void runBiometricUnlock();
    });
  } else {
    inputEl.focus();
  }

  return () => {
    form.removeEventListener("submit", onSubmit);
    bioBtn?.removeEventListener("click", onBiometricClick);
  };
}

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

  const hasPrf = (opts.status?.prf_credential_ids.length ?? 0) > 0 && opts.isPrfLikelySupported();

  function onUnlockSuccess() {
    disposeUnlockScreen?.();
    disposeUnlockScreen = null;
    screen.remove();
    opts.appEl.style.display = "";
    opts.onUnlocked();
  }

  disposeUnlockScreen?.();
  disposeUnlockScreen = mountUnlockScreen(screen, {
    hasPrf,
    credentialIds: opts.status?.prf_credential_ids ?? [],
    isPrfLikelySupported: opts.isPrfLikelySupported,
    getPrfKey: opts.getPrfKey,
    unlockWithPrf: opts.unlockWithPrf,
    unlockWithRecoveryKey: opts.unlockWithRecoveryKey,
    onUnlockSuccess,
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

type SseLifecycleOptions = {
  connectSse: () => void;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  document?: Document;
};

export function createSseLifecycle(opts: SseLifecycleOptions): {
  getSse(): Closeable | null;
  setSse(value: Closeable | null): void;
  getReconnectTimer(): ReturnType<typeof setTimeout> | null;
  setReconnectTimer(value: ReturnType<typeof setTimeout> | null): void;
  isPageUnloading(): boolean;
  requestImmediateReconnect(): void;
  closeForUnload(): void;
  onVisibilityChange(): void;
} {
  let sse: Closeable | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pageUnloading = false;
  const clearTimer = opts.clearTimer ?? clearTimeout;
  const doc = opts.document ?? document;

  function requestImmediateReconnect() {
    if (pageUnloading || sse) {
      return;
    }
    if (reconnectTimer) {
      clearTimer(reconnectTimer);
      reconnectTimer = null;
    }
    opts.connectSse();
  }

  function closeForUnload() {
    pageUnloading = true;
    if (reconnectTimer) {
      clearTimer(reconnectTimer);
      reconnectTimer = null;
    }
    if (sse) {
      sse.close();
      sse = null;
    }
  }

  function onVisibilityChange() {
    if (doc.visibilityState === "visible") {
      requestImmediateReconnect();
    }
  }

  return {
    getSse: () => sse,
    setSse: (value) => {
      sse = value;
    },
    getReconnectTimer: () => reconnectTimer,
    setReconnectTimer: (value) => {
      reconnectTimer = value;
    },
    isPageUnloading: () => pageUnloading,
    requestImmediateReconnect,
    closeForUnload,
    onVisibilityChange,
  };
}
