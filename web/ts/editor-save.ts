import { forceSaveNote, getNote, saveNote } from "./api.ts";
import { showConflictBanner, handleReloadConflict } from "./conflict.ts";
import { serverStore } from "./server-store.ts";
import { getVaultSettings } from "./settings.ts";
import {
  getActiveTab,
  getTabs,
  markClean,
  setCursor,
  updateTabContent,
  updateTabPath,
} from "./tab-state.ts";

export type SaveAction =
  | {
      type: "clean";
      content: string;
      mtime: number;
      path?: string;
      title?: string;
      updated?: string[];
    }
  | { type: "false-conflict"; content: string }
  | { type: "real-conflict"; diskContent: string; diskMtime: number };

export function classifySaveResult(
  result: {
    conflict?: boolean;
    content?: string;
    mtime: number;
    path?: string;
    title?: string;
    updated?: string[];
  },
  editorContent: string,
  tabContent: string,
): SaveAction {
  if (!result.conflict) {
    return {
      type: "clean",
      content: editorContent,
      mtime: result.mtime,
      ...(result.path !== undefined ? { path: result.path } : {}),
      ...(result.title !== undefined ? { title: result.title } : {}),
      ...(result.updated !== undefined ? { updated: result.updated } : {}),
    };
  }
  const diskContent = result.content ?? "";
  if (diskContent === editorContent || diskContent === tabContent) {
    return { type: "false-conflict", content: editorContent };
  }
  return { type: "real-conflict", diskContent, diskMtime: result.mtime };
}

export type ReloadAction = { type: "load" } | { type: "conflict" };

function assertNever(value: never): never {
  throw new Error(`unhandled action: ${JSON.stringify(value)}`);
}

export function classifyReload(isDirty: boolean): ReloadAction {
  return isDirty ? { type: "conflict" } : { type: "load" };
}

type SaveControllerOptions = {
  getHandle: () => {
    isSourceMode: boolean;
    contentEl: HTMLElement;
    getCursorOffset(): number;
  } | null;
  getCurrentPath: () => string | null;
  getCurrentContent: () => string;
  getContainer: () => HTMLElement | null;
  loadContent: (markdown: string, explicitOffset?: number) => void;
  onDisplayState: (state: "editing" | "conflict") => void;
  onPathChanged?: (path: string) => void;
};

export function createSaveController(opts: Readonly<SaveControllerOptions>) {
  let saving = false;
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

  function clearAutosaveTimer() {
    if (autosaveTimer !== null) {
      clearTimeout(autosaveTimer);
      autosaveTimer = null;
    }
  }

  function tryAutosave() {
    autosaveTimer = null;
    const handle = opts.getHandle();
    if (handle && !handle.isSourceMode) {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && handle.contentEl.contains(selection.anchorNode)) {
        autosaveTimer = setTimeout(tryAutosave, getVaultSettings().autosaveRetryDelayMs);
        return;
      }
    }
    void saveCurrentNote({ silent: true });
  }

  function scheduleAutosave() {
    clearAutosaveTimer();
    autosaveTimer = setTimeout(tryAutosave, getVaultSettings().autosaveDelayMs);
  }

  function flushPendingAutosave() {
    if (autosaveTimer === null) {
      return;
    }
    clearAutosaveTimer();
    void saveCurrentNote({ silent: true });
  }

  async function saveCurrentNote(optsArg?: { silent?: boolean }) {
    if (saving) {
      return;
    }
    clearAutosaveTimer();
    saving = true;
    try {
      await doSave(optsArg?.silent ?? false);
    } finally {
      saving = false;
    }
  }

  async function doSave(silent: boolean) {
    const currentPath = opts.getCurrentPath();
    const handle = opts.getHandle();
    if (!currentPath || !handle) {
      return;
    }

    const tab = getTabs().find((entry) => entry.path === currentPath) ?? getActiveTab();
    if (!tab || !tab.dirty) {
      return;
    }

    const content = opts.getCurrentContent();
    if (content === tab.lastSavedMd) {
      return;
    }

    const cursorOffset = handle.isSourceMode ? -1 : handle.getCursorOffset();
    const result = await saveNote(currentPath, content, tab.mtime);
    const action = classifySaveResult(result, content, tab.lastSavedMd);

    switch (action.type) {
      case "clean": {
        const savedPath = action.path ?? currentPath;
        const pathChanged = savedPath !== currentPath;
        if (pathChanged) {
          updateTabPath(currentPath, savedPath, action.title);
          opts.onPathChanged?.(savedPath);
        }
        markClean(savedPath, action.content, action.mtime, action.title);
        await reloadUpdatedNotes(action.updated ?? [], savedPath);
        serverStore.notifyFilesChanged(pathChanged ? undefined : savedPath);
        opts.onDisplayState("editing");
        break;
      }
      case "false-conflict": {
        const retry = await forceSaveNote(currentPath, content);
        const savedPath = retry.path ?? currentPath;
        const pathChanged = savedPath !== currentPath;
        if (pathChanged) {
          updateTabPath(currentPath, savedPath, retry.title);
          opts.onPathChanged?.(savedPath);
        }
        markClean(savedPath, content, retry.mtime, retry.title);
        await reloadUpdatedNotes(retry.updated ?? [], savedPath);
        serverStore.notifyFilesChanged(pathChanged ? undefined : savedPath);
        opts.onDisplayState("editing");
        break;
      }
      case "real-conflict": {
        const container = opts.getContainer();
        if (!silent && container) {
          showConflictBanner(
            container,
            currentPath,
            action.diskContent,
            action.diskMtime,
            (markdown) => opts.loadContent(markdown),
            opts.getCurrentContent,
            () => opts.onDisplayState("editing"),
          );
          opts.onDisplayState("conflict");
        }
        return;
      }
      default: {
        assertNever(action);
      }
    }

    if (cursorOffset >= 0) {
      setCursor(opts.getCurrentPath() ?? currentPath, cursorOffset);
    }
  }

  async function reloadUpdatedNotes(updated: readonly string[], activePath: string) {
    await Promise.all(
      updated
        .filter((path) => path !== activePath)
        .map(async (path) => {
          try {
            const note = await getNote(path);
            updateTabContent(path, note.content, note.mtime, note.tags, note.title);
          } catch {
            /* ignore reload failures */
          }
        }),
    );
  }

  function reloadFromDisk(content: string, mtime: number) {
    const tab = getActiveTab();
    const currentPath = opts.getCurrentPath();
    if (!tab || !currentPath) {
      return;
    }

    const action = classifyReload(tab.dirty);
    if (action.type === "load") {
      if (tab.lastSavedMd !== content && opts.getCurrentContent() !== content) {
        opts.loadContent(content);
      }
      markClean(currentPath, content, mtime);
      opts.onDisplayState("editing");
      return;
    }

    const container = opts.getContainer();
    if (container) {
      const result = handleReloadConflict(
        tab,
        container,
        currentPath,
        content,
        mtime,
        (markdown) => opts.loadContent(markdown),
        opts.getCurrentContent,
        () => opts.onDisplayState("editing"),
      );
      opts.onDisplayState(result === "conflict" ? "conflict" : "editing");
    }
  }

  return {
    scheduleAutosave,
    clearAutosaveTimer,
    flushPendingAutosave,
    saveCurrentNote,
    reloadFromDisk,
  };
}
