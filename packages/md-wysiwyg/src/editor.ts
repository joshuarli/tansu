/// WYSIWYG editor wiring layer. Creates DOM, manages undo stack, routes keyboard
/// events, and handles image paste. All markdown-specific behavior is delegated to
/// the render/serialize/transform modules; callers configure extensions and callbacks.

import type { MarkdownExtension } from "./extension.js";
import { shiftIndent, toggleBold, toggleHighlight, toggleItalic } from "./format-ops.js";
import type { FormatResult } from "./format-ops.js";
import { checkInlineTransform } from "./inline-transforms.js";
import {
  renderMarkdown,
  renderMarkdownWithCursor,
  renderMarkdownWithSelection,
} from "./markdown.js";
import { domToMarkdown, getCursorMarkdownOffset } from "./serialize.js";
import { checkBlockInputTransform, handleBlockTransform } from "./transforms.js";
import { clampNodeOffset, CURSOR_SENTINEL } from "./util.js";

const MAX_INDENT_SPACES = 4;
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

export type EditorConfig = {
  extensions?: MarkdownExtension[];
  onImagePaste?: (blob: Blob) => Promise<string | null>;
  onChange?: () => void;
  onSave?: () => void;
  contentClassName?: string;
  sourceClassName?: string;
  undoStackMax?: number;
  typingCheckpointMs?: number;
  imageWebpQuality?: number;
  indentUnit?: string;
};

export type EditorHandle = {
  getValue(): string;
  setValue(md: string, cursorOffset?: number): void;
  getSelectionOffsets(): { start: number; end: number } | null;
  getCursorOffset(): number;
  applyFormat(op: (md: string, s: number, e: number) => FormatResult): void;
  undo(): void;
  redo(): void;
  toggleSourceMode(): void;
  focus(): void;
  setConfig(partial: Partial<EditorConfig>): void;
  readonly isSourceMode: boolean;
  readonly contentEl: HTMLElement;
  readonly sourceEl: HTMLTextAreaElement;
  destroy(): void;
};

