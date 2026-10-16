import { activeTab, type State } from "../state.ts";
import type { CommandItem } from "./events.ts";
import { shortcutLabels } from "./keyboard-shortcuts.ts";

const commandDefinitions: readonly CommandItem[] = [
  { id: "create", label: "New Note" },
  { id: "save", label: "Save Note" },
  { id: "search", label: "Search Notes" },
  { id: "find", label: "Find in Note" },
  { id: "rename", label: "Rename Current Note" },
  { id: "close", label: "Close Current Tab" },
  { id: "delete", label: "Move Note to Trash" },
  { id: "pin", label: "Pin Current Tab" },
  { id: "reopen", label: "Reopen Last Closed Note" },
  { id: "reading", label: "Reading mode" },
  { id: "import", label: "Import HTML" },
  { id: "revisions", label: "Revisions" },
  { id: "settings", label: "Settings" },
  { id: "source", label: "Source mode" },
];

export function commandItems(state: State): CommandItem[] {
  const active = activeTab(state);
  const items = commandDefinitions.map((item) => {
    const label = item.id === "pin" && active?.kind === "saved" && state.pinned.has(active.noteId)
      ? "Unpin Current Tab"
      : item.id === "reading" && state.readingMode ? "Edit mode" : item.label;
    const shortcut = shortcutLabels(item.id);
    return shortcut === undefined ? { ...item, label } : { ...item, label, shortcut };
  });
  const query = state.commandFilter.toLowerCase();
  return items.filter((item) => `${item.id} ${item.label}`.toLowerCase().includes(query));
}
