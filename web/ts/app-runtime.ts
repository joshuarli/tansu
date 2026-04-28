import { stemFromPath } from "@joshuarli98/md-wysiwyg";

import { createNote, listNotes } from "./api.ts";
import { invalidateNoteCache, type EditorInstance } from "./editor.ts";
import { serverStore } from "./server-store.ts";
import { closeActiveTab, getActiveTab, openTab, syncToServer } from "./tab-state.ts";
import { registerWikiLinkClickHandler } from "./wikilinks.ts";

export function registerWikiLinkNavigation(): void {
  registerWikiLinkClickHandler(async (target: string) => {
    const notes = await listNotes();
    const normalized = target.toLowerCase().replaceAll(/\s+/g, "-");
    const match = notes.find((note) => {
      const stem = stemFromPath(note.path).toLowerCase().replaceAll(/\s+/g, "-");
      return stem === normalized;
    });

    if (match) {
      await openTab(match.path);
      return;
    }

    const path = `${target}.md`;
    await createNote(path);
    invalidateNoteCache();
    await openTab(path);
  });
}

type ConfigureServerRuntimeOptions = {
  getEditor: () => EditorInstance | null;
  showUnlockScreen: () => void;
};

export function configureServerRuntime(opts: Readonly<ConfigureServerRuntimeOptions>): void {
  serverStore.configure({
    invalidateNoteCache,
    getActivePath: () => getActiveTab()?.path ?? null,
    reloadActiveNote: (content, mtime) => {
      opts.getEditor()?.reloadFromDisk(content, mtime);
    },
    closeActiveTab,
    syncSessionToServer: syncToServer,
    refreshVaultSwitcher: async () => undefined,
    showUnlockScreen: opts.showUnlockScreen,
  });
}
