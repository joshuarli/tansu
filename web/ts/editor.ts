import {
  createEditor,
  type EditorHandle,
  escapeHtml,
  stemFromPath,
  toggleBold,
  toggleItalic,
  toggleHighlight,
  shiftIndent,
} from "@joshuarli98/md-wysiwyg";

import { forceSaveNote, saveNote, uploadImage } from "./api.ts";
import { checkWikiLinkTrigger, hideAutocomplete } from "./autocomplete.ts";
export { invalidateNoteCache } from "./autocomplete.ts";
import { editorExtensions } from "./editor-config.ts";
import { mountEditorShell, type EditorShellController } from "./editor-shell.tsx";
import { splitFrontmatter, withFrontmatter } from "./frontmatter.ts";
import {
  checkTagInput,
  hideTagAutocomplete,
  normalizeTagInput,
  rememberTags,
} from "./tag-autocomplete.ts";
export { invalidateTagCache } from "./tag-autocomplete.ts";
import { loadBacklinks } from "./backlinks.tsx";
import { showConflictBanner, handleReloadConflict } from "./conflict.tsx";
import { AUTOSAVE_DELAY_MS, AUTOSAVE_RETRY_DELAY_MS } from "./constants.ts";
import { showContextMenu } from "./context-menu.tsx";
import { on, emit } from "./events.ts";
import { initFormatToolbar, populateFormatButtons } from "./format-toolbar.ts";
import { initImageResize } from "./image-resize.ts";
import { registerLinkHover } from "./link-hover.ts";
import { toggleRevisions, hideRevisions, isRevisionsOpen } from "./revisions.tsx";
import {
  markClean,
  getActiveTab,
  getTabs,
  setCursor,
  getCursor,
  updateTabDraft,
} from "./tab-state.ts";

export type SaveAction =
  | { type: "clean"; content: string; mtime: number }
  | { type: "false-conflict"; content: string }
  | { type: "real-conflict"; diskContent: string; diskMtime: number }
  | { type: "no-op" };

/// Pure decision: given a save result, determine what action to take.
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

/// Pure decision: determine how to handle a disk reload.
export function classifyReload(isDirty: boolean): ReloadAction {
  return isDirty ? { type: "conflict" } : { type: "load" };
}

export type EditorInstance = {
  showEditor(path: string, content: string, tags?: string[]): void;
  hideEditor(): void;
  getCurrentContent(): string;
  saveCurrentNote(opts?: { silent?: boolean }): Promise<void>;
  reloadFromDisk(content: string, mtime: number): void;
};

