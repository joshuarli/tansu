import { createAppCommandRegistry } from "./command-registry.ts";

describe("command registry", () => {
  it("registers HTML import on Cmd+I", () => {
    let importCount = 0;
    const commands = createAppCommandRegistry({
      getActiveSearchPath: () => {},
      openSearch: () => {},
      openNewNote: async () => {},
      openHtmlImport: () => {
        importCount++;
      },
      reopenClosedTab: async () => {},
      saveCurrentNote: async () => {},
      closeActiveTab: () => {},
      nextTab: () => {},
      prevTab: () => {},
      openSettings: () => {},
    });

    const importCommand = commands.find((command) => command.label === "Import HTML file");
    expect(importCommand).toMatchObject({
      shortcut: "⌘I",
      keys: { key: "i", meta: true },
    });

    importCommand?.action();
    expect(importCount).toBe(1);
  });
});
