import {
  checkInlineTransform,
  clampNodeOffset,
  CURSOR_SENTINEL,
  domToMarkdown,
  getCursorMarkdownOffset,
  checkBlockInputTransform,
  handleBlockTransform,
} from "@joshuarli98/md-wysiwyg";

import { forceSaveNote, saveNote } from "./api.ts";
import { checkWikiLinkTrigger, hideAutocomplete } from "./autocomplete.ts";
export { invalidateNoteCache } from "./autocomplete.ts";
import { loadBacklinks } from "./backlinks.ts";
import { showConflictBanner, handleReloadConflict } from "./conflict.ts";
import { showContextMenu } from "./context-menu.ts";
import { on, emit } from "./events.ts";
import {
  toggleBold,
  toggleItalic,
  toggleHighlight,
  shiftIndent,
  type FormatResult,
} from "./format-ops.ts";
import { initFormatToolbar, populateFormatButtons } from "./format-toolbar.ts";
import { handleImagePaste } from "./image-paste.ts";
import { initImageResize } from "./image-resize.ts";
import { registerLinkHover } from "./link-hover.ts";
import {
  setContent,
  setContentWithCursor,
  setContentWithSelection,
  restoreSelectionFromRenderedMarkers,
} from "./renderer.ts";
import { toggleRevisions, hideRevisions, isRevisionsOpen } from "./revisions.ts";
import { markDirty, markClean, getActiveTab, getTabs, setCursor, getCursor } from "./tab-state.ts";

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

const INDENT_UNIT = "\t";
const INDENTABLE_BLOCKS = new Set([
  "P",
  "DIV",
  "LI",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "TD",
  "TH",
  "CODE",
]);

function isListItemBlock(el: HTMLElement): boolean {
  return (
    el.tagName === "LI" &&
    (el.parentElement?.tagName === "UL" || el.parentElement?.tagName === "OL")
  );
}

function isNestedListItem(el: HTMLElement): boolean {
  return isListItemBlock(el) && el.parentElement?.parentElement?.tagName === "LI";
}

function isListItemEmpty(item: HTMLElement): boolean {
  const clone = item.cloneNode(true) as HTMLElement;
  for (const nested of clone.querySelectorAll("ul, ol")) {
    nested.remove();
  }
  const text = (clone.textContent ?? "").replaceAll("​", "").replaceAll(" ", " ").trim();
  return text === "";
}

function getNextListElementSibling(node: Node): HTMLElement | null {
  let current = node.nextSibling;
  while (current) {
    if (current instanceof HTMLElement) {
      return current;
    }
    current = current.nextSibling;
  }
  return null;
}

function getPreviousListElementSibling(node: Node): HTMLElement | null {
  let current = node.previousSibling;
  while (current) {
    if (current instanceof HTMLElement) {
      return current;
    }
    current = current.previousSibling;
  }
  return null;
}

