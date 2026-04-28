import { hideAutocomplete, checkWikiLinkTrigger } from "./autocomplete.ts";
import type { EditorShellRefs } from "./editor-shell.tsx";
import { registerLinkHover } from "./link-hover.ts";
export { invalidateNoteCache } from "./autocomplete.ts";
import { hideTagAutocomplete } from "./tag-autocomplete.ts";
export { invalidateTagCache } from "./tag-autocomplete.ts";
import { loadBacklinks } from "./backlinks.tsx";
import { clearConflictBanner } from "./conflict.tsx";
import { createEditorAdapter, type EditorAdapter } from "./editor-adapter.ts";
import { getEditorPrefs, saveEditorPrefs, type EditorPrefs } from "./editor-prefs.ts";
import {
  createSaveController,
  classifyReload,
  classifySaveResult,
  type SaveAction,
} from "./editor-save.ts";
import { wireEditorShell } from "./editor-shell-wiring.ts";
import { createTagState } from "./editor-tags.ts";
import { splitFrontmatter, withFrontmatter } from "./frontmatter.ts";
import { initImageResize } from "./image-resize.ts";
import { setRevisionRestoreHandler } from "./revision-events.ts";
import { hideRevisions } from "./revisions.tsx";
import { getCursor, markClean, updateTabDraft } from "./tab-state.ts";

let currentHandle: EditorAdapter | null = null;

export function getEditorHandle(): EditorAdapter | null {
  return currentHandle;
}

export { getEditorPrefs, saveEditorPrefs, classifySaveResult, classifyReload };
export type { EditorPrefs, SaveAction };

export type EditorInstance = {
  showEditor(path: string, content: string, tags?: string[]): void;
  hideEditor(): void;
  getCurrentContent(): string;
  saveCurrentNote(opts?: { silent?: boolean }): Promise<void>;
  reloadFromDisk(content: string, mtime: number): void;
};

type EditorElements = {
  emptyState: HTMLElement;
  shellRefs: EditorShellRefs;
  setTags: (tags: readonly string[]) => void;
  setSourceMode: (value: boolean) => void;
  setVisible: (value: boolean) => void;
};

export function initEditor(elements: Readonly<EditorElements>): EditorInstance {
  registerLinkHover();

  let container: HTMLElement | null = null;
  let backlinksEl: HTMLElement | null = null;
  let currentPath: string | null = null;

  function getHandle() {
    return currentHandle;
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
    const handle = getHandle();
    if (!handle) {
      return;
    }
    const parsed = splitFrontmatter(markdown);
    if (handle.isSourceMode) {
      const position = handle.sourceEl.selectionStart;
      handle.sourceEl.value = markdown;
      handle.sourceEl.selectionStart = position;
      handle.sourceEl.selectionEnd = position;
    } else {
      const focused =
        handle.contentEl === document.activeElement ||
        handle.contentEl.contains(document.activeElement);
      const offset = explicitOffset ?? (focused ? handle.getCursorOffset() : -1);
      if (offset >= 0) {
        handle.setValue(parsed.body, offset);
        if (explicitOffset !== undefined) {
          const selection = window.getSelection();
          if (selection && selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            const node =
              range.startContainer instanceof Element
                ? range.startContainer
                : range.startContainer.parentElement;
            node?.scrollIntoView({ block: "center", behavior: "instant" });
          }
        }
      } else {
        handle.setValue(parsed.body);
      }
    }
    if (parsed.hasFrontmatter) {
      tagState.setTags(parsed.tags);
    }
  }

  const saveController = createSaveController({
    getHandle,
    getCurrentPath: () => currentPath,
    getCurrentContent,
    getContainer: () => container,
    loadContent,
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
  });

  setRevisionRestoreHandler((payload) => {
    if (!currentPath) {
      return;
    }
    loadContent(payload.content);
    markClean(currentPath, payload.content, payload.mtime);
  });

  function toggleSourceMode() {
    const handle = getHandle();
    if (!handle) {
      return;
    }
    hideRevisions();
    hideTagAutocomplete();

    if (handle.isSourceMode) {
      const markdown = handle.sourceEl.value;
      const parsed = splitFrontmatter(markdown);
      tagState.setTags(parsed.hasFrontmatter ? parsed.tags : []);
      handle.sourceEl.value = parsed.hasFrontmatter ? parsed.body : markdown;
      handle.toggleSourceMode();
    } else {
      const body = handle.getValue();
      handle.toggleSourceMode();
      handle.sourceEl.value = withFrontmatter(body, tagState.tags());
    }
    elements.setSourceMode(handle.isSourceMode);
  }

  function onEditorTabMutation() {
    const handle = getHandle();
    if (currentPath) {
      updateTabDraft(currentPath, { content: getCurrentContent(), tags: tagState.tags() });
    }
    saveController.scheduleAutosave();
    if (handle && !handle.isSourceMode) {
      checkWikiLinkTrigger(handle.contentEl, currentPath);
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
    elements.setVisible(true);
    elements.setSourceMode(false);
    elements.emptyState.style.display = "none";

    currentHandle?.destroy();
    currentHandle = null;

    elements.shellRefs.editorMountEl.textContent = "";
    container = elements.shellRefs.containerEl;
    backlinksEl = elements.shellRefs.backlinksEl;

    currentHandle = createEditorAdapter(elements.shellRefs.editorMountEl, {
      undoStackMax: getEditorPrefs().undoStackMax,
      getCurrentPath: () => currentPath,
      onChange: onEditorTabMutation,
      onSave: () => {
        void saveController.saveCurrentNote();
      },
    });

    shellWiring.attachToHandle(currentHandle);
    tagState.renderTagRow();

    const cursor = getCursor(path);
    loadContent(content, cursor);
    initImageResize(currentHandle.contentEl, onEditorTabMutation);
    loadBacklinks(backlinksEl, path);
    currentHandle.focus();
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
    elements.setVisible(false);
    elements.setSourceMode(false);

    currentHandle?.destroy();
    currentHandle = null;

    container = null;
    backlinksEl = null;
    elements.shellRefs.editorMountEl.textContent = "";
    elements.shellRefs.revisionsEl.textContent = "";
    elements.shellRefs.backlinksEl.textContent = "";

    elements.emptyState.style.display = "flex";
  }

  return {
    showEditor,
    hideEditor,
    getCurrentContent,
    saveCurrentNote: saveController.saveCurrentNote,
    reloadFromDisk: saveController.reloadFromDisk,
  };
}
