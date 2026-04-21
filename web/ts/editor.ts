import {
  checkInlineTransform,
  renderMarkdown,
  domToMarkdown,
  checkBlockInputTransform,
  handleBlockTransform,
} from "@joshuarli98/md-wysiwyg";

import { saveNote } from "./api.ts";
import {
  checkWikiLinkTrigger,
  hideAutocomplete,
  invalidateNoteCache as _invalidateNoteCache,
} from "./autocomplete.ts";
import { loadBacklinks } from "./backlinks.ts";
import { showConflictBanner, handleReloadConflict } from "./conflict.ts";
import { on, emit } from "./events.ts";
import { handleImagePaste } from "./image-paste.ts";
import { initImageResize } from "./image-resize.ts";
import { registerLinkHover } from "./link-hover.ts";
import { toggleRevisions, hideRevisions, isRevisionsOpen } from "./revisions.ts";
import { markDirty, markClean, getActiveTab, setCursor, getCursor } from "./tabs.ts";

let editorArea: HTMLElement;
let container: HTMLElement | null = null;
let contentEl: HTMLElement | null = null;
let sourceEl: HTMLTextAreaElement | null = null;
let backlinksEl: HTMLElement | null = null;
let revisionsEl: HTMLElement | null = null;
let isSourceMode = false;
let currentPath: string | null = null;

export { _invalidateNoteCache as invalidateNoteCache };

export function initEditor() {
  editorArea = document.getElementById("editor-area")!;
  registerLinkHover();

  on<{ content: string; mtime: number }>("revision:restore", ({ content, mtime }) => {
    if (currentPath) {
      loadContent(content);
      markClean(currentPath, content, mtime);
    }
  });
}

export function showEditor(path: string, content: string) {
  currentPath = path;
  isSourceMode = false;
  hideRevisions();
  hideAutocomplete();

  const emptyState = document.getElementById("empty-state");
  editorArea.innerHTML = "";
  if (emptyState) editorArea.appendChild(emptyState);
  emptyState!.style.display = "none";

  container = document.createElement("div");
  container.className = "editor-container";

  const toolbar = document.createElement("div");
  toolbar.className = "editor-toolbar";

  const sourceBtn = document.createElement("button");
  sourceBtn.textContent = "Source";
  sourceBtn.title = "Toggle source mode";
  sourceBtn.onclick = () => toggleSourceMode();

  const revBtn = document.createElement("button");
  revBtn.textContent = "Revisions";
  revBtn.onclick = () => {
    if (currentPath && revisionsEl) {
      toggleRevisions({
        path: currentPath,
        host: revisionsEl,
        getCurrentContent: getCurrentContent,
        onHide: () => {
          if (revisionsEl) revisionsEl.style.display = "none";
          if (isSourceMode && sourceEl) sourceEl.style.display = "";
          else if (contentEl) contentEl.style.display = "";
        },
      });
      if (isRevisionsOpen()) {
        if (contentEl) contentEl.style.display = "none";
        if (sourceEl) sourceEl.style.display = "none";
        if (revisionsEl) revisionsEl.style.display = "";
      }
    }
  };

  toolbar.append(sourceBtn, revBtn);
  container.appendChild(toolbar);

  contentEl = document.createElement("div");
  contentEl.className = "editor-content";
  contentEl.contentEditable = "true";
  contentEl.spellcheck = true;
  container.appendChild(contentEl);

  sourceEl = document.createElement("textarea");
  sourceEl.className = "editor-source";
  sourceEl.style.display = "none";
  container.appendChild(sourceEl);

  revisionsEl = document.createElement("div");
  revisionsEl.className = "revisions-container";
  revisionsEl.style.display = "none";
  container.appendChild(revisionsEl);

  backlinksEl = document.createElement("div");
  backlinksEl.className = "backlinks";
  backlinksEl.style.display = "none";

  editorArea.appendChild(container);
  editorArea.appendChild(backlinksEl);

  loadContent(content);
  setupEditorEvents();
  loadBacklinks(backlinksEl, path);
  contentEl.focus();
  const cursor = getCursor(path);
  if (cursor !== undefined) restoreCursorOffset(cursor, true);
}

export function hideEditor() {
  if (autosaveTimer !== null) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
  currentPath = null;
  hideRevisions();
  hideAutocomplete();

  if (container) {
    container.remove();
    container = null;
  }
  if (backlinksEl) {
    backlinksEl.remove();
    backlinksEl = null;
  }
  contentEl = null;
  sourceEl = null;
  revisionsEl = null;
  const emptyState = document.getElementById("empty-state");
  if (emptyState) emptyState.style.display = "flex";
}

export function getCurrentContent(): string {
  if (isSourceMode && sourceEl) {
    return sourceEl.value;
  }
  if (contentEl) {
    return domToMarkdown(contentEl);
  }
  return "";
}

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

let saving = false;
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleAutosave() {
  if (autosaveTimer !== null) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    saveCurrentNote({ silent: true });
  }, 1500);
}

