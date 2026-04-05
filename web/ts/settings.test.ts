import { describe, test, expect, beforeAll, afterAll } from "bun:test";

import { setupDOM, mockFetch } from "./test-helper.ts";

describe("settings", () => {
  let cleanup: () => void;
  let mock: ReturnType<typeof mockFetch>;
  let toggleSettings: () => void;
  let openSettings: () => Promise<void>;
  let closeSettings: () => void;
  let isSettingsOpen: () => boolean;

  beforeAll(async () => {
    cleanup = setupDOM();
    mock = mockFetch();

    mock.on("GET", "/api/settings", {
      weight_title: 10,
      weight_headings: 5,
      weight_tags: 2,
      weight_content: 1,
      fuzzy_distance: 1,
      result_limit: 20,
      show_score_breakdown: true,
      excluded_folders: ["archive"],
    });
    mock.on("PUT", "/api/settings", {});

    const { createSettings } = await import("./settings.ts");
    const s = createSettings();
    toggleSettings = s.toggle;
    openSettings = s.open;
    closeSettings = s.close;
    isSettingsOpen = s.isOpen;
  });

  afterAll(() => {
    mock.restore();
    cleanup();
  });

  test("settings lifecycle", async () => {
    // Initially closed
    expect(isSettingsOpen()).toBe(false);

    // Open
    await openSettings();
    expect(isSettingsOpen()).toBe(true);
    const overlay = document.getElementById("settings-overlay")!;
    expect(overlay.classList.contains("hidden")).toBe(false);

    // Panel rendered with form elements
    const panel = document.getElementById("settings-panel")!;
    expect(panel.querySelector("h2") !== null).toBe(true);
    expect(panel.innerHTML).toContain("Title");
    expect(panel.innerHTML).toContain("Fuzzy distance");

    // Slider values populated
    const titleSlider = panel.querySelector('input[data-key="weight_title"]') as HTMLInputElement;
    expect(titleSlider !== null).toBe(true);
    expect(titleSlider.value).toBe("10");

    // Checkbox populated
    const scoreCheckbox = panel.querySelector(
      'input[data-key="show_score_breakdown"]',
    ) as HTMLInputElement;
    expect(scoreCheckbox !== null).toBe(true);
    expect(scoreCheckbox.checked).toBe(true);

    // Excluded folders populated
    const excludedInput = panel.querySelector(
      'input[data-key="excluded_folders"]',
    ) as HTMLInputElement;
    expect(excludedInput !== null).toBe(true);
    expect(excludedInput.value).toBe("archive");

    // Close
    closeSettings();
    expect(isSettingsOpen()).toBe(false);
    expect(overlay.classList.contains("hidden")).toBe(true);

    // Toggle
    toggleSettings();
    // toggleSettings calls openSettings which is async, give it a tick
    await new Promise((r) => setTimeout(r, 10));
    expect(isSettingsOpen()).toBe(true);
    toggleSettings();
    expect(isSettingsOpen()).toBe(false);

    // Overlay click closes
    await openSettings();
    overlay.click();
    expect(isSettingsOpen()).toBe(false);
  });
});
