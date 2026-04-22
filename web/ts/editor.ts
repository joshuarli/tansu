import {
  checkInlineTransform,
  renderMarkdown,
  renderMarkdownWithCursor,
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
import { markDirty, markClean, getActiveTab, getTabs, setCursor, getCursor } from "./tabs.ts";

let editorArea: HTMLElement;
let container: HTMLElement | null = null;
let contentEl: HTMLElement | null = null;
let sourceEl: HTMLTextAreaElement | null = null;
let backlinksEl: HTMLElement | null = null;
let revisionsEl: HTMLElement | null = null;
let isSourceMode = false;
let currentPath: string | null = null;
const INDENT_UNIT = "\t";
const TAB_CLASS = "md-tab";
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
  if (autosaveTimer !== null) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
    void saveCurrentNote({ silent: true });
  }
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

  const cursor = getCursor(path);
  loadContent(content, cursor);
  setupEditorEvents();
  loadBacklinks(backlinksEl, path);
  contentEl.focus();
}

export function hideEditor() {
  if (autosaveTimer !== null) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
    void saveCurrentNote({ silent: true });
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
  if (!currentPath) return;
  const savePath = currentPath;
  const tab = getTabs().find((t) => t.path === savePath) ?? getActiveTab();
  if (!tab) return;

  const content = getCurrentContent();
  // Capture cursor synchronously before the first await
  const cursorOffset = isSourceMode ? -1 : saveCursorOffset();

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
    if (getCurrentContent() !== content) loadContent(content);
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
  pre.setEnd(range.startContainer, clampNodeOffset(range.startContainer, range.startOffset));
  const fragment = pre.cloneContents();
  const container = document.createElement("div");
  container.appendChild(fragment);
  return domToMarkdown(container).length;
}

function restoreCursorOffset(offset: number, markdown: string, scroll = false) {
  if (!contentEl || offset < 0) return;
  contentEl.innerHTML = renderMarkdownWithCursor(markdown, offset);
  restoreCursorMarker(scroll);
}

function restoreCursorMarker(scroll = false) {
  if (!contentEl) return;
  const sel = window.getSelection();
  if (!sel) return;
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
  if (scroll) marker.parentElement?.scrollIntoView({ block: "center", behavior: "instant" });
  marker.remove();
}

function loadContent(markdown: string, explicitOffset?: number) {
  if (isSourceMode && sourceEl) {
    const pos = sourceEl.selectionStart;
    sourceEl.value = markdown;
    sourceEl.selectionStart = sourceEl.selectionEnd = pos;
  } else if (contentEl) {
    const focused =
      contentEl === document.activeElement || contentEl.contains(document.activeElement);
    const offset = explicitOffset ?? (focused ? saveCursorOffset() : -1);
    if (offset >= 0) restoreCursorOffset(offset, markdown, explicitOffset !== undefined);
    else contentEl.innerHTML = renderMarkdown(markdown);
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

    if (e.key === "Tab") {
      if (handleContentTabKey(e)) return;
    }

    if (e.key === "Backspace") {
      if (handleEmptyListItemBackspace(e)) return;
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
      return;
    }

    if (e.key === "Tab") handleSourceTabKey(e);
  });
}

function handleSourceTabKey(e: KeyboardEvent): boolean {
  if (!sourceEl) return false;

  e.preventDefault();
  const value = sourceEl.value;
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
  const transformed = e.shiftKey ? lines.map(dedentLine) : lines.map((line) => INDENT_UNIT + line);

  sourceEl.setRangeText(transformed.join("\n"), lineStart, lineEnd, "select");
  sourceEl.selectionStart = lineStart;
  sourceEl.selectionEnd = lineStart + transformed.join("\n").length;
  onEditorTabMutation();
  return true;
}

