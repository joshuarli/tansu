import { createNote } from "./api.ts";
import { serverStore } from "./server-store.ts";
import { openTab, setCursor } from "./tab-state.ts";
import { uiStore } from "./ui-store.ts";

function titleFromPath(path: string): string {
  const filename = path.split("/").pop() ?? path;
  return filename.replace(/\.md$/iu, "");
}

export async function createNewNote(name: string): Promise<void> {
  const path = name.endsWith(".md") ? name : `${name}.md`;
  try {
    const result = await createNote(path);
    const savedPath = result.path ?? path;
    const title = result.title || titleFromPath(path);
    setCursor(savedPath, `# ${title}\n\n`.length);
    serverStore.notifyFilesChanged();
    await openTab(savedPath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    uiStore.showNotification(`Failed to create note ${path}: ${reason}`, "error");
  }
}
