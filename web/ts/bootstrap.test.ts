import type { AppStatus } from "./api.ts";
import { setupDOM } from "./test-helper.ts";

describe("bootstrap", () => {
  let cleanup: () => void;

  beforeEach(() => {
    cleanup = setupDOM();
  });

  afterEach(() => {
    cleanup();
  });

  it("checkBrowserSupport reports only missing features", async () => {
    const { checkBrowserSupport } = await import("./bootstrap.ts");
    expect(
      checkBrowserSupport({ hasIndexedDb: true, hasEventSource: false, hasSetHtml: false }),
    ).toStrictEqual(["Server-Sent Events", "HTML Sanitizer API"]);
  });

  it("showUnsupportedPage renders the unsupported browser message", async () => {
    const { showUnsupportedPage } = await import("./bootstrap.ts");
    showUnsupportedPage(document.body, ["IndexedDB", "HTML Sanitizer API"], "UA/1.0", 139);

    expect(document.body.textContent).toContain("Browser not supported");
    expect(document.body.textContent).toContain("IndexedDB");
    expect(document.body.textContent).toContain("HTML Sanitizer API");
    expect(document.body.textContent).toContain("Firefox 139");
    expect(document.body.textContent).toContain("UA/1.0");
  });

  it("showUnlockScreen unlocks with recovery key success", async () => {
    const { showUnlockScreen } = await import("./bootstrap.ts");
    const appEl = document.querySelector("#app") as HTMLElement;
    let unlocked = false;

    showUnlockScreen({
      appEl,
      isPrfLikelySupported: () => false,
      getPrfKey: async () => "",
      unlockWithPrf: async () => false,
      unlockWithRecoveryKey: async (key) => key === "good-key",
      onUnlocked: () => {
        unlocked = true;
      },
    });

    const input = document.querySelector("#unlock-key") as HTMLInputElement;
    const form = document.querySelector("#unlock-form") as HTMLFormElement;
    input.value = "good-key";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));

    expect(unlocked).toBeTruthy();
    expect(document.querySelector("#unlock-screen")).toBeNull();
    expect(appEl.style.display).toBe("");
  });

  it("showUnlockScreen reports recovery key failure and re-enables the button", async () => {
    const { showUnlockScreen } = await import("./bootstrap.ts");
    const appEl = document.querySelector("#app") as HTMLElement;

    showUnlockScreen({
      appEl,
      isPrfLikelySupported: () => false,
      getPrfKey: async () => "",
      unlockWithPrf: async () => false,
      unlockWithRecoveryKey: async () => false,
      onUnlocked: () => {},
    });

    const input = document.querySelector("#unlock-key") as HTMLInputElement;
    const form = document.querySelector("#unlock-form") as HTMLFormElement;
    const button = form.querySelector('button[type="submit"]') as HTMLButtonElement;
    input.value = "bad-key";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));

    expect((document.querySelector("#unlock-error") as HTMLElement).textContent).toContain(
      "Unlock failed",
    );
    expect(button.disabled).toBeFalsy();
  });

  it("showUnlockScreen auto-triggers biometric unlock when PRF is available", async () => {
    const { showUnlockScreen } = await import("./bootstrap.ts");
    const appEl = document.querySelector("#app") as HTMLElement;
    let prfKeyArg = "";
    let unlocked = false;
    const status = {
      encrypted: true,
      locked: true,
      needs_setup: false,
      prf_credential_names: ["Face ID"],
      prf_credential_ids: ["cred-1"],
    } satisfies AppStatus;

    showUnlockScreen({
      appEl,
      status,
      isPrfLikelySupported: () => true,
      getPrfKey: async (ids) => {
        prfKeyArg = ids.join(",");
        return "prf-key";
      },
      unlockWithPrf: async (key) => key === "prf-key",
      unlockWithRecoveryKey: async () => false,
      onUnlocked: () => {
        unlocked = true;
      },
    });

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(prfKeyArg).toBe("cred-1");
    expect(unlocked).toBeTruthy();
    expect(document.querySelector("#unlock-screen")).toBeNull();
  });

  it("showUnlockScreen reports biometric failure", async () => {
    const { showUnlockScreen } = await import("./bootstrap.ts");
    const appEl = document.querySelector("#app") as HTMLElement;
    const status = {
      encrypted: true,
      locked: true,
      needs_setup: false,
      prf_credential_names: ["Face ID"],
      prf_credential_ids: ["cred-1"],
    } satisfies AppStatus;

    showUnlockScreen({
      appEl,
      status,
      isPrfLikelySupported: () => true,
      getPrfKey: async () => "prf-key",
      unlockWithPrf: async () => false,
      unlockWithRecoveryKey: async () => false,
      onUnlocked: () => {},
    });

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect((document.querySelector("#unlock-error") as HTMLElement).textContent).toContain(
      "Biometric unlock failed",
    );
  });

  it("bootApp starts unlocked vaults and falls back to startApp on status errors", async () => {
    const { bootApp } = await import("./bootstrap.ts");
    const calls: string[] = [];

    await bootApp({
      checkBrowserSupport: () => [],
      showUnsupportedPage: () => calls.push("unsupported"),
      getStatus: async () =>
        ({
          encrypted: false,
          locked: false,
          needs_setup: false,
          prf_credential_names: [],
          prf_credential_ids: [],
        }) satisfies AppStatus,
      showUnlockScreen: () => calls.push("unlock"),
      startApp: () => {
        calls.push("start");
      },
    });

    await bootApp({
      checkBrowserSupport: () => [],
      showUnsupportedPage: () => calls.push("unsupported"),
      getStatus: async () => {
        throw new Error("offline");
      },
      showUnlockScreen: () => calls.push("unlock"),
      startApp: () => {
        calls.push("start-fallback");
      },
    });

    expect(calls).toStrictEqual(["start", "start-fallback"]);
  });

  it("bootApp shows unlock screen for locked vaults and unsupported page when needed", async () => {
    const { bootApp } = await import("./bootstrap.ts");
    const calls: string[] = [];

    await bootApp({
      checkBrowserSupport: () => ["IndexedDB"],
      showUnsupportedPage: (missing) => calls.push(`unsupported:${missing.join(",")}`),
      getStatus: async () => {
        throw new Error("should not be called");
      },
      showUnlockScreen: () => calls.push("unlock"),
      startApp: () => {
        calls.push("start");
      },
    });

    await bootApp({
      checkBrowserSupport: () => [],
      showUnsupportedPage: () => calls.push("unsupported"),
      getStatus: async () =>
        ({
          encrypted: true,
          locked: true,
          needs_setup: false,
          prf_credential_names: [],
          prf_credential_ids: [],
        }) satisfies AppStatus,
      showUnlockScreen: () => calls.push("unlock"),
      startApp: () => {
        calls.push("start");
      },
    });

    expect(calls).toStrictEqual(["unsupported:IndexedDB", "unlock"]);
  });

  it("createBackoff and SSE lifecycle manage reconnect and unload behavior", async () => {
    const { createBackoff, createSseLifecycle } = await import("./bootstrap.ts");
    const backoff = createBackoff([100, 500]);
    expect(backoff.next()).toBe(100);
    expect(backoff.next()).toBe(500);
    expect(backoff.format(500)).toBe("500ms");
    expect(backoff.format(1200)).toBe("1s");
    backoff.wasUnavailable = true;
    expect(backoff.wasUnavailable).toBeTruthy();
    backoff.reset();

    const closed: string[] = [];
    let connects = 0;
    const controller = createSseLifecycle({
      connectSse: () => {
        connects++;
      },
      document,
    });

    // sse non-null → no connect
    controller.setSse({ close: () => closed.push("closed") });
    controller.setReconnectTimer(setTimeout(() => {}, 10_000));
    controller.requestImmediateReconnect();
    expect(connects).toBe(0);

    // sse null, timer pending → clear timer and connect
    controller.setSse(null);
    controller.requestImmediateReconnect();
    expect(connects).toBe(1);
    expect(controller.getReconnectTimer()).toBeNull();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    controller.onVisibilityChange();
    expect(connects).toBe(2);

    controller.setSse({ close: () => closed.push("closed-again") });
    controller.closeForUnload();
    expect(controller.isPageUnloading()).toBeTruthy();
    expect(controller.getSse()).toBeNull();
    expect(closed).toStrictEqual(["closed-again"]);
  });
});
