import { setupDOM, assertEqual, assert } from "./test-helper.ts";
const cleanup = setupDOM();

const { createPalette } = await import("./palette.ts");
const {
  toggle: togglePalette,
  open: openPalette,
  close: closePalette,
  isOpen: isPaletteOpen,
  registerCommands,
} = createPalette();

// Initially closed
assertEqual(isPaletteOpen(), false, "initially closed");

// Register commands
let actionCalled = false;
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

// Open
openPalette();
assertEqual(isPaletteOpen(), true, "open");
const overlay = document.getElementById("palette-overlay")!;
assert(!overlay.classList.contains("hidden"), "overlay visible");

// Items rendered
const listEl = document.getElementById("palette-list")!;
assertEqual(listEl.children.length, 3, "all commands rendered");
assert(listEl.children[0]!.textContent!.includes("Save"), "first command is Save");

// Toggle closes
togglePalette();
assertEqual(isPaletteOpen(), false, "toggle closes");
assert(overlay.classList.contains("hidden"), "overlay hidden");

// Toggle opens again
togglePalette();
assertEqual(isPaletteOpen(), true, "toggle reopens");

// Filter via input
const input = document.getElementById("palette-input")! as HTMLInputElement;
input.value = "sav";
input.dispatchEvent(new Event("input"));
assertEqual(listEl.children.length, 1, "filtered to 1");
assert(listEl.children[0]!.textContent!.includes("Save"), "filtered shows Save");

// Clear filter shows all
input.value = "";
input.dispatchEvent(new Event("input"));
assertEqual(listEl.children.length, 3, "cleared filter shows all");

// Keyboard: Escape closes
closePalette();
openPalette();
input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
assertEqual(isPaletteOpen(), false, "escape closes");

// Keyboard: Enter selects
openPalette();
input.value = "";
input.dispatchEvent(new Event("input"));
actionCalled = false;
input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
assertEqual(actionCalled, true, "enter triggers action");
assertEqual(isPaletteOpen(), false, "closed after enter");

// Keyboard: ArrowDown moves selection
openPalette();
input.value = "";
input.dispatchEvent(new Event("input"));
input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
assert(listEl.children[1]!.classList.contains("selected"), "arrow down selects second");

// ArrowUp wraps
input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
assert(listEl.children[0]!.classList.contains("selected"), "arrow up wraps back");

closePalette();
cleanup();
console.log("All palette tests passed");