export async function saveCurrentNote(opts?: { silent?: boolean }) {
  if (saving) return;
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
  const tab = getActiveTab();
  if (!tab || !currentPath) return;

  const content = getCurrentContent();
  // Capture cursor synchronously before the first await
  const cursorOffset = isSourceMode ? -1 : saveCursorOffset();
  const savePath = currentPath;

  const result = await saveNote(savePath, content, tab.mtime);
  const action = classifySaveResult(result, content, tab.content);

  switch (action.type) {
    case "clean":
      markClean(savePath, action.content, action.mtime);
      if (cursorOffset >= 0) setCursor(savePath, cursorOffset);
      emit("files:changed", undefined);
      break;
    case "false-conflict": {
      const retry = await saveNote(savePath, content, 0);
      markClean(savePath, content, retry.mtime);
      if (cursorOffset >= 0) setCursor(savePath, cursorOffset);
      emit("files:changed", undefined);
      break;
    }
    case "real-conflict":
      // Suppress banner for background autosaves; next manual save will surface it.
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
      break;
  }
}

type ReloadAction = { type: "load" } | { type: "conflict" };

/// Pure decision: determine how to handle a disk reload.
export function classifyReload(isDirty: boolean): ReloadAction {
  return isDirty ? { type: "conflict" } : { type: "load" };
}

export function reloadFromDisk(content: string, mtime: number) {
  const tab = getActiveTab();
  if (!tab || !currentPath) return;

  const action = classifyReload(tab.dirty);

  if (action.type === "load") {
    loadContent(content);
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

function saveCursorOffset(): number {
  if (!contentEl) return -1;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return -1;
  const range = sel.getRangeAt(0);
  if (!contentEl.contains(range.startContainer)) return -1;
  const pre = range.cloneRange();
  pre.selectNodeContents(contentEl);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

function restoreCursorOffset(offset: number, scroll = false) {
  if (!contentEl || offset < 0) return;
  const sel = window.getSelection();
  if (!sel) return;
  const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (remaining <= node.length) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      if (scroll) node.parentElement?.scrollIntoView({ block: "center", behavior: "instant" });
      return;
    }
    remaining -= node.length;
  }
  // Offset beyond content: place at end
  const range = document.createRange();
  range.selectNodeContents(contentEl);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function loadContent(markdown: string) {
  if (isSourceMode && sourceEl) {
    const pos = sourceEl.selectionStart;
    sourceEl.value = markdown;
    sourceEl.selectionStart = sourceEl.selectionEnd = pos;
  } else if (contentEl) {
    const focused =
      contentEl === document.activeElement || contentEl.contains(document.activeElement);
    const offset = focused ? saveCursorOffset() : -1;
    contentEl.innerHTML = renderMarkdown(markdown);
    if (offset >= 0) restoreCursorOffset(offset);
  }
}

function toggleSourceMode() {
  if (!contentEl || !sourceEl) return;
  hideRevisions();

  if (isSourceMode) {
    const md = sourceEl.value;
    contentEl.innerHTML = renderMarkdown(md);
    contentEl.style.display = "";
    sourceEl.style.display = "none";
    isSourceMode = false;
  } else {
    const md = domToMarkdown(contentEl);
    sourceEl.value = md;
    contentEl.style.display = "none";
    sourceEl.style.display = "";
    isSourceMode = true;
  }

  container?.querySelector(".editor-toolbar button")?.classList.toggle("active", isSourceMode);
}

function setupEditorEvents() {
  if (!contentEl || !sourceEl) return;

  contentEl.addEventListener("input", () => {
    if (currentPath) markDirty(currentPath);
    scheduleAutosave();
    if (contentEl && checkBlockInputTransform(contentEl)) return;
    checkInlineTransform();
    if (contentEl) checkWikiLinkTrigger(contentEl, currentPath);
  });

  sourceEl.addEventListener("input", () => {
    if (currentPath) markDirty(currentPath);
    scheduleAutosave();
  });

  contentEl.addEventListener("keydown", (e) => {
    const meta = e.metaKey || e.ctrlKey;

    if (meta && e.key === "s") {
      e.preventDefault();
      e.stopPropagation();
      saveCurrentNote();
      return;
    }

    if (meta && e.key === "b") {
      e.preventDefault();
      document.execCommand("bold");
      return;
    }

    if (meta && e.key === "i") {
      e.preventDefault();
      document.execCommand("italic");
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      handleBlockTransform(e, contentEl!, () => {
        if (currentPath) markDirty(currentPath);
      });
    }
  });

  contentEl.addEventListener("paste", (e) => {
    e.preventDefault();
    const clipData = e.clipboardData;
    if (!clipData) return;

    const imageItem = Array.from(clipData.items).find((item) => item.type.startsWith("image/"));
    if (imageItem) {
      handleImagePaste(imageItem, currentPath);
      return;
    }

    const text = clipData.getData("text/plain");
    document.execCommand("insertText", false, text);
  });

  initImageResize(contentEl, () => {
    if (currentPath) markDirty(currentPath);
    scheduleAutosave();
  });

  sourceEl.addEventListener("keydown", (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key === "s") {
      e.preventDefault();
      e.stopPropagation();
      saveCurrentNote();
    }
  });
}
