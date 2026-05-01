import { hideAutocomplete, checkWikiLinkTrigger } from "./autocomplete.ts";
import type { EditorShellRefs } from "./editor-shell.tsx";
import { registerLinkHover } from "./link-hover.ts";
export { invalidateNoteCache } from "./autocomplete.ts";
import { hideTagAutocomplete } from "./tag-autocomplete.ts";
export { invalidateTagCache } from "./tag-autocomplete.ts";
import { loadBacklinks } from "./backlinks.tsx";
import { clearConflictBanner } from "./conflict.ts";
import { createEditorAdapter, type EditorAdapter } from "./editor-adapter.ts";
import {
  createSaveController,
  classifyReload,
  classifySaveResult,
  type SaveAction,
  type ReloadAction,
} from "./editor-save.ts";
import { wireEditorShell } from "./editor-shell-wiring.ts";
import { createTagState } from "./editor-tags.ts";
import { loadEditorContent } from "./features/editor/content.ts";
import {
  createEditorDisplayStateController,
  type EditorDisplayState,
} from "./features/editor/display-state.ts";
import { toggleEditorSourceMode } from "./features/editor/source-mode.ts";
import { initImageResize } from "./image-resize.ts";
import { hideRevisions } from "./revisions.tsx";
import {
  getEditorPrefs,
  getEditorRuntimeSettings,
  saveEditorPrefs,
  type EditorPrefs,
} from "./settings.ts";
import { getCursor, markClean, updateTabDraft } from "./tab-state.ts";

export { getEditorPrefs, saveEditorPrefs, classifySaveResult, classifyReload };
export type { EditorPrefs, SaveAction, ReloadAction, EditorDisplayState };

export type EditorInstance = {
  showEditor(path: string, content: string, tags?: string[]): void;
  hideEditor(): void;
  getDisplayState(): EditorDisplayState;
  getCurrentContent(): string;
  saveCurrentNote(opts?: { silent?: boolean }): Promise<void>;
  reloadFromDisk(content: string, mtime: number): void;
  restoreRevision(content: string, mtime: number): void;
  applyPrefs(): void;
  destroy(): void;
};

type EditorElements = {
  emptyState: HTMLElement;
  shellRefs: EditorShellRefs;
  setTags: (tags: readonly string[]) => void;
  setSourceMode: (value: boolean) => void;
  setVisible: (value: boolean) => void;
  setDisplayState?: (state: EditorDisplayState) => void;
};

