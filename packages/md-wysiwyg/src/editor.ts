/// WYSIWYG editor wiring layer. Creates DOM, manages undo stack, routes keyboard
/// events, and handles image paste. All markdown-specific behavior is delegated to
/// the render/serialize/transform modules; callers configure extensions and callbacks.

import { createEditorRenderer } from "./editor-renderer.js";
import {
  createEditorSelectionController,
  isRangeAtStartOfBlock,
  type SelectionOffsets,
} from "./editor-selection.js";
import { createSelectionTransactionController } from "./editor-transactions.js";
import { createEditorUndoController } from "./editor-undo.js";
import type { MarkdownExtension } from "./extension.js";
import {
  shiftIndent,
  toggleBold,
  toggleHighlight,
  toggleItalic,
  type FormatResult,
} from "./format-ops.js";
import { checkInlineTransform } from "./inline-transforms.js";
import { domToMarkdown } from "./serialize.js";
import { checkBlockInputTransform, handleBlockTransform } from "./transforms.js";

const MAX_INDENT_SPACES = 4;
const DISALLOWED_PASTE_TAGS = new Set([
  "BASE",
  "EMBED",
  "FRAME",
  "IFRAME",
  "LINK",
  "META",
  "OBJECT",
  "SCRIPT",
  "STYLE",
  "TEMPLATE",
]);
const STRUCTURAL_PASTE_BOUNDARY_TAGS = new Set([
  "BLOCKQUOTE",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "P",
]);
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

function hasDataTransferType(dataTransfer: DataTransfer, type: string): boolean {
  return [...dataTransfer.types].includes(type);
}

function isSafePastedUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed === "") {
    return true;
  }
  const lower = trimmed.toLowerCase();
  return (
    lower.startsWith("#") ||
    lower.startsWith("/") ||
    lower.startsWith("./") ||
    lower.startsWith("../") ||
    lower.startsWith("http:") ||
    lower.startsWith("https:") ||
    lower.startsWith("mailto:") ||
    lower.startsWith("tel:") ||
    lower.startsWith("data:image/")
  );
}

function sanitizePastedTree(root: ParentNode): void {
  const toRemove: Element[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let current = walker.nextNode();
  while (current) {
    const el = current as Element;
    if (DISALLOWED_PASTE_TAGS.has(el.tagName)) {
      toRemove.push(el);
      current = walker.nextNode();
      continue;
    }
    for (const attr of el.attributes) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (
        (name === "href" || name === "src" || name === "xlink:href") &&
        !isSafePastedUrl(attr.value)
      ) {
        el.removeAttribute(attr.name);
      }
    }
    current = walker.nextNode();
  }
  for (const el of toRemove) {
    el.remove();
  }
}