function placeCursorAtBlockStart(block: HTMLElement) {
  const sel = window.getSelection();
  if (!sel) {
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(block);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function placeCursorAtBlockEnd(block: HTMLElement) {
  const sel = window.getSelection();
  if (!sel) {
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(block);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function isRangeAtStartOfBlock(range: Range, block: HTMLElement): boolean {
  const before = range.cloneRange();
  before.selectNodeContents(block);
  before.setEnd(range.startContainer, clampNodeOffset(range.startContainer, range.startOffset));
  return before.toString().replaceAll("​", "") === "";
}

function removeEmptyTopLevelListItem(item: HTMLElement) {
  const parentList = item.parentElement;
  if (
    !(parentList instanceof HTMLElement) ||
    (parentList.tagName !== "UL" && parentList.tagName !== "OL")
  ) {
    return;
  }

  const previous = getPreviousListElementSibling(item);
  const next = getNextListElementSibling(item);
  item.remove();

  if (parentList.children.length === 0) {
    const paragraph = document.createElement("p");
    paragraph.append(document.createElement("br"));
    parentList.replaceWith(paragraph);
    placeCursorAtBlockStart(paragraph);
    return;
  }

  if (previous) {
    placeCursorAtBlockEnd(previous);
    return;
  }

  if (next) {
    placeCursorAtBlockStart(next);
    return;
  }

  placeCursorAtBlockEnd(parentList);
}

function dedentLine(line: string): string {
  if (line.startsWith(INDENT_UNIT)) {
    return line.slice(INDENT_UNIT.length);
  }
  const match = line.match(/^[ ]{1,4}/);
  return match ? line.slice(match[0].length) : line;
}

export interface EditorInstance {
  showEditor(path: string, content: string): void;
  hideEditor(): void;
  getCurrentContent(): string;
  saveCurrentNote(opts?: { silent?: boolean }): Promise<void>;
  reloadFromDisk(content: string, mtime: number): void;
}

export function initEditor(): EditorInstance {
  const editorArea = document.querySelector("#editor-area")!;
  registerLinkHover();

  let toolbarEl: HTMLElement | null = null;
  let formatToolbarCleanup: (() => void) | null = null;
  let container: HTMLElement | null = null;
  let contentEl: HTMLElement | null = null;
  let sourceEl: HTMLTextAreaElement | null = null;
  let backlinksEl: HTMLElement | null = null;
  let revisionsEl: HTMLElement | null = null;
  let isSourceMode = false;
  let currentPath: string | null = null;

  interface UndoEntry {
    md: string;
    selStart: number;
    selEnd: number;
  }
  const undoStack: UndoEntry[] = [];
  let undoIndex = -1;
  let typingSnapshotTimer: ReturnType<typeof setTimeout> | null = null;
  let saving = false;
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

  on("revision:restore", ({ content, mtime }) => {
    if (currentPath) {
      loadContent(content);
      markClean(currentPath, content, mtime);
    }
  });

  function getCurrentContent(): string {
    if (isSourceMode && sourceEl) {
      return sourceEl.value;
    }
    if (contentEl) {
      return domToMarkdown(contentEl);
    }
    return "";
  }

  function scheduleAutosave() {
    if (autosaveTimer !== null) {
      clearTimeout(autosaveTimer);
    }
    autosaveTimer = setTimeout(tryAutosave, 1500);
  }

  function tryAutosave() {
    autosaveTimer = null;
    // Defer if the user has an active selection — they may be mid-formatting.
    if (contentEl) {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && contentEl.contains(sel.anchorNode)) {
        autosaveTimer = setTimeout(tryAutosave, 500);
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
    if (!currentPath) {
      return;
    }
    const savePath = currentPath;
    const tab = getTabs().find((t) => t.path === savePath) ?? getActiveTab();
    if (!tab) {
      return;
    }

    const content = getCurrentContent();
    // Capture cursor synchronously before the first await
    const cursorOffset = isSourceMode ? -1 : saveCursorOffset();

    const result = await saveNote(savePath, content, tab.mtime);
    const action = classifySaveResult(result, content, tab.content);

    switch (action.type) {
      case "clean": {
        markClean(savePath, action.content, action.mtime);
        if (cursorOffset >= 0) {
          setCursor(savePath, cursorOffset);
        }
        emit("files:changed");
        break;
      }
      case "false-conflict": {
        const retry = await forceSaveNote(savePath, content);
        markClean(savePath, content, retry.mtime);
        if (cursorOffset >= 0) {
          setCursor(savePath, cursorOffset);
        }
        emit("files:changed");
        break;
      }
      case "real-conflict": {
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
      default: {
        break;
      }
    }
  }

  function reloadFromDisk(content: string, mtime: number) {
    const tab = getActiveTab();
    if (!tab || !currentPath) {
      return;
    }

    const action = classifyReload(tab.dirty);

    if (action.type === "load") {
      if (getCurrentContent() !== content) {
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

  function saveCursorOffset(): number {
    if (!contentEl) {
      return -1;
    }
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) {
      return -1;
    }
    const range = sel.getRangeAt(0);
    if (!contentEl.contains(range.startContainer)) {
      return -1;
    }
    return getCursorMarkdownOffset(contentEl, range);
  }

  /// Get the markdown offsets for the current selection's start and end.
  /// Uses a single domToMarkdown pass with two cursor sentinel spans inserted,
  /// so the first and second CURSOR_SENTINEL positions map to start and end.
  /// Returns null if there is no selection or it is outside contentEl.
  function getSelectionMarkdownOffsets(el: HTMLElement): { start: number; end: number } | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      return null;
    }
    const range = sel.getRangeAt(0);
    if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) {
      return null;
    }

    // Insert end marker first (higher DOM position → inserting it doesn't shift start).
    const endMarker = document.createElement("span");
    endMarker.dataset["mdCursor"] = "true";
    const endRange = range.cloneRange();
    endRange.collapse(false);
    endRange.insertNode(endMarker);

    const startMarker = document.createElement("span");
    startMarker.dataset["mdCursor"] = "true";
    const startRange = range.cloneRange();
    startRange.collapse(true);
    startRange.insertNode(startMarker);

    const md = domToMarkdown(el);

    // Both markers serialize as CURSOR_SENTINEL. Find them in order.
    const firstIdx = md.indexOf(CURSOR_SENTINEL);
    const secondIdx = firstIdx !== -1 ? md.indexOf(CURSOR_SENTINEL, firstIdx + 1) : -1;

    const startParent = startMarker.parentNode;
    const endParent = endMarker.parentNode;
    startMarker.remove();
    endMarker.remove();
    startParent?.normalize();
    if (endParent && endParent !== startParent) {
      endParent.normalize();
    }

    // Restore selection
    try {
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {
      // Ignore if range is no longer valid
    }

    if (firstIdx === -1) {
      return null;
    }
    const start = firstIdx;
    // If collapsed, secondIdx will be -1; treat as collapsed selection
    const end = secondIdx !== -1 ? secondIdx - 1 : start; // -1 because first sentinel char was removed
    return { start, end };
  }

  function restoreCursorOffset(offset: number, markdown: string, scroll = false) {
    if (!contentEl || offset < 0) {
      return;
    }
    setContentWithCursor(contentEl, markdown, offset);
    restoreCursorMarker(scroll);
  }

  function restoreCursorMarker(scroll = false) {
    if (!contentEl) {
      return;
    }
    const sel = window.getSelection();
    if (!sel) {
      return;
    }
    const marker = contentEl.querySelector('[data-md-cursor="true"]');
    if (!(marker instanceof HTMLElement)) {
      placeCursorAtEnd();
      return;
    }
    const range = document.createRange();
    range.setStartBefore(marker);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    if (scroll) {
      marker.parentElement?.scrollIntoView({ block: "center", behavior: "instant" });
    }
    marker.remove();
  }

  function loadContent(markdown: string, explicitOffset?: number) {
    if (isSourceMode && sourceEl) {
      const pos = sourceEl.selectionStart;
      sourceEl.value = markdown;
      sourceEl.selectionStart = pos;
      sourceEl.selectionEnd = pos;
    } else if (contentEl) {
      const focused =
        contentEl === document.activeElement || contentEl.contains(document.activeElement);
      const offset = explicitOffset ?? (focused ? saveCursorOffset() : -1);
      if (offset >= 0) {
        restoreCursorOffset(offset, markdown, explicitOffset !== undefined);
      } else {
        setContent(contentEl, markdown);
      }
    }
  }

  function toggleSourceMode() {
    if (!contentEl || !sourceEl) {
      return;
    }
    hideRevisions();

    if (isSourceMode) {
      const md = sourceEl.value;
      setContent(contentEl, md);
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

    toolbarEl
      ?.querySelector(".editor-toolbar-btn--source")
      ?.classList.toggle("active", isSourceMode);
    const fmtGroup = toolbarEl?.querySelector(".editor-toolbar-fmt-group") as HTMLElement | null;
    if (fmtGroup) {
      fmtGroup.style.display = isSourceMode ? "none" : "flex";
    }
  }

  function isIndentableBlock(el: HTMLElement): boolean {
    if (el === contentEl) {
      return false;
    }
    if (!INDENTABLE_BLOCKS.has(el.tagName)) {
      return false;
    }
    return el.tagName !== "CODE" || el.parentElement?.tagName === "PRE";
  }

  function getIndentableBlock(node: Node): HTMLElement | null {
    let current: Node | null = node;
    while (current && current !== contentEl) {
      if (current instanceof HTMLElement && isIndentableBlock(current)) {
        return current;
      }
      current = current.parentNode;
    }
    return null;
  }

  function getListItemBlock(node: Node): HTMLElement | null {
    const block = getIndentableBlock(node);
    return block && isListItemBlock(block) ? block : null;
  }

  function placeCursorAtEnd() {
    if (!contentEl) {
      return;
    }
    const sel = window.getSelection();
    if (!sel) {
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(contentEl);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function onEditorTabMutation() {
    if (currentPath) {
      markDirty(currentPath);
    }
    scheduleAutosave();
    if (contentEl && !isSourceMode) {
      checkWikiLinkTrigger(contentEl, currentPath);
    }
  }

  function pushUndo(md: string, selStart: number, selEnd: number): void {
    // Truncate any redo tail
    undoStack.splice(undoIndex + 1);
    undoStack.push({ md, selStart, selEnd });
    if (undoStack.length > 200) {
      undoStack.shift();
    } else {
      undoIndex++;
    }
  }

  function scheduleTypingSnapshot(): void {
    if (typingSnapshotTimer !== null) {
      clearTimeout(typingSnapshotTimer);
    }
    typingSnapshotTimer = setTimeout(() => {
      typingSnapshotTimer = null;
      if (!contentEl) {
        return;
      }
      const md = domToMarkdown(contentEl);
      const sel = getSelectionMarkdownOffsets(contentEl);
      pushUndo(md, sel?.start ?? 0, sel?.end ?? 0);
    }, 1000);
  }

  function applyUndoEntry(idx: number): void {
    const entry = undoStack[idx]!;
    setContentWithSelection(contentEl!, entry.md, entry.selStart, entry.selEnd);
    restoreSelectionFromRenderedMarkers(contentEl!);
    const tab = getActiveTab();
    if (currentPath && tab && entry.md === tab.lastSavedMd) {
      markClean(currentPath, entry.md, tab.mtime);
      if (!isSourceMode) {
        checkWikiLinkTrigger(contentEl!, currentPath);
      }
    } else {
      onEditorTabMutation();
    }
  }

  function undoEdit(): void {
    if (undoIndex <= 0 || !contentEl) {
      return;
    }
    undoIndex--;
    applyUndoEntry(undoIndex);
  }

  function redoEdit(): void {
    if (undoIndex >= undoStack.length - 1 || !contentEl) {
      return;
    }
    undoIndex++;
    applyUndoEntry(undoIndex);
  }

  /// Apply a source-text format transform to the current editor content.
  /// Gets the selection offsets, applies the transform, re-renders, and restores the selection.
  function applySourceFormatInEditor(
    transform: (md: string, s: number, e: number) => FormatResult,
  ): void {
    if (!contentEl) {
      return;
    }
    const sel = getSelectionMarkdownOffsets(contentEl);
    if (!sel) {
      return;
    }
    const md = domToMarkdown(contentEl);
    // Save before-state to undo stack
    pushUndo(md, sel.start, sel.end);
    const { md: newMd, selStart, selEnd } = transform(md, sel.start, sel.end);
    setContentWithSelection(contentEl, newMd, selStart, selEnd);
    restoreSelectionFromRenderedMarkers(contentEl);
    onEditorTabMutation();
  }

  function applyIndentInEditor(dedent: boolean): void {
    if (!contentEl) {
      return;
    }
    const sel = getSelectionMarkdownOffsets(contentEl);
    if (!sel) {
      return;
    }
    const md = domToMarkdown(contentEl);
    pushUndo(md, sel.start, sel.end);
    const { md: newMd, selStart, selEnd } = shiftIndent(md, sel.start, sel.end, dedent);
    setContentWithSelection(contentEl, newMd, selStart, selEnd);
    restoreSelectionFromRenderedMarkers(contentEl);
    onEditorTabMutation();
  }

  function handleSourceTabKey(e: KeyboardEvent): boolean {
    if (!sourceEl) {
      return false;
    }

    e.preventDefault();
    const { value } = sourceEl;
    const start = sourceEl.selectionStart;
    const end = sourceEl.selectionEnd;

    if (!e.shiftKey && start === end) {
      sourceEl.value = value.slice(0, start) + INDENT_UNIT + value.slice(end);
      sourceEl.selectionStart = start + INDENT_UNIT.length;
      sourceEl.selectionEnd = start + INDENT_UNIT.length;
      onEditorTabMutation();
      return true;
    }

    const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const adjustedEnd = end > start && value[end - 1] === "\n" ? end - 1 : end;
    const nextNewline = value.indexOf("\n", adjustedEnd);
    const lineEnd = nextNewline === -1 ? value.length : nextNewline;
    const lines = value.slice(lineStart, lineEnd).split("\n");
    const transformed = e.shiftKey
      ? lines.map(dedentLine)
      : lines.map((line) => INDENT_UNIT + line);

    sourceEl.setRangeText(transformed.join("\n"), lineStart, lineEnd, "select");
    sourceEl.selectionStart = lineStart;
    sourceEl.selectionEnd = lineStart + transformed.join("\n").length;
    onEditorTabMutation();
    return true;
  }

  function handleEmptyListItemBackspace(e: KeyboardEvent): boolean {
    if (!contentEl) {
      return false;
    }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) {
      return false;
    }

    const range = sel.getRangeAt(0);
    if (!contentEl.contains(range.startContainer)) {
      return false;
    }

    const listItem = getListItemBlock(range.startContainer);
    if (!listItem) {
      return false;
    }
    if (!isRangeAtStartOfBlock(range, listItem)) {
      return false;
    }
    if (!isListItemEmpty(listItem)) {
      return false;
    }

    e.preventDefault();
    if (isNestedListItem(listItem)) {
      const md = domToMarkdown(contentEl);
      const offsets = getSelectionMarkdownOffsets(contentEl);
      if (!offsets) {
        return false;
      }
      pushUndo(md, offsets.start, offsets.end);
      const { md: newMd, selStart, selEnd } = shiftIndent(md, offsets.start, offsets.end, true);
      setContentWithSelection(contentEl, newMd, selStart, selEnd);
      restoreSelectionFromRenderedMarkers(contentEl);
    } else {
      removeEmptyTopLevelListItem(listItem);
    }
    onEditorTabMutation();
    return true;
  }

  function setupEditorEvents() {
    if (!contentEl || !sourceEl) {
      return;
    }

    if (formatToolbarCleanup) {
      formatToolbarCleanup();
    }
    formatToolbarCleanup = initFormatToolbar({
      contentEl,
      applyIndent: applyIndentInEditor,
      applySourceFormat: applySourceFormatInEditor,
      onMutation: onEditorTabMutation,
    });

    contentEl.addEventListener("input", () => {
      if (currentPath) {
        markDirty(currentPath);
      }
      scheduleAutosave();
      scheduleTypingSnapshot();
      if (contentEl && checkBlockInputTransform(contentEl)) {
        return;
      }
      checkInlineTransform();
      if (contentEl) {
        checkWikiLinkTrigger(contentEl, currentPath);
      }
    });

    sourceEl.addEventListener("input", () => {
      if (currentPath) {
        markDirty(currentPath);
      }
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

      if (meta && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undoEdit();
        return;
      }

      if ((meta && e.shiftKey && e.key === "z") || (meta && e.key === "y")) {
        e.preventDefault();
        redoEdit();
        return;
      }

      if (meta && e.key === "b") {
        e.preventDefault();
        applySourceFormatInEditor(toggleBold);
        return;
      }

      if (meta && e.key === "i") {
        e.preventDefault();
        applySourceFormatInEditor(toggleItalic);
        return;
      }

      if (meta && e.key === "h") {
        e.preventDefault();
        applySourceFormatInEditor(toggleHighlight);
        return;
      }

      if (e.key === "Tab") {
        e.preventDefault();
        applyIndentInEditor(e.shiftKey);
        return;
      }

      if (e.key === "Backspace" && handleEmptyListItemBackspace(e)) {
        return;
      }

      if (e.key === "Enter" && !e.shiftKey) {
        handleBlockTransform(e, contentEl!, () => {
          if (currentPath) {
            markDirty(currentPath);
          }
        });
      }
    });

    function htmlToMarkdown(html: string): string {
      const div = document.createElement("div");
      div.setHTML(html);
      return domToMarkdown(div);
    }

    contentEl.addEventListener("paste", (e) => {
      e.preventDefault();
      const clipData = e.clipboardData;
      if (!clipData) {
        return;
      }

      const imageItem = [...clipData.items].find((item) => item.type.startsWith("image/"));
      if (imageItem) {
        handleImagePaste(imageItem, currentPath);
        return;
      }

      const htmlData = clipData.getData("text/html");
      const pastedText = htmlData ? htmlToMarkdown(htmlData) : clipData.getData("text/plain");

      if (pastedText && contentEl) {
        const md = domToMarkdown(contentEl);
        const sel = getSelectionMarkdownOffsets(contentEl);
        const start = sel?.start ?? md.length;
        const end = sel?.end ?? start;
        pushUndo(md, start, end);
        const newMd = md.slice(0, start) + pastedText + md.slice(end);
        const newCursor = start + pastedText.length;
        setContentWithSelection(contentEl, newMd, newCursor, newCursor);
        restoreSelectionFromRenderedMarkers(contentEl);
        onEditorTabMutation();
      }
    });

    initImageResize(contentEl, () => {
      if (currentPath) {
        markDirty(currentPath);
      }
      scheduleAutosave();
    });

    sourceEl.addEventListener("keydown", (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === "s") {
        e.preventDefault();
        e.stopPropagation();
        saveCurrentNote();
        return;
      }

      if (e.key === "Tab") {
        handleSourceTabKey(e);
      }
    });
  }

  function showEditor(path: string, content: string) {
    if (autosaveTimer !== null) {
      clearTimeout(autosaveTimer);
      autosaveTimer = null;
      void saveCurrentNote({ silent: true });
    }
    currentPath = path;
    isSourceMode = false;
    hideRevisions();
    hideAutocomplete();

    const emptyState = document.querySelector<HTMLElement>("#empty-state");
    editorArea.innerHTML = "";
    if (emptyState) {
      editorArea.append(emptyState);
      emptyState.style.display = "none";
    }

    container = document.createElement("div");
    container.className = "editor-container";

    toolbarEl = document.createElement("div");
    toolbarEl.className = "editor-toolbar";

    const sourceBtn = document.createElement("button");
    sourceBtn.className = "editor-toolbar-btn editor-toolbar-btn--source";
    sourceBtn.title = "Toggle source mode";
    sourceBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="5,4 1,8 5,12"/><polyline points="11,4 15,8 11,12"/><line x1="9.5" y1="2" x2="6.5" y2="14"/></svg>`;
    sourceBtn.onclick = () => toggleSourceMode();

    const menuBtn = document.createElement("button");
    menuBtn.className = "editor-toolbar-btn";
    menuBtn.title = "More";
    menuBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="3" width="14" height="2" rx="1"/><rect x="1" y="7" width="14" height="2" rx="1"/><rect x="1" y="11" width="14" height="2" rx="1"/></svg>`;
    menuBtn.onclick = () => {
      const rect = menuBtn.getBoundingClientRect();
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
                    if (isSourceMode && sourceEl) {
                      sourceEl.style.display = "";
                    } else if (contentEl) {
                      contentEl.style.display = "";
                    }
                  },
                });
                if (isRevisionsOpen()) {
                  if (contentEl) {
                    contentEl.style.display = "none";
                  }
                  if (sourceEl) {
                    sourceEl.style.display = "none";
                  }
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

    const fmtGroup = document.createElement("div");
    fmtGroup.className = "editor-toolbar-fmt-group";

    populateFormatButtons(fmtGroup, {
      applyIndent: applyIndentInEditor,
      applySourceFormat: applySourceFormatInEditor,
      afterInline: onEditorTabMutation,
      afterBlock: onEditorTabMutation,
    });

    const toolbarSpacer = document.createElement("div");
    toolbarSpacer.style.flex = "1";

    toolbarEl.append(fmtGroup, toolbarSpacer, sourceBtn, menuBtn);
    editorArea.append(toolbarEl);

    contentEl = document.createElement("div");
    contentEl.className = "editor-content";
    contentEl.contentEditable = "true";
    contentEl.spellcheck = true;
    container.append(contentEl);

    sourceEl = document.createElement("textarea");
    sourceEl.className = "editor-source";
    sourceEl.style.display = "none";
    container.append(sourceEl);

    revisionsEl = document.createElement("div");
    revisionsEl.className = "revisions-container";
    revisionsEl.style.display = "none";
    container.append(revisionsEl);

    backlinksEl = document.createElement("div");
    backlinksEl.className = "backlinks";
    backlinksEl.style.display = "none";

    editorArea.append(container);
    editorArea.append(backlinksEl);

    const cursor = getCursor(path);
    loadContent(content, cursor);
    // Initialize undo stack with the initial content snapshot
    undoIndex = -1;
    undoStack.length = 0;
    pushUndo(content, 0, 0);
    setupEditorEvents();
    loadBacklinks(backlinksEl, path);
    contentEl.focus();
  }

  function hideEditor() {
    if (autosaveTimer !== null) {
      clearTimeout(autosaveTimer);
      autosaveTimer = null;
      void saveCurrentNote({ silent: true });
    }
    if (typingSnapshotTimer !== null) {
      clearTimeout(typingSnapshotTimer);
      typingSnapshotTimer = null;
    }
    undoStack.length = 0;
    undoIndex = -1;
    currentPath = null;
    hideRevisions();
    hideAutocomplete();

    if (formatToolbarCleanup) {
      formatToolbarCleanup();
      formatToolbarCleanup = null;
    }
    if (toolbarEl) {
      toolbarEl.remove();
      toolbarEl = null;
    }
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
    const emptyState = document.querySelector("#empty-state") as HTMLElement | null;
    if (emptyState) {
      emptyState.style.display = "flex";
    }
  }

  return { showEditor, hideEditor, getCurrentContent, saveCurrentNote, reloadFromDisk };
}