function handleContentTabKey(e: KeyboardEvent): boolean {
  if (!contentEl) return false;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  if (!contentEl.contains(range.startContainer) || !contentEl.contains(range.endContainer)) {
    return false;
  }

  e.preventDefault();

  const listItem = getListItemBlock(range.startContainer);
  if (range.collapsed && listItem) {
    const marker = insertMarker(range);
    if (e.shiftKey) dedentListItems([listItem]);
    else indentListItems([listItem]);
    restoreCollapsedSelection(marker);
    onEditorTabMutation();
    return true;
  }

  if (range.collapsed && !e.shiftKey) {
    insertTabAtRange(range);
    onEditorTabMutation();
    return true;
  }

  const targetRange = range.cloneRange();
  const blocks = getSelectedBlocks(targetRange);
  if (blocks.length === 0) {
    if (e.shiftKey) return true;
    insertTabAtRange(range);
    onEditorTabMutation();
    return true;
  }

  if (blocks.every(isListItemBlock)) {
    const endMarker = insertBoundaryMarker(range, "end");
    const startMarker = insertBoundaryMarker(range, "start");
    if (e.shiftKey) dedentListItems(blocks);
    else indentListItems(blocks);
    restoreSelectionFromMarkers(startMarker, endMarker);
    onEditorTabMutation();
    return true;
  }

  if (e.shiftKey) {
    const endMarker = insertBoundaryMarker(range, "end");
    const startMarker = insertBoundaryMarker(range, "start");
    for (const block of blocks) dedentBlock(block);
    restoreSelectionFromMarkers(startMarker, endMarker);
  } else {
    const endMarker = insertBoundaryMarker(range, "end");
    const startMarker = insertBoundaryMarker(range, "start");
    for (const block of blocks) indentBlock(block);
    restoreSelectionFromMarkers(startMarker, endMarker);
  }

  onEditorTabMutation();
  return true;
}

function handleEmptyListItemBackspace(e: KeyboardEvent): boolean {
  if (!contentEl) return false;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;

  const range = sel.getRangeAt(0);
  if (!contentEl.contains(range.startContainer)) return false;

  const listItem = getListItemBlock(range.startContainer);
  if (!listItem) return false;
  if (!isRangeAtStartOfBlock(range, listItem)) return false;
  if (!isListItemEmpty(listItem)) return false;

  e.preventDefault();
  if (isNestedListItem(listItem)) {
    const marker = insertMarker(range);
    dedentListItems([listItem]);
    restoreCollapsedSelection(marker);
  } else {
    removeEmptyTopLevelListItem(listItem);
  }
  onEditorTabMutation();
  return true;
}

function onEditorTabMutation() {
  if (currentPath) markDirty(currentPath);
  scheduleAutosave();
  if (contentEl && !isSourceMode) checkWikiLinkTrigger(contentEl, currentPath);
}

function createTabNode(): HTMLSpanElement {
  const tab = document.createElement("span");
  tab.className = TAB_CLASS;
  tab.textContent = INDENT_UNIT;
  return tab;
}

function insertTabAtRange(range: Range) {
  const tab = createTabNode();
  range.deleteContents();
  range.insertNode(tab);
  const sel = window.getSelection();
  if (!sel) return;
  const next = document.createRange();
  next.setStartAfter(tab);
  next.collapse(true);
  sel.removeAllRanges();
  sel.addRange(next);
}

function isIndentableBlock(el: HTMLElement): boolean {
  if (el === contentEl) return false;
  if (!INDENTABLE_BLOCKS.has(el.tagName)) return false;
  return el.tagName !== "CODE" || el.parentElement?.tagName === "PRE";
}

function isListItemBlock(el: HTMLElement): boolean {
  return (
    el.tagName === "LI" &&
    (el.parentElement?.tagName === "UL" || el.parentElement?.tagName === "OL")
  );
}

function isNestedListItem(el: HTMLElement): boolean {
  return isListItemBlock(el) && el.parentElement?.parentElement?.tagName === "LI";
}

