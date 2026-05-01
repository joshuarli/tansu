import { render } from "solid-js/web";

import type { Settings } from "./api.ts";
import type { AppSettings, VaultSettings } from "./settings.ts";
import { AppSettingsModal, SettingsModal, VaultSettingsModal } from "./settings.tsx";
import { setupDOM, mockFetch } from "./test-helper.ts";
import { uiStore } from "./ui-store.ts";

vi.mock(import("./webauthn.ts"), () => ({
  createPrfCredential: vi.fn(),
  isPrfLikelySupported: vi.fn(() => true),
}));

describe("settings", () => {
  const expectedServerSettingKeys = [
    "weight_title",
    "weight_headings",
    "weight_tags",
    "weight_content",
    "fuzzy_distance",
    "recency_boost",
    "result_limit",
    "show_score_breakdown",
    "excluded_folders",
  ] as const satisfies ReadonlyArray<keyof Settings>;
  const expectedVaultSettingKeys = [
    "undoStackMax",
    "searchMinQueryLength",
    "searchScorePrecision",
    "searchCliDefaultPort",
    "autocompleteMaxResults",
    "autocompleteOffsetPx",
    "tagAutocompleteMaxResults",
    "tagAutocompleteOffsetPx",
    "tagAutocompleteMinWidthPx",
    "autosaveDelayMs",
    "autosaveRetryDelayMs",
    "formatToolbarGapPx",
    "formatToolbarEdgePaddingPx",
    "formatToolbarIconSizePx",
    "formatToolbarStrokeWidth",
    "formatToolbarHeadingLevels",
    "sessionMaxClosedTabs",
    "notificationAutoDismissMs",
  ] as const satisfies ReadonlyArray<keyof VaultSettings>;
  const expectedAppSettingKeys = [
    "imageWebpQuality",
    "imageResizeMinWidthPx",
    "imageResizeWheelScale",
  ] as const satisfies ReadonlyArray<keyof AppSettings>;
  let cleanup: () => void;
  let mock: ReturnType<typeof mockFetch>;
  let disposeDialogHost: (() => void) | null = null;

  function setInputValue(el: HTMLInputElement, value: string) {
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function setCheckboxValue(el: HTMLInputElement, checked: boolean) {
    el.checked = checked;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setSelectValue(el: HTMLSelectElement, value: string) {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function openSettings() {
    uiStore.closeSettings();
    await new Promise((r) => setTimeout(r, 0));
    uiStore.openSettings();
    await new Promise((r) => setTimeout(r, 30));
  }

  function closeSettings() {
    uiStore.closeSettings();
  }

  async function openAppSettings() {
    uiStore.closeAppSettings();
    await new Promise((r) => setTimeout(r, 0));
    uiStore.openAppSettings();
    await new Promise((r) => setTimeout(r, 30));
  }

  function closeAppSettings() {
    uiStore.closeAppSettings();
  }

  async function openVaultSettings() {
    uiStore.closeVaultSettings();
    await new Promise((r) => setTimeout(r, 0));
    uiStore.openVaultSettings();
    await new Promise((r) => setTimeout(r, 30));
  }

  function closeVaultSettings() {
    uiStore.closeVaultSettings();
  }

  function isSettingsOpen() {
    return uiStore.settingsVisibleOpen();
  }

  function getRenderedKeys(
    scope: "server-setting" | "vault-setting" | "app-setting",
    root = "#settings-panel",
  ): string[] {
    return Array.from(
      document.querySelectorAll<HTMLElement>(`${root} [data-scope="${scope}"][data-key]`),
    )
      .map((el) => el.dataset["key"] ?? "")
      .filter((key) => key.length > 0)
      .sort();
  }

  beforeEach(() => {
    uiStore.closeSettings();
    uiStore.closeAppSettings();
    uiStore.closeVaultSettings();
    uiStore.hideNotification();
  });

  beforeAll(async () => {
    cleanup = setupDOM();
    const { delegateEvents } = await import("solid-js/web");
    delegateEvents(["click", "input", "change", "keydown", "contextmenu", "auxclick"]);
    mock = mockFetch();

    mock.on("GET", "/api/settings", {
      weight_title: 10,
      weight_headings: 5,
      weight_tags: 2,
      weight_content: 1,
      fuzzy_distance: 1,
      recency_boost: 2,
      result_limit: 20,
      show_score_breakdown: true,
      excluded_folders: ["archive"],
    });
    mock.on("PUT", "/api/settings", {});

    const dialogMod = await import("./input-dialog.tsx");
    disposeDialogHost = render(
      () => dialogMod.InputDialogHost(),
      document.querySelector("#app") as HTMLElement,
    );
    render(() => SettingsModal(), document.querySelector("#settings-root") as HTMLElement);
    render(() => AppSettingsModal(), document.querySelector("#settings-root") as HTMLElement);
    render(() => VaultSettingsModal(), document.querySelector("#settings-root") as HTMLElement);
  });

  afterAll(() => {
    disposeDialogHost?.();
    mock.restore();
    cleanup();
  });

  it("save() collects form values and calls saveSettings", async () => {
    uiStore.openSettings();
    await new Promise((r) => setTimeout(r, 20));
    const panel = document.querySelector("#settings-panel")!;

    // Modify some form values
    const titleSlider = panel.querySelector('input[data-key="weight_title"]') as HTMLInputElement;
    setInputValue(titleSlider, "8");
    const scoreCheckbox = panel.querySelector(
      'input[data-key="show_score_breakdown"]',
    ) as HTMLInputElement;
    setCheckboxValue(scoreCheckbox, false);
    const excludedInput = panel.querySelector(
      'input[data-key="excluded_folders"]',
    ) as HTMLInputElement;
    setInputValue(excludedInput, "archive, drafts");

    // Click save
    const saveBtn = panel.querySelector("#settings-save") as HTMLButtonElement;
    saveBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    // Settings should be closed after successful save
    expect(uiStore.settingsVisibleOpen()).toBeFalsy();
  });

  it("renders every server setting from the typed registry", async () => {
    await openSettings();
    expect(getRenderedKeys("server-setting")).toStrictEqual([...expectedServerSettingKeys].sort());
    closeSettings();
  });

  it("renders every vault setting from the typed registry", async () => {
    await openVaultSettings();
    expect(getRenderedKeys("vault-setting", "#vault-settings-panel")).toStrictEqual(
      [...expectedVaultSettingKeys].sort(),
    );
    closeVaultSettings();
  });

  it("renders every app setting from the typed registry", async () => {
    await openAppSettings();
    expect(getRenderedKeys("app-setting", "#app-settings-panel")).toStrictEqual(
      [...expectedAppSettingKeys].sort(),
    );
    closeAppSettings();
  });

  it("save sends the exact settings payload", async () => {
    mock.on("GET", "/api/settings", {
      weight_title: 10,
      weight_headings: 5,
      weight_tags: 2,
      weight_content: 1,
      fuzzy_distance: 1,
      recency_boost: 2,
      result_limit: 20,
      show_score_breakdown: true,
      excluded_folders: ["archive"],
    });
    mock.on("PUT", "/api/settings", {});

    uiStore.openSettings();
    await new Promise((r) => setTimeout(r, 20));
    mock.clearRequests();
    const panel = document.querySelector("#settings-panel")!;

    setInputValue(panel.querySelector('input[data-key="weight_title"]') as HTMLInputElement, "8");
    setInputValue(
      panel.querySelector('input[data-key="weight_headings"]') as HTMLInputElement,
      "4",
    );
    setInputValue(panel.querySelector('input[data-key="weight_tags"]') as HTMLInputElement, "3");
    setInputValue(panel.querySelector('input[data-key="weight_content"]') as HTMLInputElement, "2");
    setSelectValue(
      panel.querySelector('select[data-key="fuzzy_distance"]') as HTMLSelectElement,
      "2",
    );
    setSelectValue(
      panel.querySelector('select[data-key="recency_boost"]') as HTMLSelectElement,
      "3",
    );
    setInputValue(panel.querySelector('input[data-key="result_limit"]') as HTMLInputElement, "37");
    setCheckboxValue(
      panel.querySelector('input[data-key="show_score_breakdown"]') as HTMLInputElement,
      false,
    );
    setInputValue(
      panel.querySelector('input[data-key="excluded_folders"]') as HTMLInputElement,
      "archive, drafts, , private ",
    );

    (panel.querySelector("#settings-save") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 20));

    const put = mock.requests.find((req) => req.method === "PUT" && req.url === "/api/settings");
    expect(put?.body).toBeTruthy();
    const payload = JSON.parse(put!.body!) as Settings;
    expect(payload).toStrictEqual({
      weight_title: 8,
      weight_headings: 4,
      weight_tags: 3,
      weight_content: 2,
      fuzzy_distance: 2,
      recency_boost: 3,
      result_limit: 37,
      show_score_breakdown: false,
      excluded_folders: ["archive", "drafts", "private"],
    });
    expect(uiStore.settingsVisibleOpen()).toBeFalsy();
  });

  it("cancel closes without saving", async () => {
    uiStore.openSettings();
    await new Promise((r) => setTimeout(r, 20));
    mock.clearRequests();
    const panel = document.querySelector("#settings-panel")!;
    setInputValue(panel.querySelector('input[data-key="weight_title"]') as HTMLInputElement, "1");

    (panel.querySelector("#settings-cancel") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 10));

    expect(uiStore.settingsVisibleOpen()).toBeFalsy();
    expect(
      mock.requests.some((req) => req.method === "PUT" && req.url === "/api/settings"),
    ).toBeFalsy();
  });

  it("security section renders when encrypted", async () => {
    // Register status mock for encrypted vault with PRF credentials
    mock.on("GET", "/api/status", {
      encrypted: true,
      locked: false,
      needs_setup: false,
      prf_credential_names: ["Face ID"],
      prf_credential_ids: ["abc123"],
    });

    uiStore.openSettings();
    await new Promise((r) => setTimeout(r, 20));
    const panel = document.querySelector("#settings-panel")!;

    // Security section should be rendered
    expect(panel.innerHTML).toContain("Security");
    expect(panel.innerHTML).toContain("Face ID");
    expect(panel.innerHTML).toContain("Lock now");
    expect(panel.querySelector(".prf-remove") !== null).toBeTruthy();
    closeSettings();
  });

  it("lock button calls lockApp and closes", async () => {
    mock.on("GET", "/api/status", {
      encrypted: true,
      locked: false,
      needs_setup: false,
      prf_credential_names: [],
      prf_credential_ids: [],
    });
    mock.on("GET", "/api/lock", {});

    await openSettings();
    const panel = document.querySelector("#settings-panel")!;
    const lockBtn = panel.querySelector("#lock-now") as HTMLButtonElement;
    expect(lockBtn !== null).toBeTruthy();
    lockBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    // Lock should close the panel
    expect(isSettingsOpen()).toBeFalsy();
  });

  it("settings error fallback renders defaults", async () => {
    // Mock getSettings to return 500
    mock.on("GET", "/api/settings", { error: "fail" }, 500);
    mock.on("GET", "/api/status", { error: "fail" }, 500);

    await openSettings();
    const panel = document.querySelector("#settings-panel")!;

    // Should still render with defaults
    expect(panel.querySelector("h2") !== null).toBeTruthy();
    expect(panel.innerHTML).toContain("Title");

    // Default values: weight_title=10, fuzzy_distance=1, result_limit=20
    const titleSlider = panel.querySelector('input[data-key="weight_title"]') as HTMLInputElement;
    expect(titleSlider.value).toBe("10");
    const resultLimit = panel.querySelector('input[data-key="result_limit"]') as HTMLInputElement;
    expect(resultLimit.value).toBe("20");

    closeSettings();

    // Restore working mocks for subsequent tests
    mock.on("GET", "/api/settings", {
      weight_title: 10,
      weight_headings: 5,
      weight_tags: 2,
      weight_content: 1,
      fuzzy_distance: 1,
      recency_boost: 2,
      result_limit: 20,
      show_score_breakdown: true,
      excluded_folders: ["archive"],
    });
  });

  it("slider input event updates displayed value", async () => {
    await openSettings();
    const panel = document.querySelector("#settings-panel")!;
    const slider = panel.querySelector<HTMLInputElement>(
      'input[type="range"][data-key="weight_title"]',
    )!;
    const valueSpan = slider.nextElementSibling as HTMLSpanElement;

    slider.value = "15";
    slider.dispatchEvent(new Event("input", { bubbles: true }));

    expect(valueSpan.textContent).toBe("15");
    closeSettings();
  });

  it("excluded folders Enter key triggers save", async () => {
    await openSettings();
    const panel = document.querySelector("#settings-panel")!;
    const foldersInput = panel.querySelector<HTMLInputElement>(
      'input[data-key="excluded_folders"]',
    )!;
    setInputValue(foldersInput, "archive, private");

    mock.on("PUT", "/api/settings", {});
    foldersInput.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await new Promise((r) => setTimeout(r, 20));

    // Successful save closes the panel
    expect(isSettingsOpen()).toBeFalsy();
  });

  it("save error is handled gracefully (panel stays open)", async () => {
    await openSettings();
    mock.on("PUT", "/api/settings", { error: "server error" }, 500);

    const panel = document.querySelector("#settings-panel")!;
    const saveBtn = panel.querySelector("#settings-save") as HTMLButtonElement;
    saveBtn.click();
    await new Promise((r) => setTimeout(r, 20));

    // Panel stays open on save error
    expect(isSettingsOpen()).toBeTruthy();
    expect(uiStore.notification().type).toBe("error");
    expect(uiStore.notification().msg).toContain("Failed to save settings");
    expect(uiStore.notification().msg).toContain("500");
    closeSettings();

    // Restore working mock
    mock.on("PUT", "/api/settings", {});
  });

  it("status failure hides the security section", async () => {
    mock.on("GET", "/api/settings", {
      weight_title: 10,
      weight_headings: 5,
      weight_tags: 2,
      weight_content: 1,
      fuzzy_distance: 1,
      recency_boost: 2,
      result_limit: 20,
      show_score_breakdown: true,
      excluded_folders: [],
    });
    mock.on("GET", "/api/status", { error: "fail" }, 500);

    await openSettings();
    const panel = document.querySelector("#settings-panel")!;

    // Settings form should still render
    expect(panel.querySelector("h2")).not.toBeNull();
    // Security section should be absent because status failed (status() = null)
    expect(panel.innerHTML).not.toContain("Security");

    closeSettings();

    // Restore working mocks
    mock.on("GET", "/api/settings", {
      weight_title: 10,
      weight_headings: 5,
      weight_tags: 2,
      weight_content: 1,
      fuzzy_distance: 1,
      recency_boost: 2,
      result_limit: 20,
      show_score_breakdown: true,
      excluded_folders: ["archive"],
    });
  });

  it("PRF remove action removes the credential and refreshes status", async () => {
    mock.on("GET", "/api/status", {
      encrypted: true,
      locked: false,
      needs_setup: false,
      prf_credential_names: ["Touch ID"],
      prf_credential_ids: ["cred-abc"],
    });
    mock.on("POST", "/api/prf/remove", {});

    await openSettings();
    const panel = document.querySelector("#settings-panel")!;

    expect(panel.innerHTML).toContain("Touch ID");

    // Add the post-removal status AFTER the panel has already opened with credentials
    mock.on("GET", "/api/status", {
      encrypted: true,
      locked: false,
      needs_setup: false,
      prf_credential_names: [],
      prf_credential_ids: [],
    });

    const removeBtn = panel.querySelector(".prf-remove") as HTMLButtonElement;
    expect(removeBtn).not.toBeNull();
    removeBtn.click();
    await new Promise((r) => setTimeout(r, 80));

    // Credential should no longer appear after status refresh
    expect(panel.innerHTML).not.toContain("Touch ID");

    closeSettings();
    mock.on("GET", "/api/status", { error: "fail" }, 500);
  });

  it("PRF register success adds the credential to the panel", async () => {
    const webauthn = await import("./webauthn.ts");
    vi.mocked(webauthn.createPrfCredential).mockResolvedValueOnce({
      credentialId: "new-cred-id",
      prfKeyB64: "base64key==",
    });

    mock.on("GET", "/api/status", {
      encrypted: true,
      locked: false,
      needs_setup: false,
      prf_credential_names: [],
      prf_credential_ids: [],
    });
    mock.on("POST", "/api/prf/register", {});

    await openSettings();
    const panel = document.querySelector("#settings-panel")!;

    // Add updated status AFTER panel opens so it wins on the post-registration refresh
    mock.on("GET", "/api/status", {
      encrypted: true,
      locked: false,
      needs_setup: false,
      prf_credential_names: ["New Key"],
      prf_credential_ids: ["new-cred-id"],
    });

    const addBtn = panel.querySelector("#prf-add") as HTMLButtonElement | null;
    expect(addBtn).not.toBeNull();

    addBtn!.click();
    // Wait for createPrfCredential to resolve and showInputDialog to open
    await new Promise((r) => setTimeout(r, 20));

    const settingsOverlay = document.querySelector("#settings-overlay") as HTMLElement;
    expect(settingsOverlay.hidden).toBeTruthy();

    // Name the credential via input dialog
    const dialogInput = document.querySelector("#input-dialog-input") as HTMLInputElement | null;
    expect(dialogInput).not.toBeNull();
    dialogInput!.value = "New Key";
    dialogInput!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );

    // Wait for registration and status refresh
    await new Promise((r) => setTimeout(r, 80));

    expect(settingsOverlay.hidden).toBeFalsy();
    expect(panel.innerHTML).toContain("New Key");

    closeSettings();
    mock.on("GET", "/api/status", { error: "fail" }, 500);
  });

  it("PRF register failure shows an error message", async () => {
    const webauthn = await import("./webauthn.ts");
    vi.mocked(webauthn.createPrfCredential).mockRejectedValueOnce(
      new Error("User cancelled biometric"),
    );

    mock.on("GET", "/api/status", {
      encrypted: true,
      locked: false,
      needs_setup: false,
      prf_credential_names: [],
      prf_credential_ids: [],
    });

    await openSettings();
    const panel = document.querySelector("#settings-panel")!;

    const addBtn = panel.querySelector("#prf-add") as HTMLButtonElement | null;
    expect(addBtn).not.toBeNull();

    addBtn!.click();
    await new Promise((r) => setTimeout(r, 50));

    const statusEl = panel.querySelector("#security-status");
    expect(statusEl).not.toBeNull();
    expect(statusEl!.textContent).toContain("User cancelled biometric");

    closeSettings();
    mock.on("GET", "/api/status", { error: "fail" }, 500);
  });

  it("settings lifecycle", async () => {
    // Initially closed
    expect(isSettingsOpen()).toBeFalsy();

    // Open
    await openSettings();
    expect(isSettingsOpen()).toBeTruthy();
    const overlay = document.querySelector("#settings-overlay") as HTMLElement;
    expect(overlay.hidden).toBeFalsy();

    // Panel rendered with form elements
    const panel = document.querySelector("#settings-panel")!;
    expect(panel.querySelector("h2") !== null).toBeTruthy();
    expect(panel.innerHTML).toContain("Title");
    expect(panel.innerHTML).toContain("Fuzzy distance");

    // Slider values populated
    const titleSlider = panel.querySelector('input[data-key="weight_title"]') as HTMLInputElement;
    expect(titleSlider !== null).toBeTruthy();
    expect(titleSlider.value).toBe("10");

    // Checkbox populated
    const scoreCheckbox = panel.querySelector(
      'input[data-key="show_score_breakdown"]',
    ) as HTMLInputElement;
    expect(scoreCheckbox !== null).toBeTruthy();
    expect(scoreCheckbox.checked).toBeTruthy();

    // Excluded folders populated
    const excludedInput = panel.querySelector(
      'input[data-key="excluded_folders"]',
    ) as HTMLInputElement;
    expect(excludedInput !== null).toBeTruthy();
    expect(excludedInput.value).toBe("archive");

    // Close
    closeSettings();
    expect(isSettingsOpen()).toBeFalsy();
    expect(document.querySelector("#settings-overlay")).toBeNull();

    // Toggle
    uiStore.toggleSettings();
    await new Promise((r) => setTimeout(r, 10));
    expect(isSettingsOpen()).toBeTruthy();
    uiStore.toggleSettings();
    expect(isSettingsOpen()).toBeFalsy();

    // Overlay click closes
    await openSettings();
    const reopenedOverlay = document.querySelector("#settings-overlay") as HTMLElement;
    reopenedOverlay.click();
    expect(isSettingsOpen()).toBeFalsy();
  });
});