export function createEditor(container: HTMLElement, config: EditorConfig = {}): EditorHandle {
  let cfg = { ...config };
  const extensions = cfg.extensions ?? [];
  const renderOpts = { extensions };

  const contentEl = document.createElement("div");
  contentEl.contentEditable = "true";
  contentEl.className = cfg.contentClassName ?? "md-editor-content";
  const sourceEl = document.createElement("textarea");
  sourceEl.className = cfg.sourceClassName ?? "md-editor-source";
  sourceEl.style.display = "none";
  container.append(contentEl, sourceEl);

  let _isSourceMode = false;

  interface UndoEntry {
    md: string;
    selStart: number;
    selEnd: number;
  }
  const undoStack: UndoEntry[] = [];
  let undoIndex = -1;
  let typingTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Render helpers ──────────────────────────────────────────────────────────

  function setContent(md: string): void {
    contentEl.innerHTML = renderMarkdown(md, renderOpts);
  }

  function setContentWithCursor(md: string, offset: number): void {
    contentEl.innerHTML = renderMarkdownWithCursor(md, offset, renderOpts);
  }

  function setContentWithSelection(md: string, selStart: number, selEnd: number): void {
    contentEl.innerHTML = renderMarkdownWithSelection(md, selStart, selEnd, renderOpts);
  }

  function restoreSelectionFromRenderedMarkers(): void {
    const startSpan = contentEl.querySelector("[data-md-sel-start]");
    const endSpan = contentEl.querySelector("[data-md-sel-end]");
    if (!(startSpan instanceof HTMLElement) || !(endSpan instanceof HTMLElement)) return;
    const sel = window.getSelection();
    if (!sel) {
      startSpan.remove();
      endSpan.remove();
      return;
    }
    try {
      const r = document.createRange();
      r.setStartAfter(startSpan);
      r.setEndBefore(endSpan);
      sel.removeAllRanges();
      sel.addRange(r);
    } catch {
      /* degrade gracefully */
    }
    startSpan.remove();
    endSpan.remove();
  }

  function restoreCursorMarker(scroll = false): void {
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

  function placeCursorAtEnd(): void {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(contentEl);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // ── Cursor / selection ──────────────────────────────────────────────────────

  function getSelectionOffsets(): { start: number; end: number } | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!contentEl.contains(range.startContainer) || !contentEl.contains(range.endContainer)) {
      return null;
    }

    // Insert end marker first (higher DOM position) so start insertion doesn't shift it.
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

    const md = domToMarkdown(contentEl, renderOpts);

    const firstIdx = md.indexOf(CURSOR_SENTINEL);
    const secondIdx = firstIdx !== -1 ? md.indexOf(CURSOR_SENTINEL, firstIdx + 1) : -1;

    const startParent = startMarker.parentNode;
    const endParent = endMarker.parentNode;
    startMarker.remove();
    endMarker.remove();
    startParent?.normalize();
    if (endParent && endParent !== startParent) endParent.normalize();

    try {
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {
      /* ignore */
    }

    if (firstIdx === -1) return null;
    // secondIdx is shifted by +1 because the first sentinel occupies one char before it
    const end = secondIdx !== -1 ? secondIdx - 1 : firstIdx;
    return { start: firstIdx, end };
  }

  function getCursorOffset(): number {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return -1;
    const range = sel.getRangeAt(0);
    if (!contentEl.contains(range.startContainer)) return -1;
    return getCursorMarkdownOffset(contentEl, range, renderOpts);
  }

  // ── getValue / setValue ─────────────────────────────────────────────────────

  function getValue(): string {
    return _isSourceMode ? sourceEl.value : domToMarkdown(contentEl, renderOpts);
  }

  function setValue(md: string, cursorOffset?: number): void {
    if (_isSourceMode) {
      sourceEl.value = md;
    } else if (cursorOffset !== undefined) {
      setContentWithCursor(md, cursorOffset);
      restoreCursorMarker();
    } else {
      setContent(md);
    }
    const sel = getSelectionOffsets();
    pushUndo(md, sel?.start ?? 0, sel?.end ?? 0);
  }

  // ── Undo stack ──────────────────────────────────────────────────────────────

  function pushUndo(md: string, selStart: number, selEnd: number): void {
    undoStack.splice(undoIndex + 1);
    const top = undoStack[undoIndex];
    if (top && top.md === md && top.selStart === selStart && top.selEnd === selEnd) return;
    undoStack.push({ md, selStart, selEnd });
    if (undoStack.length > (cfg.undoStackMax ?? 200)) {
      undoStack.shift();
    } else {
      undoIndex++;
    }
  }

  function checkpoint(): void {
    if (typingTimer !== null) {
      clearTimeout(typingTimer);
      typingTimer = null;
    }
    const md = getValue();
    const sel = getSelectionOffsets();
    pushUndo(md, sel?.start ?? 0, sel?.end ?? 0);
  }

  // ── Format ──────────────────────────────────────────────────────────────────

  function applyFormat(op: (md: string, s: number, e: number) => FormatResult): void {
    if (_isSourceMode) return;
    const sel = getSelectionOffsets();
    if (!sel) return;
    const md = getValue();
    pushUndo(md, sel.start, sel.end);
    const { md: newMd, selStart, selEnd } = op(md, sel.start, sel.end);
    setContentWithSelection(newMd, selStart, selEnd);
    restoreSelectionFromRenderedMarkers();
    cfg.onChange?.();
  }

  // ── Undo / redo ─────────────────────────────────────────────────────────────

  function undo(): void {
    checkpoint(); // push current state so redo can recover it
    if (undoIndex <= 0) return;
    undoIndex--;
    const entry = undoStack[undoIndex]!;
    setContentWithSelection(entry.md, entry.selStart, entry.selEnd);
    restoreSelectionFromRenderedMarkers();
    cfg.onChange?.();
  }

  function redo(): void {
    if (undoIndex >= undoStack.length - 1) return;
    undoIndex++;
    const entry = undoStack[undoIndex]!;
    setContentWithSelection(entry.md, entry.selStart, entry.selEnd);
    restoreSelectionFromRenderedMarkers();
    cfg.onChange?.();
  }

  // ── List-editing helpers ────────────────────────────────────────────────────

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
    for (const nested of clone.querySelectorAll("ul, ol")) nested.remove();
    const text = (clone.textContent ?? "").replaceAll("​", "").replaceAll(" ", " ").trim();
    return text === "";
  }

  function getNextElementSibling(node: Node): HTMLElement | null {
    let cur = node.nextSibling;
    while (cur) {
      if (cur instanceof HTMLElement) return cur;
      cur = cur.nextSibling;
    }
    return null;
  }

  function getPrevElementSibling(node: Node): HTMLElement | null {
    let cur = node.previousSibling;
    while (cur) {
      if (cur instanceof HTMLElement) return cur;
      cur = cur.previousSibling;
    }
    return null;
  }

  function placeCursorAtBlockStart(block: HTMLElement): void {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(block);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function placeCursorAtBlockEnd(block: HTMLElement): void {
    const sel = window.getSelection();
    if (!sel) return;
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

  function removeEmptyTopLevelListItem(item: HTMLElement): void {
    const parentList = item.parentElement;
    if (
      !(parentList instanceof HTMLElement) ||
      (parentList.tagName !== "UL" && parentList.tagName !== "OL")
    )
      return;
    const previous = getPrevElementSibling(item);
    const next = getNextElementSibling(item);
    item.remove();
    if (parentList.children.length === 0) {
      const p = document.createElement("p");
      p.append(document.createElement("br"));
      parentList.replaceWith(p);
      placeCursorAtBlockStart(p);
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

  function isIndentableBlock(el: HTMLElement): boolean {
    if (el === contentEl) return false;
    if (!INDENTABLE_BLOCKS.has(el.tagName)) return false;
    return el.tagName !== "CODE" || el.parentElement?.tagName === "PRE";
  }

  function getIndentableBlock(node: Node): HTMLElement | null {
    let cur: Node | null = node;
    while (cur && cur !== contentEl) {
      if (cur instanceof HTMLElement && isIndentableBlock(cur)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }

  function getListItemBlock(node: Node): HTMLElement | null {
    const block = getIndentableBlock(node);
    return block && isListItemBlock(block) ? block : null;
  }

  function handleEmptyListItemBackspace(e: KeyboardEvent): boolean {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    if (!contentEl.contains(range.startContainer)) return false;
    const listItem = getListItemBlock(range.startContainer);
    if (!listItem || !isRangeAtStartOfBlock(range, listItem) || !isListItemEmpty(listItem)) {
      return false;
    }
    e.preventDefault();
    if (isNestedListItem(listItem)) {
      const md = getValue();
      const offsets = getSelectionOffsets();
      if (!offsets) return false;
      pushUndo(md, offsets.start, offsets.end);
      const { md: newMd, selStart, selEnd } = shiftIndent(md, offsets.start, offsets.end, true);
      setContentWithSelection(newMd, selStart, selEnd);
      restoreSelectionFromRenderedMarkers();
    } else {
      removeEmptyTopLevelListItem(listItem);
    }
    cfg.onChange?.();
    return true;
  }

  // ── Source mode Tab key ─────────────────────────────────────────────────────

  function dedentLine(line: string): string {
    const indentUnit = cfg.indentUnit ?? "\t";
    if (line.startsWith(indentUnit)) return line.slice(indentUnit.length);
    const match = line.match(new RegExp(`^[ ]{1,${MAX_INDENT_SPACES}}`));
    return match ? line.slice(match[0].length) : line;
  }

  function handleSourceTabKey(e: KeyboardEvent): void {
    e.preventDefault();
    const indentUnit = cfg.indentUnit ?? "\t";
    const { value } = sourceEl;
    const start = sourceEl.selectionStart;
    const end = sourceEl.selectionEnd;

    if (!e.shiftKey && start === end) {
      sourceEl.value = value.slice(0, start) + indentUnit + value.slice(end);
      sourceEl.selectionStart = start + indentUnit.length;
      sourceEl.selectionEnd = start + indentUnit.length;
      cfg.onChange?.();
      return;
    }

    const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const adjustedEnd = end > start && value[end - 1] === "\n" ? end - 1 : end;
    const nextNewline = value.indexOf("\n", adjustedEnd);
    const lineEnd = nextNewline === -1 ? value.length : nextNewline;
    const lines = value.slice(lineStart, lineEnd).split("\n");
    const transformed = e.shiftKey ? lines.map(dedentLine) : lines.map((l) => indentUnit + l);
    sourceEl.setRangeText(transformed.join("\n"), lineStart, lineEnd, "select");
    sourceEl.selectionStart = lineStart;
    sourceEl.selectionEnd = lineStart + transformed.join("\n").length;
    cfg.onChange?.();
  }

  // ── Event handlers ──────────────────────────────────────────────────────────

  function onKeyDown(e: KeyboardEvent): void {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key === "s") {
      e.preventDefault();
      e.stopPropagation();
      cfg.onSave?.();
      return;
    }
    if (meta && e.key === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
      return;
    }
    if ((meta && e.shiftKey && e.key === "z") || (meta && e.key === "y")) {
      e.preventDefault();
      redo();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const dedent = e.shiftKey;
      applyFormat((md, s, end) => shiftIndent(md, s, end, dedent));
      return;
    }
    if (meta && e.key === "b") {
      e.preventDefault();
      applyFormat(toggleBold);
      return;
    }
    if (meta && e.key === "i") {
      e.preventDefault();
      applyFormat(toggleItalic);
      return;
    }
    if (meta && e.key === "h") {
      e.preventDefault();
      applyFormat(toggleHighlight);
      return;
    }
    if (e.key === "Backspace" && handleEmptyListItemBackspace(e)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      handleBlockTransform(e, contentEl, () => cfg.onChange?.());
    }
  }

  function onInput(): void {
    if (checkBlockInputTransform(contentEl)) {
      cfg.onChange?.();
      return;
    }
    checkInlineTransform();
    if (typingTimer !== null) clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      typingTimer = null;
      const md = getValue();
      const sel = getSelectionOffsets();
      pushUndo(md, sel?.start ?? 0, sel?.end ?? 0);
    }, cfg.typingCheckpointMs ?? 1000);
    cfg.onChange?.();
  }

  async function onPaste(e: ClipboardEvent): Promise<void> {
    e.preventDefault();
    const clipData = e.clipboardData;
    if (!clipData) return;

    const imageItem = [...clipData.items].find((item) => item.type.startsWith("image/"));
    if (imageItem && cfg.onImagePaste) {
      const file = imageItem.getAsFile();
      if (file) {
        const bitmap = await createImageBitmap(file);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(bitmap, 0, 0);
        const blob = await canvas.convertToBlob({
          type: "image/webp",
          quality: cfg.imageWebpQuality ?? 0.85,
        });
        bitmap.close();
        const html = await cfg.onImagePaste(blob);
        if (html) {
          document.execCommand("insertHTML", false, html);
          cfg.onChange?.();
        }
      }
      return;
    }

    const htmlData = clipData.getData("text/html");
    let pastedText: string;
    if (htmlData) {
      const div = document.createElement("div");
      div.innerHTML = htmlData;
      pastedText = domToMarkdown(div, renderOpts);
    } else {
      pastedText = clipData.getData("text/plain");
    }

    if (pastedText) {
      const md = getValue();
      const sel = getSelectionOffsets();
      const start = sel?.start ?? md.length;
      const end = sel?.end ?? start;
      checkpoint();
      const newMd = md.slice(0, start) + pastedText + md.slice(end);
      const cur = start + pastedText.length;
      setContentWithSelection(newMd, cur, cur);
      restoreSelectionFromRenderedMarkers();
      cfg.onChange?.();
    }
  }

  function onCheckboxEvent(e: Event): void {
    if (e.target instanceof HTMLInputElement && e.target.type === "checkbox") {
      cfg.onChange?.();
    }
  }

  contentEl.addEventListener("keydown", onKeyDown);
  contentEl.addEventListener("input", onInput);
  contentEl.addEventListener("paste", (e) => {
    void onPaste(e);
  });
  contentEl.addEventListener("change", onCheckboxEvent);
  contentEl.addEventListener("click", onCheckboxEvent);
  sourceEl.addEventListener("input", () => cfg.onChange?.());
  sourceEl.addEventListener("keydown", (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key === "s") {
      e.preventDefault();
      e.stopPropagation();
      cfg.onSave?.();
      return;
    }
    if (e.key === "Tab") handleSourceTabKey(e);
  });

  // ── Source mode ─────────────────────────────────────────────────────────────

  function toggleSourceMode(): void {
    if (_isSourceMode) {
      const md = sourceEl.value;
      setContent(md);
      _isSourceMode = false;
      sourceEl.style.display = "none";
      contentEl.style.display = "";
    } else {
      sourceEl.value = getValue();
      _isSourceMode = true;
      contentEl.style.display = "none";
      sourceEl.style.display = "";
    }
  }

  function setConfig(partial: Partial<EditorConfig>): void {
    cfg = { ...cfg, ...partial };
    if (partial.contentClassName !== undefined) contentEl.className = partial.contentClassName;
    if (partial.sourceClassName !== undefined) sourceEl.className = partial.sourceClassName;
  }

  function destroy(): void {
    if (typingTimer !== null) clearTimeout(typingTimer);
    contentEl.removeEventListener("keydown", onKeyDown);
    contentEl.removeEventListener("input", onInput);
    contentEl.removeEventListener("change", onCheckboxEvent);
    contentEl.removeEventListener("click", onCheckboxEvent);
    container.removeChild(contentEl);
    container.removeChild(sourceEl);
  }

  return {
    getValue,
    setValue,
    getSelectionOffsets,
    getCursorOffset,
    applyFormat,
    undo,
    redo,
    toggleSourceMode,
    focus: () => contentEl.focus(),
    setConfig,
    get isSourceMode() {
      return _isSourceMode;
    },
    contentEl,
    sourceEl,
    destroy,
  };
}
