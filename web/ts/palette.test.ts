import { describe, test, expect, beforeAll, afterAll } from "bun:test";

import { setupDOM } from "./test-helper.ts";

describe("palette", () => {
  let cleanup: () => void;
  let togglePalette: () => void;
  let openPalette: () => void;
  let closePalette: () => void;
  let isPaletteOpen: () => boolean;
  let registerCommands: (
    cmds: Array<{ label: string; shortcut: string; action: () => void }>,
  ) => void;
  let actionCalled = false;

  beforeAll(async () => {
    cleanup = setupDOM();

    const { createPalette } = await import("./palette.ts");
    const p = createPalette();
    togglePalette = p.toggle;
    openPalette = p.open;
    closePalette = p.close;
    isPaletteOpen = p.isOpen;
    registerCommands = p.registerCommands;

    registerCommands([
      {
        label: "Save",
        shortcut: "⌘S",
        action: () => {
          actionCalled = true;
        },
      },
      { label: "Search", shortcut: "⌘K", action: () => {} },
      { label: "New note", shortcut: "⌘T", action: () => {} },
    ]);
  });

  afterAll(() => {
    closePalette();
    cleanup();
  });

  test("palette lifecycle", () => {
    // Initially closed
    expect(isPaletteOpen()).toBe(false);

    // Open
    openPalette();
    expect(isPaletteOpen()).toBe(true);
    const overlay = document.getElementById("palette-overlay")!;
    expect(overlay.classList.contains("hidden")).toBe(false);

    // Items rendered
    const listEl = document.getElementById("palette-list")!;
    expect(listEl.children.length).toBe(3);
    expect(listEl.children[0]!.textContent!.includes("Save")).toBe(true);

    // Toggle closes
    togglePalette();
    expect(isPaletteOpen()).toBe(false);
    expect(overlay.classList.contains("hidden")).toBe(true);

    // Toggle opens again
    togglePalette();
    expect(isPaletteOpen()).toBe(true);

    // Filter via input
    const input = document.getElementById("palette-input")! as HTMLInputElement;
    input.value = "sav";
    input.dispatchEvent(new Event("input"));
    expect(listEl.children.length).toBe(1);
    expect(listEl.children[0]!.textContent!.includes("Save")).toBe(true);

    // Clear filter shows all
    input.value = "";
    input.dispatchEvent(new Event("input"));
    expect(listEl.children.length).toBe(3);

    // Keyboard: Escape closes
    closePalette();
    openPalette();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(isPaletteOpen()).toBe(false);

    // Keyboard: Enter selects
    openPalette();
    input.value = "";
    input.dispatchEvent(new Event("input"));
    actionCalled = false;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(actionCalled).toBe(true);
    expect(isPaletteOpen()).toBe(false);

    // Keyboard: ArrowDown moves selection
    openPalette();
    input.value = "";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(listEl.children[1]!.classList.contains("selected")).toBe(true);

    // ArrowUp wraps
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(listEl.children[0]!.classList.contains("selected")).toBe(true);

    closePalette();
  });
});
