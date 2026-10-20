import { activeTab, type State } from "../state.ts";
import type { V2NoteMeta, V2SearchHit } from "../types.generated.ts";
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
  { id: "focus", label: "Focus mode" },
  { id: "revisions", label: "Revisions" },
  { id: "restore", label: "Restore Version" },
  { id: "settings", label: "Settings" },
  { id: "source", label: "Source mode" },
];

export type PaletteMode = "notes" | "actions";

export type PaletteQuery = { mode: PaletteMode; text: string };

export type PaletteEntry =
  | { kind: "hit"; hit: V2SearchHit }
  | { kind: "note"; note: V2NoteMeta }
  | { kind: "command"; command: CommandItem };

const ACTIONS_PREFIX = ">";
const RECENT_NOTE_LIMIT = 8;
const LOCAL_MATCH_LIMIT = 20;

export function parsePaletteQuery(raw: string): PaletteQuery {
  if (raw.startsWith(ACTIONS_PREFIX)) return { mode: "actions", text: raw.slice(1).trimStart() };
  return { mode: "notes", text: raw };
}

export function paletteRawQuery(mode: PaletteMode, text: string): string {
  return mode === "notes" ? text : `${ACTIONS_PREFIX}${text}`;
}

export function commandItems(state: State): CommandItem[] {
  const active = activeTab(state);
  const items = commandDefinitions.map((item) => {
    const label = item.id === "pin" && active?.kind === "saved" && state.pinned.has(active.noteId)
      ? "Unpin Current Tab"
      : item.id === "reading" && state.readingMode ? "Edit mode"
      : item.id === "focus" && state.focusMode ? "Exit focus mode"
      : item.label;
    const shortcut = shortcutLabels(item.id);
    return shortcut === undefined ? { ...item, label } : { ...item, label, shortcut };
  });
  const { text } = parsePaletteQuery(state.commandFilter);
  const query = text.trim().toLowerCase();
  return items.filter((item) => `${item.id} ${item.label}`.toLowerCase().includes(query));
}

export function paletteEntries(state: State, items: readonly CommandItem[]): PaletteEntry[] {
  const { mode, text } = parsePaletteQuery(state.commandFilter);
  const commands = items.map((command): PaletteEntry => ({ kind: "command", command }));
  if (mode === "actions") return commands;
  return [...noteEntries(state, text.trim()), ...commands];
}

function noteEntries(state: State, query: string): PaletteEntry[] {
  if (query === "") {
    return recentNotes(state).slice(0, RECENT_NOTE_LIMIT).map((note): PaletteEntry => ({ kind: "note", note }));
  }
  if (state.commandHits !== null) return state.commandHits.map((hit): PaletteEntry => ({ kind: "hit", hit }));
  const needle = query.toLowerCase();
  return recentNotes(state)
    .filter((note) => `${note.title} ${note.path}`.toLowerCase().includes(needle))
    .slice(0, LOCAL_MATCH_LIMIT)
    .map((note): PaletteEntry => ({ kind: "note", note }));
}

function recentNotes(state: State): V2NoteMeta[] {
  const seen = new Set<string>();
  const notes: V2NoteMeta[] = [];
  for (const noteId of state.recent) {
    const note = state.notes.get(noteId);
    if (note !== undefined && !seen.has(noteId)) {
      seen.add(noteId);
      notes.push(note);
    }
  }
  const rest = [...state.notes.values()].filter((note) => !seen.has(note.noteId))
    .toSorted((left, right) => right.updatedAtMs - left.updatedAtMs);
  return [...notes, ...rest];
}
