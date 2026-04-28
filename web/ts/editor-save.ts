import { forceSaveNote, saveNote } from "./api.ts";
import { showConflictBanner, handleReloadConflict } from "./conflict.tsx";
import { AUTOSAVE_DELAY_MS, AUTOSAVE_RETRY_DELAY_MS } from "./constants.ts";
import { serverStore } from "./server-store.ts";
import { getActiveTab, getTabs, markClean, setCursor } from "./tab-state.ts";

export type SaveAction =
  | { type: "clean"; content: string; mtime: number }
  | { type: "false-conflict"; content: string }
  | { type: "real-conflict"; diskContent: string; diskMtime: number }
  | { type: "no-op" };

export function classifySaveResult(
  result: { conflict?: boolean; content?: string; mtime: number },
  editorContent: string,
  tabContent: string,
): SaveAction {
  if (!result.conflict) {
    return { type: "clean", content: editorContent, mtime: result.mtime };
  }
  const diskContent = result.content ?? "";
  if (diskContent === editorContent || diskContent === tabContent) {
    return { type: "false-conflict", content: editorContent };
  }
  return { type: "real-conflict", diskContent, diskMtime: result.mtime };
}

type ReloadAction = { type: "load" } | { type: "conflict" };

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
        autosaveTimer = setTimeout(tryAutosave, AUTOSAVE_RETRY_DELAY_MS);
        return;
      }
    }
    void saveCurrentNote({ silent: true });
  }

  function scheduleAutosave() {
    clearAutosaveTimer();
    autosaveTimer = setTimeout(tryAutosave, AUTOSAVE_DELAY_MS);
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
      case "clean":
        markClean(currentPath, action.content, action.mtime);
        serverStore.notifyFilesChanged(currentPath);
        break;
      case "false-conflict": {
        const retry = await forceSaveNote(currentPath, content);
        markClean(currentPath, content, retry.mtime);
        serverStore.notifyFilesChanged(currentPath);
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
          );
        }
        return;
      }
      default:
        return;
    }

    if (cursorOffset >= 0) {
      setCursor(currentPath, cursorOffset);
    }
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
      return;
    }

    const container = opts.getContainer();
    if (container) {
      handleReloadConflict(
        tab,
        container,
        currentPath,
        content,
        mtime,
        (markdown) => opts.loadContent(markdown),
        opts.getCurrentContent,
      );
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
