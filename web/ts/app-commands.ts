import type { Accessor } from "solid-js";

import { createAppCommandRegistry } from "./command-registry.ts";
import { matchesKey, type Command } from "./commands.ts";
import { promptHtmlImport } from "./import-html.ts";
import { modalManager } from "./modal-manager.ts";
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
    openHtmlImport: promptHtmlImport,
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
    if (modalManager.activeModal()) {
      e.preventDefault();
      modalManager.closeTop();
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
