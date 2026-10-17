import type { CommandId } from "./events.ts";

type ShortcutAction = CommandId | "command.open" | "help.open";
type ShortcutModifiers = {
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
};

export type KeyboardShortcut = {
  action: ShortcutAction;
  key: string;
  modifiers: ShortcutModifiers;
  label: string;
  description: string;
};

export const KEYBOARD_SHORTCUTS = [
  { action: "command.open", key: "p", modifiers: { ctrl: true }, label: "Ctrl+P", description: "Open command palette" },
  { action: "command.open", key: "k", modifiers: { ctrl: true }, label: "Ctrl+K", description: "Open command palette" },
  { action: "command.open", key: "k", modifiers: { meta: true }, label: "⌘K", description: "Open command palette" },
  { action: "search", key: "/", modifiers: { ctrl: true }, label: "Ctrl+/", description: "Search notes" },
  { action: "search", key: "f", modifiers: { meta: true, shift: true }, label: "⌘⇧F", description: "Search notes" },
  { action: "find", key: "f", modifiers: { ctrl: true }, label: "Ctrl+F", description: "Find in current note" },
  { action: "find", key: "f", modifiers: { meta: true }, label: "⌘F", description: "Find in current note" },
  { action: "save", key: "s", modifiers: { ctrl: true }, label: "Ctrl+S", description: "Save current note" },
  { action: "save", key: "s", modifiers: { meta: true }, label: "⌘S", description: "Save current note" },
  { action: "create", key: "n", modifiers: { ctrl: true, alt: true }, label: "Ctrl+Alt+N", description: "Open a new note tab" },
  { action: "create", key: "n", modifiers: { ctrl: true }, label: "Ctrl+N", description: "Open a new note tab" },
  { action: "create", key: "t", modifiers: { ctrl: true }, label: "Ctrl+T", description: "Open a new note tab" },
  { action: "create", key: "n", modifiers: { meta: true, alt: true }, label: "⌘⌥N", description: "Open a new note tab" },
  { action: "rename", key: "l", modifiers: { ctrl: true }, label: "Ctrl+L", description: "Rename current note" },
  { action: "close", key: "x", modifiers: { ctrl: true }, label: "Ctrl+X", description: "Close current tab" },
  { action: "delete", key: "Backspace", modifiers: { meta: true }, label: "⌘⌫", description: "Move current note to trash" },
  { action: "reopen", key: "t", modifiers: { meta: true, shift: true }, label: "⌘⇧T", description: "Reopen last closed note" },
  { action: "focus", key: "Enter", modifiers: { meta: true, shift: true }, label: "⌘⇧Enter", description: "Toggle focus mode" },
  { action: "focus", key: "Enter", modifiers: { ctrl: true, shift: true }, label: "Ctrl+Shift+Enter", description: "Toggle focus mode" },
  { action: "help.open", key: "Escape", modifiers: {}, label: "Esc", description: "Open keyboard shortcuts" },
] as const satisfies readonly KeyboardShortcut[];

export function keyboardShortcutFor(event: KeyboardEvent): KeyboardShortcut | undefined {
  return KEYBOARD_SHORTCUTS.find((shortcut) =>
    matchesKeyboardShortcut(event, shortcut)
  );
}

function matchesKeyboardShortcut(event: KeyboardEvent, shortcut: KeyboardShortcut): boolean {
  const modifiers: ShortcutModifiers = shortcut.modifiers;
  return event.key.toLowerCase() === shortcut.key.toLowerCase() &&
    event.ctrlKey === (modifiers.ctrl ?? false) &&
    event.metaKey === (modifiers.meta ?? false) &&
    event.altKey === (modifiers.alt ?? false) &&
    event.shiftKey === (modifiers.shift ?? false);
}

export function shortcutLabels(action: ShortcutAction): string | undefined {
  const labels = KEYBOARD_SHORTCUTS.filter((shortcut) => shortcut.action === action && action !== "help.open")
    .map((shortcut) => shortcut.label);
  return labels.length === 0 ? undefined : labels.join(" / ");
}
