import { describe, expect, it } from "vitest";

import { createState } from "../state.ts";
import { vaultId } from "./identity.ts";
import { commandItems } from "./commands.ts";

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
      ["import", "Import HTML", undefined],
      ["revisions", "Revisions", undefined],
      ["settings", "Settings", undefined],
      ["source", "Source mode", undefined],
    ]);
  });

  it("includes Tansu2 actions in the default command list", () => {
    const state = createState(vaultId("vault-a"));
    expect(commandItems(state).some((item) => item.id === "settings")).toBeTruthy();
  });
});
