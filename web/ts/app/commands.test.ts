import { describe, expect, it } from "vitest";

import { createState } from "../state.ts";
import { vaultId } from "./identity.ts";
import { commandItems } from "./commands.ts";

describe("native command palette definitions", () => {
  it("lists native actions and target shortcut labels in palette order", () => {
    const items = commandItems(createState(vaultId("vault-a")));

    expect(items.map(({ id, label, shortcut }) => [id, label, shortcut])).toStrictEqual([
      ["create", "New Note", "⌃N"],
      ["save", "Save Note", "⌘S"],
      ["search", "Search Vault", "⌃G"],
      ["find", "Find in Note", "⌃F"],
      ["rename", "Rename Current Note", "⌃L"],
      ["close", "Close Current Tab", "⌃X"],
      ["delete", "Move Note to Trash", "⌘⌫"],
      ["pin", "Pin Current Tab", "⌃P"],
      ["reopen", "Reopen Last Closed Note", "⌘⇧T"],
    ]);
  });

  it("keeps Tansu2 actions searchable without adding them to the native default list", () => {
    const state = createState(vaultId("vault-a"));
    expect(commandItems(state).some((item) => item.id === "settings")).toBeFalsy();

    state.commandFilter = "settings";

    expect(commandItems(state).map((item) => item.id)).toStrictEqual(["settings"]);
  });
});
