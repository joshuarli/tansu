import { describe, expect, it } from "vitest";

import { createState } from "../state.ts";
import { vaultId } from "./identity.ts";
import {
  commandItems,
  paletteEntries,
  paletteRawQuery,
  parsePaletteQuery,
  type PaletteMode,
} from "./commands.ts";
import type { V2NoteMeta } from "../types.generated.ts";

describe("native command palette definitions", () => {
  it("lists native actions and target shortcut labels in palette order", () => {
    const items = commandItems(createState(vaultId("vault-a")));

    expect(items.map(({ id, label, shortcut }) => [id, label, shortcut])).toStrictEqual([
      ["create", "New Note", "Ctrl+Alt+N / Ctrl+N / Ctrl+T / ⌘⌥N"],
      ["save", "Save Note", "Ctrl+S / ⌘S"],
      ["search", "Search Notes", "Ctrl+/ / ⌘⇧F"],
      ["find", "Find in Note", "Ctrl+F / ⌘F"],
      ["rename", "Rename Current Note", "Ctrl+L"],
      ["close", "Close Current Tab", "Ctrl+X"],
      ["delete", "Move Note to Trash", "⌘⌫"],
      ["pin", "Pin Current Tab", undefined],
      ["reopen", "Reopen Last Closed Note", "⌘⇧T"],
      ["reading", "Reading mode", undefined],
      ["focus", "Focus mode", "⌘⇧Enter / Ctrl+Shift+Enter"],
      ["revisions", "Revisions", undefined],
      ["restore", "Restore Version", undefined],
      ["settings", "Settings", undefined],
      ["source", "Source mode", undefined],
    ]);
  });

  it("labels the focus command by its current state", () => {
    const state = createState(vaultId("vault-a"));
    state.focusMode = true;
    expect(commandItems(state).find((item) => item.id === "focus")?.label).toBe("Exit focus mode");
  });

  it("parses query prefixes into modes and round-trips them", () => {
    const parsed: Array<[string, { mode: PaletteMode; text: string }]> = [
      ["hello", { mode: "notes", text: "hello" }],
      ["> save", { mode: "actions", text: "save" }],
      ["#work", { mode: "notes", text: "#work" }],
    ];
    for (const [raw, expected] of parsed) {
      expect(parsePaletteQuery(raw)).toStrictEqual(expected);
    }
    const raw: Array<[PaletteMode, string, string]> = [
      ["actions", "save", ">save"],
      ["notes", "a>b", "a>b"],
    ];
    for (const [mode, text, expected] of raw) {
      expect(paletteRawQuery(mode, text)).toBe(expected);
    }
  });
});

function noteMeta(noteId: string, title: string, tags: string[], updatedAtMs: number): V2NoteMeta {
  return {
    noteId,
    path: `${title.toLowerCase()}.md`,
    title,
    tags,
    revision: 1,
    sourceHash: "h",
    diskHash: "h",
    sourceHashFormatVersion: 1,
    diskHashFormatVersion: 1,
    updatedAtMs,
  };
}

describe("omnibox modes", () => {
  it("resolves entries from the local filter, recents, and note titles", () => {
    const noted = () => {
      const state = createState(vaultId("vault-a"));
      state.notes.set("a", noteMeta("a", "Alpha", [], 1));
      state.notes.set("b", noteMeta("b", "Beta", [], 2));
      return state;
    };

    const filtered = createState(vaultId("vault-a"));
    filtered.commandFilter = ">revis";
    expect(commandItems(filtered).map((item) => item.id)).toStrictEqual(["revisions"]);
    expect(
      paletteEntries(filtered, commandItems(filtered)).every((entry) => entry.kind === "command"),
    ).toBeTruthy();

    const recent = noted();
    recent.recent = ["a"];
    const entries = paletteEntries(recent, commandItems(recent));
    expect(entries.slice(0, 2).map((entry) => entry.kind === "note" && entry.note.noteId)).toStrictEqual([
      "a",
      "b",
    ]);
    expect(entries[2]?.kind).toBe("command");

    const titled = noted();
    titled.commandFilter = "alp";
    expect(
      paletteEntries(titled, []).map((entry) => entry.kind === "note" && entry.note.noteId),
    ).toStrictEqual(["a"]);
  });
});