function getIndentableBlock(node: Node): HTMLElement | null {
  let current: Node | null = node;
  while (current && current !== contentEl) {
    if (current instanceof HTMLElement && isIndentableBlock(current)) return current;
    current = current.parentNode;
  }
  return null;
}

function getSelectedBlocks(range: Range): HTMLElement[] {
  if (!contentEl) return [];

  const blocks: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_ELEMENT);
  let node: Node | null = walker.currentNode;
  while (node) {
    if (node instanceof HTMLElement && isIndentableBlock(node) && range.intersectsNode(node)) {
      if (!seen.has(node)) {
        seen.add(node);
        blocks.push(node);
      }
    }
    node = walker.nextNode();
  }

  if (blocks.length > 0) return blocks;
  const block = getIndentableBlock(range.startContainer);
  return block ? [block] : [];
}

function getListItemBlock(node: Node): HTMLElement | null {
  const block = getIndentableBlock(node);
  return block && isListItemBlock(block) ? block : null;
}

function indentBlock(block: HTMLElement) {
  block.insertBefore(createTabNode(), block.firstChild);
}

function dedentBlock(block: HTMLElement) {
  const first = block.firstChild;
  if (!first) return;

  if (
    first instanceof HTMLElement &&
    first.classList.contains(TAB_CLASS) &&
    (first.textContent ?? "") === INDENT_UNIT
  ) {
    first.remove();
    return;
  }

  if (first.nodeType !== Node.TEXT_NODE) return;

  const text = first.textContent ?? "";
  if (text.startsWith(INDENT_UNIT)) {
    first.textContent = text.slice(INDENT_UNIT.length);
    return;
  }

  const match = text.match(/^[ \u00A0]{1,4}/);
  if (match) first.textContent = text.slice(match[0].length);
}

function isListItemEmpty(item: HTMLElement): boolean {
  const clone = item.cloneNode(true) as HTMLElement;
  for (const nested of clone.querySelectorAll("ul, ol")) nested.remove();
  const text = (clone.textContent ?? "")
    .replace(/\u200B/g, "")
    .replace(/\u00A0/g, " ")
    .trim();
  return text === "";
}

function indentListItems(items: readonly HTMLElement[]) {
  const groups = groupSiblingListItems(items);

  for (const group of groups) {
    const first = group.items[0];
    if (!first) continue;

    const previous = first.previousElementSibling;
    if (!(previous instanceof HTMLElement) || previous.tagName !== "LI") continue;

    const nestedList = ensureNestedList(previous, group.parent.tagName);
    for (const item of group.items) nestedList.appendChild(item);
  }
}

function dedentListItems(items: readonly HTMLElement[]) {
  const groups = groupSiblingListItems(items);

  for (const group of groups) {
    const parentList = group.parent;
    const parentItem = parentList.parentElement;
    if (!(parentItem instanceof HTMLElement) || parentItem.tagName !== "LI") continue;

    const grandList = parentItem.parentElement;
    if (
      !(grandList instanceof HTMLElement) ||
      (grandList.tagName !== "UL" && grandList.tagName !== "OL")
    ) {
      continue;
    }

    const lastSelected = group.items[group.items.length - 1];
    if (!lastSelected) continue;
    const trailingSiblings = collectTrailingListSiblings(lastSelected);
    let insertAfter: HTMLElement = parentItem;

    for (const item of group.items) {
      insertAfter.insertAdjacentElement("afterend", item);
      insertAfter = item;
    }

    if (trailingSiblings.length > 0) {
      const nestedList = ensureNestedList(insertAfter, parentList.tagName);
      for (const sibling of trailingSiblings) nestedList.appendChild(sibling);
    }

    if (!parentList.children.length) parentList.remove();
  }
}

