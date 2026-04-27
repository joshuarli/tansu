import { setupDOM } from "./test-helper.ts";

describe("palette", () => {
  let cleanup: () => void;
  let togglePalette: () => void;
  let openPalette: () => void;
  let closePalette: () => void;
  let isPaletteOpen: () => boolean;
  let registerCommands: (cmds: { label: string; shortcut: string; action: () => void }[]) => void;
  let getCommands: () => { label: string; shortcut: string; action: () => void }[];
  let actionCalled = false;

  beforeAll(async () => {
    cleanup = setupDOM();

    const { createPalette } = await import("./palette.tsx");
    const p = createPalette();
    togglePalette = p.toggle;
    openPalette = p.open;
    closePalette = p.close;
    isPaletteOpen = p.isOpen;
    ({ registerCommands } = p);
    ({ getCommands } = p);

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

  it("palette lifecycle", () => {
    // Initially closed
    expect(isPaletteOpen()).toBeFalsy();

    // Open
    openPalette();
    expect(isPaletteOpen()).toBeTruthy();
    const overlay = document.querySelector("#palette-overlay")!;
    expect(overlay.classList.contains("hidden")).toBeFalsy();

    // Items rendered
    const listEl = document.querySelector("#palette-list")!;
    expect(listEl.children).toHaveLength(3);
    expect(listEl.children[0]!.textContent!).toContain("Save");

    // Toggle closes
    togglePalette();
    expect(isPaletteOpen()).toBeFalsy();
    expect(overlay.classList.contains("hidden")).toBeTruthy();

    // Toggle opens again
    togglePalette();
    expect(isPaletteOpen()).toBeTruthy();

    // Filter via input
    const input = document.querySelector("#palette-input")! as HTMLInputElement;
    input.value = "sav";
    input.dispatchEvent(new Event("input"));
    expect(listEl.children).toHaveLength(1);
    expect(listEl.children[0]!.textContent!).toContain("Save");

    // Clear filter shows all
    input.value = "";
    input.dispatchEvent(new Event("input"));
    expect(listEl.children).toHaveLength(3);

    // Keyboard: Escape closes
    closePalette();
    openPalette();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(isPaletteOpen()).toBeFalsy();

    // Keyboard: Enter selects
    openPalette();
    input.value = "";
    input.dispatchEvent(new Event("input"));
    actionCalled = false;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(actionCalled).toBeTruthy();
    expect(isPaletteOpen()).toBeFalsy();

    // Keyboard: ArrowDown moves selection
    openPalette();
    input.value = "";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(listEl.children[1]!.classList.contains("selected")).toBeTruthy();

    // ArrowUp wraps
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(listEl.children[0]!.classList.contains("selected")).toBeTruthy();

    closePalette();
  });

  it("clicking a command item executes its action", () => {
    openPalette();
    const listEl = document.querySelector("#palette-list")!;

    actionCalled = false;
    // Click the first item ("Save")
    const saveItem = listEl.children[0]! as HTMLElement;
    saveItem.click();
    expect(actionCalled).toBeTruthy();
    expect(isPaletteOpen()).toBeFalsy();
  });

  it("matchesKey correctly matches keyboard events", async () => {
    const { matchesKey } = await import("./palette.tsx");

    // Exact match: meta+key
    expect(
      matchesKey(new KeyboardEvent("keydown", { key: "s", metaKey: true }), {
        key: "s",
        meta: true,
      }),
    ).toBeTruthy();

    // ctrlKey also counts as meta
    expect(
      matchesKey(new KeyboardEvent("keydown", { key: "s", ctrlKey: true }), {
        key: "s",
        meta: true,
      }),
    ).toBeTruthy();

    // Missing meta when required
    expect(
      matchesKey(new KeyboardEvent("keydown", { key: "s" }), { key: "s", meta: true }),
    ).toBeFalsy();

    // Extra meta when not required
    expect(
      matchesKey(new KeyboardEvent("keydown", { key: "s", metaKey: true }), { key: "s" }),
    ).toBeFalsy();

    // Shift matching
    expect(
      matchesKey(new KeyboardEvent("keydown", { key: "P", metaKey: true, shiftKey: true }), {
        key: "P",
        meta: true,
        shift: true,
      }),
    ).toBeTruthy();

    // Missing shift
    expect(
      matchesKey(new KeyboardEvent("keydown", { key: "P", metaKey: true }), {
        key: "P",
        meta: true,
        shift: true,
      }),
    ).toBeFalsy();

    // Extra shift when not required
    expect(
      matchesKey(new KeyboardEvent("keydown", { key: "k", metaKey: true, shiftKey: true }), {
        key: "k",
        meta: true,
      }),
    ).toBeFalsy();

    // Wrong key
    expect(
      matchesKey(new KeyboardEvent("keydown", { key: "x", metaKey: true }), {
        key: "s",
        meta: true,
      }),
    ).toBeFalsy();

    // Simple key with no modifiers
    expect(
      matchesKey(new KeyboardEvent("keydown", { key: "Escape" }), { key: "Escape" }),
    ).toBeTruthy();
  });

  it("getCommands returns registered commands", () => {
    const cmds = getCommands();
    expect(cmds).toHaveLength(3);
    expect(cmds[0]!.label).toBe("Save");
  });

  it("selected index resets to 0 on open", () => {
    openPalette();
    const input = document.querySelector("#palette-input")! as HTMLInputElement;
    input.value = "";
    input.dispatchEvent(new Event("input"));
    // Move to index 1
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    const listEl = document.querySelector("#palette-list")!;
    expect(listEl.children[1]!.classList.contains("selected")).toBeTruthy();
    closePalette();

    // Reopen — selection should reset to 0
    openPalette();
    input.value = "";
    input.dispatchEvent(new Event("input"));
    expect(listEl.children[0]!.classList.contains("selected")).toBeTruthy();
    closePalette();
  });

  it("selected index clamps when filtering reduces visible results", () => {
    openPalette();
    const input = document.querySelector("#palette-input")! as HTMLInputElement;
    input.value = "";
    input.dispatchEvent(new Event("input"));
    const listEl = document.querySelector("#palette-list")!;

    // Move selection to index 2
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(listEl.children[2]!.classList.contains("selected")).toBeTruthy();

    // Filter to one item — selection should reset to 0 because input handler fires
    input.value = "sav";
    input.dispatchEvent(new Event("input"));
    expect(listEl.children).toHaveLength(1);
    expect(listEl.children[0]!.classList.contains("selected")).toBeTruthy();
    closePalette();
  });

  it("backdrop click (click on overlay but not modal) closes palette", () => {
    openPalette();
    expect(isPaletteOpen()).toBeTruthy();

    const overlay = document.querySelector("#palette-overlay")! as HTMLElement;
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(isPaletteOpen()).toBeFalsy();
  });

  it("filter with no matches renders empty list", () => {
    openPalette();
    const input = document.querySelector("#palette-input")! as HTMLInputElement;
    input.value = "zzznomatch";
    input.dispatchEvent(new Event("input"));
    const listEl = document.querySelector("#palette-list")!;
    expect(listEl.children).toHaveLength(0);
    closePalette();
  });

  it("command action error does not leave palette open", () => {
    openPalette();

    registerCommands([{ label: "ThrowCmd", shortcut: "", action: () => { throw new Error("oops"); } }]);
    const input = document.querySelector("#palette-input")! as HTMLInputElement;
    input.value = "";
    input.dispatchEvent(new Event("input"));

    const listEl = document.querySelector("#palette-list")!;
    try {
      (listEl.children[0] as HTMLElement).click();
    } catch {
      // action threw; palette should already be closed before the action ran
    }

    expect(isPaletteOpen()).toBeFalsy();

    registerCommands([
      { label: "Save", shortcut: "⌘S", action: () => { actionCalled = true; } },
      { label: "Search", shortcut: "⌘K", action: () => {} },
      { label: "New note", shortcut: "⌘T", action: () => {} },
    ]);
  });
});