export function initEditor(): EditorInstance {
  const editorArea = document.querySelector("#editor-area")!;
  registerLinkHover();

  let formatToolbarCleanup: (() => void) | null = null;
  let container: HTMLElement | null = null;
  let tagInputEl: HTMLInputElement | null = null;
  let backlinksEl: HTMLElement | null = null;
  let revisionsEl: HTMLElement | null = null;
  let shell: EditorShellController | null = null;
  let shellHost: HTMLElement | null = null;
  let handle: EditorHandle | null = null;
  let currentPath: string | null = null;
  let currentTags: string[] = [];
  let saving = false;
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

  on("revision:restore", ({ content, mtime }) => {
    if (currentPath) {
      loadContent(content);
      markClean(currentPath, content, mtime);
    }
  });

  function getCurrentContent(): string {
    if (!handle) return "";
    if (handle.isSourceMode) {
      const parsed = splitFrontmatter(handle.sourceEl.value);
      if (parsed.hasFrontmatter) {
        const changed =
          currentTags.length !== parsed.tags.length ||
          currentTags.some((tag, i) => tag !== parsed.tags[i]);
        if (changed) {
          currentTags = [...parsed.tags];
          renderTagRow();
        }
      }
      return handle.sourceEl.value;
    }
    return withFrontmatter(handle.getValue(), currentTags);
  }

  function getCurrentTags(): string[] {
    return [...currentTags];
  }

  function renderTagRow() {
    if (!shell) {
      return;
    }
    shell.setTags(currentTags);
    tagInputEl = shell.refs.getTagInputEl();
    if (!tagInputEl) {
      return;
    }
    tagInputEl.onfocus = () => {
      if (tagInputEl) {
        checkTagInput(tagInputEl, currentTags, handleTagSelected);
      }
    };
    tagInputEl.oninput = () => {
      if (!tagInputEl) {
        return;
      }
      const normalized = normalizeTagInput(tagInputEl.value);
      if (tagInputEl.value !== normalized) {
        tagInputEl.value = normalized;
      }
      checkTagInput(tagInputEl, currentTags, handleTagSelected);
    };
    tagInputEl.onblur = () => {
      setTimeout(() => {
        if (document.activeElement !== tagInputEl) {
          hideTagAutocomplete();
        }
      }, 0);
    };
    tagInputEl.onkeydown = (e) => {
      if (!tagInputEl) {
        return;
      }
      if (e.key === "Backspace" && tagInputEl.value === "" && currentTags.length > 0) {
        e.preventDefault();
        hideTagAutocomplete();
        currentTags = currentTags.slice(0, -1);
        renderTagRow();
        syncSourceFromTags();
        onEditorTabMutation();
        tagInputEl?.focus();
      }
    };
  }

  function setCurrentTags(tags: readonly string[]) {
    currentTags = [...tags];
    renderTagRow();
  }

  function syncSourceFromTags() {
    if (!handle || !handle.isSourceMode) {
      return;
    }
    const parsed = splitFrontmatter(handle.sourceEl.value);
    const body = parsed.hasFrontmatter ? parsed.body : handle.sourceEl.value;
    handle.sourceEl.value = withFrontmatter(body, currentTags);
  }

  function handleTagSelected(tag: string) {
    rememberTags([tag]);
    if (!currentTags.includes(tag)) {
      currentTags = [...currentTags, tag].toSorted();
      renderTagRow();
    }
    syncSourceFromTags();
    onEditorTabMutation();
    tagInputEl?.focus();
  }

  function scheduleAutosave() {
    if (autosaveTimer !== null) {
      clearTimeout(autosaveTimer);
    }
    autosaveTimer = setTimeout(tryAutosave, AUTOSAVE_DELAY_MS);
  }

  function tryAutosave() {
    autosaveTimer = null;
    // Defer if the user has an active selection — they may be mid-formatting.
    if (handle && !handle.isSourceMode) {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && handle.contentEl.contains(sel.anchorNode)) {
        autosaveTimer = setTimeout(tryAutosave, AUTOSAVE_RETRY_DELAY_MS);
        return;
      }
    }
    saveCurrentNote({ silent: true });
  }

  async function saveCurrentNote(opts?: { silent?: boolean }) {
    if (saving) {
      return;
    }
    if (autosaveTimer !== null) {
      clearTimeout(autosaveTimer);
      autosaveTimer = null;
    }
    saving = true;
    try {
      await _doSave(opts?.silent ?? false);
    } finally {
      saving = false;
    }
  }

  async function _doSave(silent: boolean) {
    if (!currentPath || !handle) {
      return;
    }
    const savePath = currentPath;
    const tab = getTabs().find((t) => t.path === savePath) ?? getActiveTab();
    if (!tab) {
      return;
    }

    if (!tab.dirty) {
      return;
    }

    const content = getCurrentContent();
    const contentChanged = content !== tab.lastSavedMd;
    if (!contentChanged) {
      return;
    }

    // Capture cursor synchronously before the first await
    const cursorOffset = handle.isSourceMode ? -1 : handle.getCursorOffset();

    if (contentChanged) {
      const result = await saveNote(savePath, content, tab.mtime);
      const action = classifySaveResult(result, content, tab.lastSavedMd);

      switch (action.type) {
        case "clean": {
          markClean(savePath, action.content, action.mtime);
          emit("files:changed", { savedPath: savePath });
          break;
        }
        case "false-conflict": {
          const retry = await forceSaveNote(savePath, content);
          markClean(savePath, content, retry.mtime);
          emit("files:changed", { savedPath: savePath });
          break;
        }
        case "real-conflict": {
          if (!silent && container) {
            showConflictBanner(
              container,
              currentPath,
              action.diskContent,
              action.diskMtime,
              loadContent,
              getCurrentContent,
            );
          }
          return;
        }
        default: {
          return;
        }
      }
    }

    if (cursorOffset >= 0) {
      setCursor(savePath, cursorOffset);
    }
  }

  function reloadFromDisk(content: string, mtime: number) {
    const tab = getActiveTab();
    if (!tab || !currentPath) {
      return;
    }

    const action = classifyReload(tab.dirty);

    if (action.type === "load") {
      // Skip re-render when the SSE is bouncing our own save back.
      if (tab.lastSavedMd !== content && getCurrentContent() !== content) {
        loadContent(content);
      }
      markClean(currentPath, content, mtime);
      return;
    }

    if (container) {
      handleReloadConflict(
        tab,
        container,
        currentPath,
        content,
        mtime,
        loadContent,
        getCurrentContent,
      );
    }
  }

  function loadContent(markdown: string, explicitOffset?: number) {
    if (!handle) {
      return;
    }
    const parsed = splitFrontmatter(markdown);
    if (handle.isSourceMode) {
      const pos = handle.sourceEl.selectionStart;
      handle.sourceEl.value = markdown;
      handle.sourceEl.selectionStart = pos;
      handle.sourceEl.selectionEnd = pos;
    } else {
      const focused =
        handle.contentEl === document.activeElement ||
        handle.contentEl.contains(document.activeElement);
      const offset = explicitOffset ?? (focused ? handle.getCursorOffset() : -1);
      if (offset >= 0) {
        handle.setValue(parsed.body, offset);
        if (explicitOffset !== undefined) {
          // Scroll saved cursor position into view when opening a note
          const sel = window.getSelection();
          if (sel && sel.rangeCount > 0) {
            const range = sel.getRangeAt(0);
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
      setCurrentTags(parsed.tags);
    }
  }

  function toggleSourceMode() {
    if (!handle) {
      return;
    }
    hideRevisions();
    hideTagAutocomplete();

    if (handle.isSourceMode) {
      // Leaving source mode: strip frontmatter so library re-renders body only,
      // then sync tags from whatever was edited in source.
      const md = handle.sourceEl.value;
      const parsed = splitFrontmatter(md);
      setCurrentTags(parsed.hasFrontmatter ? parsed.tags : []);
      handle.sourceEl.value = parsed.hasFrontmatter ? parsed.body : md;
      handle.toggleSourceMode();
    } else {
      // Entering source mode: capture body before toggle, then inject full content
      // with frontmatter. (After toggleSourceMode the library has set sourceEl.value
      // to the body-only value, so getCurrentContent() would read back that partial value.)
      const body = handle.getValue();
      handle.toggleSourceMode();
      handle.sourceEl.value = withFrontmatter(body, currentTags);
    }
    shell?.setSourceMode(handle.isSourceMode);
  }

  function onEditorTabMutation() {
    if (currentPath) {
      updateTabDraft(currentPath, { content: getCurrentContent(), tags: getCurrentTags() });
    }
    scheduleAutosave();
    if (handle && !handle.isSourceMode) {
      checkWikiLinkTrigger(handle.contentEl, currentPath);
    }
  }

  function showEditor(path: string, content: string, tags: string[] = []) {
    if (autosaveTimer !== null) {
      clearTimeout(autosaveTimer);
      autosaveTimer = null;
      void saveCurrentNote({ silent: true });
    }
    currentPath = path;
    hideRevisions();
    hideAutocomplete();
    hideTagAutocomplete();
    currentTags = [...tags];

    const emptyState = document.querySelector<HTMLElement>("#empty-state");
    if (emptyState) {
      emptyState.style.display = "none";
    }

    handle?.destroy();
    handle = null;

    shellHost?.remove();
    shellHost = document.createElement("div");
    editorArea.append(shellHost);

    shell = mountEditorShell({
      root: shellHost,
      tags: currentTags,
      isSourceMode: false,
    });

    ({ containerEl: container, backlinksEl, revisionsEl } = shell.refs);
    tagInputEl = shell.refs.getTagInputEl();

    shell.refs.sourceBtnEl.onclick = () => {
      toggleSourceMode();
    };
    shell.refs.menuBtnEl.onclick = () => {
      const rect = shell?.refs.menuBtnEl.getBoundingClientRect();
      if (!rect) {
        return;
      }
      showContextMenu(
        [
          {
            label: "Revisions",
            onclick: () => {
              if (currentPath && revisionsEl) {
                toggleRevisions({
                  path: currentPath,
                  host: revisionsEl,
                  getCurrentContent: getCurrentContent,
                  onHide: () => {
                    if (revisionsEl) {
                      revisionsEl.style.display = "none";
                    }
                    if (handle) {
                      if (handle.isSourceMode) {
                        handle.sourceEl.style.display = "";
                      } else {
                        handle.contentEl.style.display = "";
                      }
                    }
                  },
                });
                if (isRevisionsOpen() && handle) {
                  handle.contentEl.style.display = "none";
                  handle.sourceEl.style.display = "none";
                  if (revisionsEl) {
                    revisionsEl.style.display = "";
                  }
                }
              }
            },
          },
        ],
        rect.left,
        rect.bottom + 4,
      );
    };
    shell.refs.tagRowEl.onclick = (e) => {
      const target = e.target as HTMLElement | null;
      const removeBtn = target?.closest<HTMLButtonElement>(".tag-pill-remove");
      if (removeBtn?.dataset["tagRemove"]) {
        e.preventDefault();
        e.stopPropagation();
        hideTagAutocomplete();
        currentTags = currentTags.filter((current) => current !== removeBtn.dataset["tagRemove"]);
        renderTagRow();
        syncSourceFromTags();
        onEditorTabMutation();
        tagInputEl?.focus();
        return;
      }
      tagInputEl?.focus();
    };

    handle = createEditor(shell.refs.editorMountEl, {
      extensions: editorExtensions,
      onChange: onEditorTabMutation,
      onImagePaste: async (blob) => {
        const now = new Date();
        const ts =
          now.getFullYear().toString() +
          String(now.getMonth() + 1).padStart(2, "0") +
          String(now.getDate()).padStart(2, "0") +
          String(now.getHours()).padStart(2, "0") +
          String(now.getMinutes()).padStart(2, "0") +
          String(now.getSeconds()).padStart(2, "0");
        const noteName = currentPath ? stemFromPath(currentPath) : "image";
        const filename = `${noteName} ${ts}.webp`;
        try {
          const savedName = await uploadImage(blob, filename);
          const src = `/z-images/${encodeURIComponent(savedName)}`;
          return `<img src="${escapeHtml(src)}" alt="${escapeHtml(savedName)}" data-wiki-image="${escapeHtml(savedName)}" loading="lazy">`;
        } catch {
          return null;
        }
      },
    });

    // Apply tansu-specific classes so existing CSS continues to work.
    handle.contentEl.className = "editor-content";
    handle.contentEl.spellcheck = true;
    handle.sourceEl.className = "editor-source";

    // Wire save and format keyboard shortcuts on contentEl (beyond what the library handles).
    handle.contentEl.addEventListener("keydown", (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === "s") {
        e.preventDefault();
        e.stopPropagation();
        saveCurrentNote();
        return;
      }
      if (meta && e.key === "b") {
        e.preventDefault();
        handle!.applyFormat(toggleBold);
        return;
      }
      if (meta && e.key === "i") {
        e.preventDefault();
        handle!.applyFormat(toggleItalic);
        return;
      }
      if (meta && e.key === "h") {
        e.preventDefault();
        handle!.applyFormat(toggleHighlight);
        return;
      }
    });

    handle.sourceEl.addEventListener("keydown", (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === "s") {
        e.preventDefault();
        e.stopPropagation();
        saveCurrentNote();
        return;
      }
    });

    if (formatToolbarCleanup) {
      formatToolbarCleanup();
    }
    formatToolbarCleanup = initFormatToolbar({
      contentEl: handle.contentEl,
      applyIndent: (dedent) => handle!.applyFormat((md, s, e) => shiftIndent(md, s, e, dedent)),
      applySourceFormat: (transform) => handle!.applyFormat(transform),
      onMutation: onEditorTabMutation,
    });

    const fmtGroup = shell.refs.fmtGroupEl;
    populateFormatButtons(fmtGroup, {
      applyIndent: (dedent) => handle!.applyFormat((md, s, e) => shiftIndent(md, s, e, dedent)),
      applySourceFormat: (transform) => handle!.applyFormat(transform),
      afterInline: onEditorTabMutation,
      afterBlock: onEditorTabMutation,
    });
    renderTagRow();

    const cursor = getCursor(path);
    loadContent(content, cursor);
    initImageResize(handle.contentEl, onEditorTabMutation);
    loadBacklinks(backlinksEl, path);
    handle.focus();
  }

  function hideEditor() {
    if (autosaveTimer !== null) {
      clearTimeout(autosaveTimer);
      autosaveTimer = null;
      void saveCurrentNote({ silent: true });
    }
    currentPath = null;
    hideRevisions();
    hideAutocomplete();
    hideTagAutocomplete();
    currentTags = [];

    if (formatToolbarCleanup) {
      formatToolbarCleanup();
      formatToolbarCleanup = null;
    }

    handle?.destroy();
    handle = null;

    container = null;
    backlinksEl = null;
    shell?.dispose();
    shell = null;
    shellHost?.remove();
    shellHost = null;
    tagInputEl = null;
    revisionsEl = null;

    const emptyState = document.querySelector("#empty-state") as HTMLElement | null;
    if (emptyState) {
      emptyState.style.display = "flex";
    }
  }

  return { showEditor, hideEditor, getCurrentContent, saveCurrentNote, reloadFromDisk };
}
