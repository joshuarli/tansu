import { render } from "solid-js/web";

import { App } from "./app.tsx";
import { setupDOM } from "./test-helper.ts";

// Prevent the onMount boot sequence from running side-effectful browser APIs
// (checkBrowserSupport, getStatus, etc.) during this structural render test.
vi.mock("./bootstrap.ts", async () => {
  const mod = await vi.importActual<typeof import("./bootstrap.ts")>("./bootstrap.ts");
  return {
    ...mod,
    bootApp: vi.fn().mockResolvedValue(undefined),
    createNotificationController: vi.fn(() => ({ show: vi.fn(), hide: vi.fn(), dispose: vi.fn() })),
    createServerStatusController: vi.fn(() => ({ show: vi.fn(), hide: vi.fn() })),
    createBackoff: vi.fn(() => ({
      next: vi.fn(() => 1000),
      format: vi.fn(() => "1s"),
      reset: vi.fn(),
      wasUnavailable: false,
    })),
    createSseLifecycle: vi.fn(() => ({
      getSse: vi.fn(() => null),
      setSse: vi.fn(),
      getReconnectTimer: vi.fn(() => null),
      setReconnectTimer: vi.fn(),
      isPageUnloading: vi.fn(() => false),
      requestImmediateReconnect: vi.fn(),
      closeForUnload: vi.fn(),
      onVisibilityChange: vi.fn(),
    })),
  };
});

describe("app shell", () => {
  let cleanup: () => void;

  beforeEach(() => {
    cleanup = setupDOM();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the legacy shell structure under #app", () => {
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) {
      throw new Error("missing #app root");
    }

    root.innerHTML = "";
    const dispose = render(App, root);

    expect(root.querySelector("#sidebar")).toBeTruthy();
    expect(root.querySelector(".app-main")).toBeTruthy();
    expect(root.querySelector(".notification")).toBeTruthy();
    expect(root.querySelector("#tab-bar")).toBeTruthy();
    expect(root.querySelector(".server-status")).toBeTruthy();
    expect(root.querySelector("#editor-area")).toBeTruthy();
    expect(root.querySelector("#search-overlay")).toBeTruthy();
    expect(root.querySelector("#settings-overlay")).toBeTruthy();
    expect(root.querySelector("#input-dialog-overlay")).toBeTruthy();
    expect(root.querySelector("#palette-overlay")).toBeTruthy();
    expect(root.querySelector("#empty-state")?.textContent).toContain("Cmd+K");
    expect(root.querySelectorAll(":scope > div")).toHaveLength(6);

    dispose();
  });
});
