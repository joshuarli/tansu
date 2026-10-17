import { describe, expect, it } from "vitest";

import { createState } from "../state.ts";
import { vaultId } from "./identity.ts";
import { commandItems, paletteEntries, paletteRawQuery, parsePaletteQuery } from "./commands.ts";
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
      ["tag", "Add Tag", undefined],
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

  it("includes Tansu2 actions in the default command list", () => {
    const state = createState(vaultId("vault-a"));
    expect(commandItems(state).some((item) => item.id === "settings")).toBeTruthy();
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
  it("parses prefixes into modes and round-trips them", () => {
    expect(parsePaletteQuery("hello")).toStrictEqual({ mode: "notes", text: "hello" });
    expect(parsePaletteQuery("> save")).toStrictEqual({ mode: "actions", text: "save" });
    expect(parsePaletteQuery("#work")).toStrictEqual({ mode: "tags", text: "work" });
    expect(paletteRawQuery("actions", "save")).toBe(">save");
    expect(paletteRawQuery("notes", "a>b")).toBe("a>b");
  });

  it("filters actions only in action mode and ignores the prefix", () => {
    const state = createState(vaultId("vault-a"));
    state.commandFilter = ">revis";
    expect(commandItems(state).map((item) => item.id)).toStrictEqual(["revisions"]);
    expect(paletteEntries(state, commandItems(state)).every((entry) => entry.kind === "command")).toBe(true);
  });

  it("shows recent notes before actions when the query is empty", () => {
    const state = createState(vaultId("vault-a"));
    state.notes.set("a", noteMeta("a", "Alpha", [], 1));
    state.notes.set("b", noteMeta("b", "Beta", [], 2));
    state.recent = ["a"];
    const entries = paletteEntries(state, commandItems(state));
    expect(entries.slice(0, 2).map((entry) => entry.kind === "note" && entry.note.noteId)).toStrictEqual(["a", "b"]);
    expect(entries[2]?.kind).toBe("command");
  });

  it("filters notes by tag in tag mode", () => {
    const state = createState(vaultId("vault-a"));
    state.notes.set("a", noteMeta("a", "Alpha", ["work"], 1));
    state.notes.set("b", noteMeta("b", "Beta", ["home"], 2));
    state.notes.set("c", noteMeta("c", "Gamma", [], 3));
    state.commandFilter = "#wo";
    const entries = paletteEntries(state, commandItems(state));
    expect(entries.map((entry) => entry.kind === "note" && entry.note.noteId)).toStrictEqual(["a"]);
  });

  it("matches note titles locally until search hits arrive", () => {
    const state = createState(vaultId("vault-a"));
    state.notes.set("a", noteMeta("a", "Alpha", [], 1));
    state.notes.set("b", noteMeta("b", "Beta", [], 2));
    state.commandFilter = "alp";
    const entries = paletteEntries(state, []);
    expect(entries.map((entry) => entry.kind === "note" && entry.note.noteId)).toStrictEqual(["a"]);
  });
});
