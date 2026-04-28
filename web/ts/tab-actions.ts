import { createNote } from "./api.ts";
import { serverStore } from "./server-store.ts";
import { openTab } from "./tab-state.ts";
import { uiStore } from "./ui-store.ts";

export async function createNewNote(name: string): Promise<void> {
  const path = name.endsWith(".md") ? name : `${name}.md`;
  try {
    await createNote(path);
    serverStore.notifyFilesChanged();
    await openTab(path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    uiStore.showNotification(`Failed to create note ${path}: ${reason}`, "error");
  }
}
