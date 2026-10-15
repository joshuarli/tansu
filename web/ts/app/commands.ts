import { activeTab, type State } from "../state.ts";
import type { CommandItem } from "./events.ts";

const nativeCommands: readonly CommandItem[] = [
  { id: "create", label: "New Note", shortcut: "⌃N" },
  { id: "save", label: "Save Note", shortcut: "⌘S" },
  { id: "search", label: "Search Notes", shortcut: "/" },
  { id: "open", label: "Recent Notes", shortcut: "⌃O" },
  { id: "find", label: "Find in Note", shortcut: "⌃F" },
  { id: "rename", label: "Rename Current Note", shortcut: "⌃L" },
  { id: "close", label: "Close Current Tab", shortcut: "⌃X" },
  { id: "delete", label: "Move Note to Trash", shortcut: "⌘⌫" },
  { id: "pin", label: "Pin Current Tab", shortcut: "⌃P" },
  { id: "reopen", label: "Reopen Last Closed Note", shortcut: "⌘⇧T" },
];

const tansu2Commands: readonly CommandItem[] = [
  { id: "reading", label: "Reading mode" },
  { id: "import", label: "Import HTML" },
  { id: "revisions", label: "Revisions" },
  { id: "settings", label: "Settings" },
  { id: "source", label: "Source mode" },
];

export function commandItems(state: State): CommandItem[] {
  const active = activeTab(state);
  const items = nativeCommands.map((item) =>
    item.id === "pin" && active?.kind === "saved" && state.pinned.has(active.noteId)
      ? { ...item, label: "Unpin Current Tab" }
      : item
  );
  const query = state.commandFilter.toLowerCase();
  const searchable = query === ""
    ? items
    : [...items, ...tansu2Commands.map((item) =>
      item.id === "reading" && state.readingMode ? { ...item, label: "Edit mode" } : item
    )];
  return searchable.filter((item) => `${item.id} ${item.label}`.toLowerCase().includes(query));
}
