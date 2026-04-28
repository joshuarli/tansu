import type { Accessor } from "solid-js";

import { createAppCommandRegistry } from "./command-registry.ts";
import { matchesKey, type Command } from "./commands.ts";
import { closeActiveTab, getActiveTab, nextTab, prevTab, reopenClosedTab } from "./tab-state.ts";
import { promptNewNote } from "./tabs.tsx";
import { uiStore } from "./ui-store.ts";

type AppCommandsOptions = {
  getEditor: () => { saveCurrentNote(opts?: { silent?: boolean }): Promise<void> } | null;
};

export function createAppCommands(opts: Readonly<AppCommandsOptions>): readonly Command[] {
  return createAppCommandRegistry({
    getActiveSearchPath: () => getActiveTab()?.path,
    openSearch: (scopePath) => uiStore.openSearch(scopePath),
    openNewNote: promptNewNote,
    reopenClosedTab,
    saveCurrentNote: () => opts.getEditor()?.saveCurrentNote(),
    closeActiveTab,
    nextTab,
    prevTab,
    openSettings: () => uiStore.openSettings(),
  });
}

export function handleGlobalAppKeydown(
  e: KeyboardEvent,
  commands: Accessor<readonly Command[]>,
): void {
  if (e.key === "Escape") {
    if (uiStore.paletteOpen()) {
      e.preventDefault();
      uiStore.closePalette();
      return;
    }
    if (uiStore.settingsOpen()) {
      e.preventDefault();
      uiStore.closeSettings();
      return;
    }
    if (uiStore.searchOpen()) {
      e.preventDefault();
      uiStore.closeSearch();
    }
    return;
  }

  if ((e.metaKey || e.ctrlKey) && e.key === "p") {
    e.preventDefault();
    uiStore.togglePalette();
    return;
  }

  for (const command of commands()) {
    if (command.keys && matchesKey(e, command.keys)) {
      e.preventDefault();
      command.action();
      return;
    }
  }
}