function htmlToSanitizedContainer(html: string): HTMLElement {
  const container = document.createElement("div");
  const sanitizerContainer = container as HTMLDivElement & {
    setHTML?: (input: string, options?: { sanitizer?: unknown }) => void;
  };
  if (typeof sanitizerContainer.setHTML === "function") {
    sanitizerContainer.setHTML(html);
    return container;
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  sanitizePastedTree(doc.body);
  for (const child of doc.body.childNodes) {
    container.append(child.cloneNode(true));
  }
  return container;
}

function findLineStart(md: string, offset: number): number {
  const lineStartIdx = md.lastIndexOf("\n", offset - 1);
  return lineStartIdx === -1 ? 0 : lineStartIdx + 1;
}

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
  let preferPlainTextPaste = false;

  const contentEl = document.createElement("div");
  contentEl.contentEditable = "true";
  contentEl.className = cfg.contentClassName ?? "md-editor-content";
  const sourceEl = document.createElement("textarea");
  sourceEl.className = cfg.sourceClassName ?? "md-editor-source";
  sourceEl.style.display = "none";
  container.append(contentEl, sourceEl);

  let _isSourceMode = false;
  const renderer = createEditorRenderer(contentEl, extensions);
  const selection = createEditorSelectionController(contentEl, extensions);

  // ── getValue / setValue ─────────────────────────────────────────────────────

  function getValue(): string {
    return _isSourceMode ? sourceEl.value : domToMarkdown(contentEl, { extensions });
  }

  function setValue(md: string, cursorOffset?: number): void {
    if (_isSourceMode) {
      sourceEl.value = md;
    } else if (cursorOffset !== undefined) {
      renderer.renderWithCursor(md, cursorOffset);
      selection.restoreCursorMarker();
    } else {
      renderer.render(md);
    }
    const sel = selection.getSelectionOffsets();
    undoController.pushUndo(md, sel?.start ?? 0, sel?.end ?? 0);
  }

  const undoController = createEditorUndoController({
    getValue,
    getSelectionOffsets: selection.getSelectionOffsets,
    renderSelection: renderer.renderWithSelection,
    restoreSelection: selection.restoreSelectionFromRenderedMarkers,
    getUndoStackMax: () => cfg.undoStackMax ?? 200,
    getTypingCheckpointMs: () => cfg.typingCheckpointMs ?? 1000,
    ...(cfg.onChange ? { onChange: cfg.onChange } : {}),
  });

  const transactions = createSelectionTransactionController({
    getValue,
    getSelectionOffsets: selection.getSelectionOffsets,
    pushUndo: undoController.pushUndo,
    checkpoint: undoController.checkpoint,
    renderSelection: renderer.renderWithSelection,
    restoreSelection: selection.restoreSelectionFromRenderedMarkers,
    ...(cfg.onChange ? { onChange: cfg.onChange } : {}),
  });

  // ── Format ──────────────────────────────────────────────────────────────────

  function applyFormat(op: (md: string, s: number, e: number) => FormatResult): void {
    if (_isSourceMode) return;
    transactions.applySelectionEdit(op);
  }

  // ── Undo / redo ─────────────────────────────────────────────────────────────

  function undo(): void {
    undoController.undo();
  }

  function redo(): void {
    undoController.redo();
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

  function getStructuralPasteBoundaryBlock(node: Node): HTMLElement | null {
    let cur: Node | null = node;
    while (cur && cur !== contentEl) {
      if (cur instanceof HTMLElement && STRUCTURAL_PASTE_BOUNDARY_TAGS.has(cur.tagName)) {
        return cur;
      }
      cur = cur.parentNode;
    }
    return null;
  }

  function getBlockPasteSelectionOverride(text: string): SelectionOffsets | undefined {
    if (!text.includes("\n\n")) {
      return undefined;
    }
    const domSelection = window.getSelection();
    if (!domSelection || domSelection.rangeCount === 0 || !domSelection.isCollapsed) {
      return undefined;
    }
    const range = domSelection.getRangeAt(0);
    if (!contentEl.contains(range.startContainer)) {
      return undefined;
    }
    const block = getStructuralPasteBoundaryBlock(range.startContainer);
    if (!block || !isRangeAtStartOfBlock(range, block)) {
      return undefined;
    }
    const offsets = selection.getSelectionOffsets();
    if (!offsets) {
      return undefined;
    }
    const start = findLineStart(getValue(), offsets.start);
    return { start, end: start };
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
      const offsets = selection.getSelectionOffsets();
      if (!offsets) return false;
      undoController.pushUndo(md, offsets.start, offsets.end);
      const { md: newMd, selStart, selEnd } = shiftIndent(md, offsets.start, offsets.end, true);
      renderer.renderWithSelection(newMd, selStart, selEnd);
      selection.restoreSelectionFromRenderedMarkers();
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

    const lineStartIdx = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const adjustedEnd = end > start && value[end - 1] === "\n" ? end - 1 : end;
    const nextNewline = value.indexOf("\n", adjustedEnd);
    const lineEnd = nextNewline === -1 ? value.length : nextNewline;
    const lines = value.slice(lineStartIdx, lineEnd).split("\n");
    const transformed = e.shiftKey ? lines.map(dedentLine) : lines.map((l) => indentUnit + l);
    sourceEl.setRangeText(transformed.join("\n"), lineStartIdx, lineEnd, "select");
    sourceEl.selectionStart = lineStartIdx;
    sourceEl.selectionEnd = lineStartIdx + transformed.join("\n").length;
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
    if (meta && e.shiftKey && e.key.toLowerCase() === "i") {
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
    undoController.scheduleTypingCheckpoint();
    cfg.onChange?.();
  }

  async function onPaste(e: ClipboardEvent): Promise<void> {
    e.preventDefault();
    const clipData = e.clipboardData;
    const usePlainTextPaste = preferPlainTextPaste;
    preferPlainTextPaste = false;
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
    if (htmlData && !usePlainTextPaste) {
      const div = htmlToSanitizedContainer(htmlData);
      pastedText = domToMarkdown(div, { extensions });
    } else {
      pastedText = clipData.getData("text/plain");
    }

    if (pastedText) {
      transactions.replaceSelection(pastedText, getBlockPasteSelectionOverride(pastedText));
    }
  }

  function onBeforeInput(e: InputEvent): void {
    if (e.inputType !== "insertFromPaste" && e.inputType !== "insertFromPasteAsQuotation") {
      preferPlainTextPaste = false;
      return;
    }
    const dataTransfer = e.dataTransfer;
    preferPlainTextPaste =
      dataTransfer !== null &&
      hasDataTransferType(dataTransfer, "text/plain") &&
      !hasDataTransferType(dataTransfer, "text/html");
  }

  function onCheckboxEvent(e: Event): void {
    if (e.target instanceof HTMLInputElement && e.target.type === "checkbox") {
      cfg.onChange?.();
    }
  }

  function onContentPaste(e: ClipboardEvent): void {
    void onPaste(e);
  }

  function onSourceInput(): void {
    cfg.onChange?.();
  }

  function onSourceKeyDown(e: KeyboardEvent): void {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key === "s") {
      e.preventDefault();
      e.stopPropagation();
      cfg.onSave?.();
      return;
    }
    if (e.key === "Tab") {
      handleSourceTabKey(e);
    }
  }

  contentEl.addEventListener("keydown", onKeyDown);
  contentEl.addEventListener("beforeinput", onBeforeInput);
  contentEl.addEventListener("input", onInput);
  contentEl.addEventListener("paste", onContentPaste);
  contentEl.addEventListener("change", onCheckboxEvent);
  contentEl.addEventListener("click", onCheckboxEvent);
  sourceEl.addEventListener("input", onSourceInput);
  sourceEl.addEventListener("keydown", onSourceKeyDown);

  // ── Source mode ─────────────────────────────────────────────────────────────

  function toggleSourceMode(): void {
    if (_isSourceMode) {
      const md = sourceEl.value;
      renderer.render(md);
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
    undoController.destroy();
    contentEl.removeEventListener("keydown", onKeyDown);
    contentEl.removeEventListener("beforeinput", onBeforeInput);
    contentEl.removeEventListener("input", onInput);
    contentEl.removeEventListener("paste", onContentPaste);
    contentEl.removeEventListener("change", onCheckboxEvent);
    contentEl.removeEventListener("click", onCheckboxEvent);
    sourceEl.removeEventListener("input", onSourceInput);
    sourceEl.removeEventListener("keydown", onSourceKeyDown);
    contentEl.remove();
    sourceEl.remove();
  }

  return {
    getValue,
    setValue,
    getSelectionOffsets: selection.getSelectionOffsets,
    getCursorOffset: selection.getCursorOffset,
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