export function initEditor(elements: Readonly<EditorElements>): EditorInstance {
  const disposeLinkHover = registerLinkHover();

  let handle: EditorAdapter | null = null;
  let container: HTMLElement | null = null;
  let backlinksEl: HTMLElement | null = null;
  let currentPath: string | null = null;
  let disposeImageResize: (() => void) | null = null;
  const displayState = createEditorDisplayStateController((state) => {
    elements.setDisplayState?.(state);
    elements.setVisible(state.type !== "empty");
    elements.setSourceMode(state.type === "source");
  });

  function getHandle() {
    return handle;
  }

  const tagState = createTagState({
    getHandle,
    getTagInputEl: elements.shellRefs.getTagInputEl,
    setTagsView: elements.setTags,
    onMutation: onEditorTabMutation,
  });

  function getCurrentContent() {
    return tagState.getCurrentContent();
  }

  function loadContent(markdown: string, explicitOffset?: number) {
    loadEditorContent({
      handle: getHandle(),
      markdown,
      setTags: tagState.setTags,
      ...(explicitOffset !== undefined ? { explicitOffset } : {}),
    });
  }

  const saveController = createSaveController({
    getHandle,
    getCurrentPath: () => currentPath,
    getCurrentContent,
    getContainer: () => container,
    loadContent,
    onDisplayState: displayState.setType,
    onPathChanged: (path) => {
      currentPath = path;
      if (backlinksEl) {
        loadBacklinks(backlinksEl, path);
      }
    },
  });

  const shellWiring = wireEditorShell({
    shellRefs: elements.shellRefs,
    getHandle,
    getCurrentPath: () => currentPath,
    getCurrentContent,
    onMutation: onEditorTabMutation,
    onToggleSourceMode: toggleSourceMode,
    onRemoveTag: (tag) => {
      const next = tagState.tags().filter((current) => current !== tag);
      tagState.setTags(next);
      tagState.syncSourceFromTags();
      onEditorTabMutation();
      elements.shellRefs.getTagInputEl()?.focus();
    },
    onRestoreRevision: (content, mtime) => restoreRevision(content, mtime),
    onDisplayState: displayState.setType,
  });

  function toggleSourceMode() {
    const editorHandle = getHandle();
    if (!editorHandle) {
      return;
    }
    hideRevisions();
    hideTagAutocomplete();
    toggleEditorSourceMode({
      handle: editorHandle,
      tags: tagState.tags(),
      setTags: tagState.setTags,
      setDisplayState: displayState.setType,
    });
  }

  function onEditorTabMutation() {
    const editorHandle = getHandle();
    if (currentPath) {
      updateTabDraft(currentPath, { content: getCurrentContent(), tags: tagState.tags() });
    }
    saveController.scheduleAutosave();
    if (editorHandle && !editorHandle.isSourceMode) {
      checkWikiLinkTrigger(editorHandle.contentEl, currentPath);
    }
  }

  function showEditor(path: string, content: string, tags: string[] = []) {
    saveController.flushPendingAutosave();

    currentPath = path;
    hideRevisions();
    hideAutocomplete();
    hideTagAutocomplete();
    container?.querySelector(".conflict-banner-host")?.remove();
    tagState.setTags(tags);
    displayState.setType("editing");
    elements.emptyState.style.display = "none";

    disposeImageResize?.();
    disposeImageResize = null;
    handle?.destroy();
    handle = null;

    elements.shellRefs.editorMountEl.textContent = "";
    container = elements.shellRefs.containerEl;
    backlinksEl = elements.shellRefs.backlinksEl;

    handle = createEditorAdapter(elements.shellRefs.editorMountEl, {
      undoStackMax: getEditorRuntimeSettings().undoStackMax,
      getCurrentPath: () => currentPath,
      onChange: onEditorTabMutation,
      onSave: () => {
        void saveController.saveCurrentNote();
      },
    });

    shellWiring.attachToHandle(handle);
    tagState.renderTagRow();

    const cursor = getCursor(path);
    loadContent(content, cursor);
    disposeImageResize = initImageResize(handle.contentEl, onEditorTabMutation);
    loadBacklinks(backlinksEl, path);
    handle.focus();
  }

  function hideEditor() {
    saveController.flushPendingAutosave();

    currentPath = null;
    hideRevisions();
    hideAutocomplete();
    hideTagAutocomplete();
    if (container) {
      clearConflictBanner(container);
    }
    tagState.setTags([]);
    displayState.setType("empty");

    disposeImageResize?.();
    disposeImageResize = null;
    handle?.destroy();
    handle = null;

    container = null;
    backlinksEl = null;
    elements.shellRefs.editorMountEl.textContent = "";
    elements.shellRefs.revisionsEl.textContent = "";
    elements.shellRefs.backlinksEl.textContent = "";

    elements.emptyState.style.display = "flex";
  }

  function restoreRevision(content: string, mtime: number) {
    if (!currentPath) {
      return;
    }
    loadContent(content);
    markClean(currentPath, content, mtime);
    displayState.setType("editing");
  }

  function applyPrefs() {
    handle?.setConfig(getEditorRuntimeSettings());
  }

  function destroy() {
    hideEditor();
    shellWiring.dispose();
    disposeLinkHover();
  }

  return {
    showEditor,
    hideEditor,
    getDisplayState: displayState.get,
    getCurrentContent,
    saveCurrentNote: saveController.saveCurrentNote,
    reloadFromDisk: saveController.reloadFromDisk,
    restoreRevision,
    applyPrefs,
    destroy,
  };
}
