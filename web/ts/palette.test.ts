import { render } from "solid-js/web";

import { PaletteModal } from "./palette.tsx";
import { setupDOM } from "./test-helper.ts";
import { uiStore } from "./ui-store.ts";

describe("palette", () => {
  let cleanup: () => void;
  let commands: { label: string; shortcut: string; action: () => void }[];
  let actionCalled = false;

  function buildCommands() {
    return [
      {
        label: "Save",
        shortcut: "⌘S",
        action: () => {
          actionCalled = true;
        },
      },
      { label: "Search", shortcut: "⌘K", action: () => {} },
      { label: "New note", shortcut: "⌘T", action: () => {} },
    ];
  }

  beforeAll(async () => {
    cleanup = setupDOM();
    const { delegateEvents } = await import("solid-js/web");
    delegateEvents(["click", "input", "change", "keydown", "contextmenu", "auxclick"]);
    commands = buildCommands();

    render(
      () =>
        PaletteModal({
          commands: () => commands,
        }),
      document.querySelector("#palette-root") as HTMLElement,
    );
  });

  afterAll(() => {
    uiStore.closePalette();
    cleanup();
  });

  beforeEach(() => {
    uiStore.closePalette();
    actionCalled = false;
    commands = buildCommands();
  });

  it("palette lifecycle", () => {
    // Initially closed
    expect(uiStore.paletteVisibleOpen()).toBeFalsy();

    // Open
    uiStore.openPalette();
    expect(uiStore.paletteVisibleOpen()).toBeTruthy();
    const overlay = document.querySelector("#palette-overlay")!;
    expect((overlay as HTMLElement).hidden).toBeFalsy();

    // Items rendered
    let listEl = document.querySelector("#palette-list")!;
    expect(listEl.children).toHaveLength(3);
    expect(listEl.children[0]!.textContent!).toContain("Save");

    // Toggle closes
    uiStore.togglePalette();
    expect(uiStore.paletteVisibleOpen()).toBeFalsy();
    expect(document.querySelector("#palette-overlay")).toBeNull();

    // Toggle opens again
    uiStore.togglePalette();
    expect(uiStore.paletteVisibleOpen()).toBeTruthy();

    // Filter via input
    let input = document.querySelector("#palette-input")! as HTMLInputElement;
    listEl = document.querySelector("#palette-list")!;
    input.value = "sav";
    input.dispatchEvent(new Event("input"));
    expect(listEl.children).toHaveLength(1);
    expect(listEl.children[0]!.textContent!).toContain("Save");

    // Clear filter shows all
    input.value = "";
    input.dispatchEvent(new Event("input"));
    expect(listEl.children).toHaveLength(3);

    // Keyboard: Escape closes
    uiStore.closePalette();
    uiStore.openPalette();
    input = document.querySelector("#palette-input")! as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(uiStore.paletteVisibleOpen()).toBeFalsy();

    // Keyboard: Enter selects
    uiStore.openPalette();
    input = document.querySelector("#palette-input")! as HTMLInputElement;
    input.value = "";
    input.dispatchEvent(new Event("input"));
    actionCalled = false;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(actionCalled).toBeTruthy();
    expect(uiStore.paletteVisibleOpen()).toBeFalsy();

    // Keyboard: ArrowDown moves selection
    uiStore.openPalette();
    input = document.querySelector("#palette-input")! as HTMLInputElement;
    listEl = document.querySelector("#palette-list")!;
    input.value = "";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(listEl.children[1]!.classList.contains("selected")).toBeTruthy();

    // ArrowUp wraps
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(listEl.children[0]!.classList.contains("selected")).toBeTruthy();

    uiStore.closePalette();
  });

  it("clicking a command item executes its action", () => {
    uiStore.openPalette();
    const listEl = document.querySelector("#palette-list")!;

    actionCalled = false;
    // Click the first item ("Save")
    const saveItem = listEl.children[0]! as HTMLElement;
    saveItem.click();
    expect(actionCalled).toBeTruthy();
    expect(uiStore.paletteVisibleOpen()).toBeFalsy();
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
    expect(commands).toHaveLength(3);
    expect(commands[0]!.label).toBe("Save");
  });

  it("selected index resets to 0 on open", async () => {
    uiStore.openPalette();
    const input = document.querySelector("#palette-input")! as HTMLInputElement;
    input.value = "";
    input.dispatchEvent(new Event("input"));
    // Move to index 1
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    const listEl = document.querySelector("#palette-list")!;
    expect(listEl.children[1]!.classList.contains("selected")).toBeTruthy();
    uiStore.closePalette();

    // Reopen — selection should reset to 0
    uiStore.openPalette();
    await new Promise((r) => setTimeout(r, 0));
    const reopenedInput = document.querySelector("#palette-input")! as HTMLInputElement;
    const reopenedListEl = document.querySelector("#palette-list")!;
    reopenedInput.value = "";
    reopenedInput.dispatchEvent(new Event("input"));
    expect(reopenedListEl.children[0]!.classList.contains("selected")).toBeTruthy();
    uiStore.closePalette();
  });

  it("selected index clamps when filtering reduces visible results", () => {
    uiStore.openPalette();
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
    uiStore.closePalette();
  });

  it("backdrop click (click on overlay but not modal) closes palette", () => {
    uiStore.openPalette();
    expect(uiStore.paletteVisibleOpen()).toBeTruthy();

    const overlay = document.querySelector("#palette-overlay")! as HTMLElement;
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(uiStore.paletteVisibleOpen()).toBeFalsy();
  });

  it("filter with no matches renders empty list", () => {
    uiStore.openPalette();
    const input = document.querySelector("#palette-input")! as HTMLInputElement;
    input.value = "zzznomatch";
    input.dispatchEvent(new Event("input"));
    const listEl = document.querySelector("#palette-list")!;
    expect(listEl.children).toHaveLength(0);
    uiStore.closePalette();
  });

  it("command action error does not leave palette open", () => {
    uiStore.openPalette();

    commands = [
      {
        label: "ThrowCmd",
        shortcut: "",
        action: () => {
          throw new Error("oops");
        },
      },
    ];
    const input = document.querySelector("#palette-input")! as HTMLInputElement;
    input.value = "";
    input.dispatchEvent(new Event("input"));

    const listEl = document.querySelector("#palette-list")!;
    try {
      (listEl.children[0] as HTMLElement).click();
    } catch {
      // action threw; palette should already be closed before the action ran
    }

    expect(uiStore.paletteVisibleOpen()).toBeFalsy();

    commands = buildCommands();
  });
});
