import { describe, test, expect, beforeAll, afterAll } from "vitest";

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

  test("clicking a command item executes its action", () => {
    openPalette();
    const listEl = document.getElementById("palette-list")!;

    actionCalled = false;
    // Click the first item ("Save")
    const saveItem = listEl.children[0]! as HTMLElement;
    saveItem.click();
    expect(actionCalled).toBe(true);
    expect(isPaletteOpen()).toBe(false);
  });

  test("matchesKey correctly matches keyboard events", async () => {
    const { matchesKey } = await import("./palette.ts");

    // Exact match: meta+key
    expect(
      matchesKey(new KeyboardEvent("keydown", { key: "s", metaKey: true }), {
        key: "s",
        meta: true,
      }),
    ).toBe(true);

    // ctrlKey also counts as meta
    expect(
      matchesKey(new KeyboardEvent("keydown", { key: "s", ctrlKey: true }), {
        key: "s",
        meta: true,
      }),
    ).toBe(true);

    // Missing meta when required
    expect(matchesKey(new KeyboardEvent("keydown", { key: "s" }), { key: "s", meta: true })).toBe(
      false,
    );

    // Extra meta when not required
    expect(
      matchesKey(new KeyboardEvent("keydown", { key: "s", metaKey: true }), { key: "s" }),
    ).toBe(false);

    // Shift matching
    expect(
      matchesKey(new KeyboardEvent("keydown", { key: "P", metaKey: true, shiftKey: true }), {
        key: "P",
        meta: true,
        shift: true,
      }),
    ).toBe(true);

    // Missing shift
    expect(
      matchesKey(new KeyboardEvent("keydown", { key: "P", metaKey: true }), {
        key: "P",
        meta: true,
        shift: true,
      }),
    ).toBe(false);

    // Extra shift when not required
    expect(
      matchesKey(new KeyboardEvent("keydown", { key: "k", metaKey: true, shiftKey: true }), {
        key: "k",
        meta: true,
      }),
    ).toBe(false);

    // Wrong key
    expect(
      matchesKey(new KeyboardEvent("keydown", { key: "x", metaKey: true }), {
        key: "s",
        meta: true,
      }),
    ).toBe(false);

    // Simple key with no modifiers
    expect(matchesKey(new KeyboardEvent("keydown", { key: "Escape" }), { key: "Escape" })).toBe(
      true,
    );
  });
});