function groupSiblingListItems(
  items: readonly HTMLElement[],
): Array<{ parent: HTMLElement; items: HTMLElement[] }> {
  const groups: Array<{ parent: HTMLElement; items: HTMLElement[] }> = [];
  let current: { parent: HTMLElement; items: HTMLElement[] } | null = null;

  for (const item of items) {
    const parent = item.parentElement;
    if (!(parent instanceof HTMLElement) || (parent.tagName !== "UL" && parent.tagName !== "OL"))
      continue;

    const previous: HTMLElement | null = current
      ? (current.items[current.items.length - 1] ?? null)
      : null;
    if (current && current.parent === parent && isAdjacentSibling(previous, item)) {
      current.items.push(item);
      continue;
    }

    current = { parent, items: [item] };
    groups.push(current);
  }

  return groups;
}

function ensureNestedList(parentItem: HTMLElement, tagName: string): HTMLElement {
  const last = parentItem.lastElementChild;
  if (last instanceof HTMLElement && last.tagName === tagName) return last;
  const list = document.createElement(tagName.toLowerCase());
  parentItem.appendChild(list);
  return list;
}

function collectTrailingListSiblings(item: HTMLElement): HTMLElement[] {
  const trailing: HTMLElement[] = [];
  let current = item.nextElementSibling;
  while (current) {
    const next = current.nextElementSibling;
    if (current instanceof HTMLElement && current.tagName === "LI") trailing.push(current);
    current = next;
  }
  return trailing;
}

function isAdjacentSibling(previous: HTMLElement | null, item: HTMLElement): boolean {
  return previous !== null && getNextListElementSibling(previous) === item;
}

function getNextListElementSibling(node: Node): HTMLElement | null {
  let current = node.nextSibling;
  while (current) {
    if (current instanceof HTMLElement) return current;
    current = current.nextSibling;
  }
  return null;
}

function getPreviousListElementSibling(node: Node): HTMLElement | null {
  let current = node.previousSibling;
  while (current) {
    if (current instanceof HTMLElement) return current;
    current = current.previousSibling;
  }
  return null;
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
    paragraph.appendChild(document.createElement("br"));
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

function placeCursorAtBlockStart(block: HTMLElement) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(block);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function placeCursorAtBlockEnd(block: HTMLElement) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(block);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function placeCursorAtEnd() {
  if (!contentEl) return;
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(contentEl);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function isRangeAtStartOfBlock(range: Range, block: HTMLElement): boolean {
  const before = range.cloneRange();
  before.selectNodeContents(block);
  before.setEnd(range.startContainer, clampNodeOffset(range.startContainer, range.startOffset));
  return before.toString().replace(/\u200B/g, "") === "";
}

function createMarker(kind: "start" | "end" | "cursor"): HTMLSpanElement {
  const marker = document.createElement("span");
  marker.setAttribute("data-tab-marker", kind);
  return marker;
}

function insertMarker(range: Range): HTMLSpanElement {
  const marker = createMarker("cursor");
  range.insertNode(marker);
  return marker;
}

function insertBoundaryMarker(range: Range, kind: "start" | "end"): HTMLSpanElement {
  const marker = createMarker(kind);
  const boundary = range.cloneRange();
  boundary.collapse(kind === "start");
  boundary.insertNode(marker);
  return marker;
}

function restoreCollapsedSelection(marker: HTMLElement) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.setStartAfter(marker);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  marker.remove();
}

function restoreSelectionFromMarkers(startMarker: HTMLElement, endMarker: HTMLElement) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.setStartAfter(startMarker);
  range.setEndBefore(endMarker);
  sel.removeAllRanges();
  sel.addRange(range);
  startMarker.remove();
  endMarker.remove();
}

function dedentLine(line: string): string {
  if (line.startsWith(INDENT_UNIT)) return line.slice(INDENT_UNIT.length);
  const match = line.match(/^[ ]{1,4}/);
  return match ? line.slice(match[0].length) : line;
}

function clampNodeOffset(node: Node, offset: number): number {
  if (offset < 0) return 0;
  if (node.nodeType === Node.TEXT_NODE) {
    return Math.min(offset, node.textContent?.length ?? 0);
  }
  return Math.min(offset, node.childNodes.length);
}
