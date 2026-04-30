import { stemFromPath } from "@joshuarli98/md-wysiwyg";

import { getNote, renameNote } from "./api.ts";
import { invalidateNoteCache } from "./autocomplete.ts";
import { reportActionError } from "./notify.ts";
import { serverStore } from "./server-store.ts";
import { getActiveTab, updateTabContent, updateTabPath } from "./tab-state.ts";

export async function renameNoteAndRefresh(oldPath: string, newPath: string): Promise<void> {
  try {
    const result = await renameNote(oldPath, newPath);
    invalidateNoteCache();
    serverStore.notifyFilesChanged();
    updateTabPath(oldPath, result.path, result.title);

    await Promise.all(
      result.updated.map(async (updated) => {
        try {
          const note = await getNote(updated);
          updateTabContent(updated, note.content, note.mtime, note.tags, note.title);
        } catch {
          /* ignore reload failures */
        }
      }),
    );

    const active = getActiveTab();
    if (active?.path === result.path) {
      try {
        const note = await getNote(result.path);
        updateTabContent(result.path, note.content, note.mtime, note.tags, note.title);
      } catch {
        /* ignore reload failures */
      }
    }
  } catch (error) {
    reportActionError(`Failed to rename ${stemFromPath(oldPath)}`, error);
  }
}
