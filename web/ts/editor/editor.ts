/// WYSIWYG editor wiring layer. Creates DOM, manages undo stack, routes keyboard
/// events, and handles image paste. All markdown-specific behavior is delegated to
/// model, render, and serialize modules; callers configure extensions and callbacks.

import { createBlockSelectionController } from "./editor-block-selection.js";
import {
  BLANK_LINE_SELECTOR,
  childOffset,
  createEditorDomHelpers,
  domPointFromVisualOffset,
  hostDirectHandle,
  hostTextWithoutControls,
  sourceBoundary,
} from "./editor-dom.js";
import { createWikiImageResizeController } from "./editor-image-resize.js";
import {
  createTextSelection,
  deleteBackward as modelDeleteBackward,
  deleteEmptyListItemBackward as modelDeleteEmptyListItemBackward,
  deleteForward as modelDeleteForward,
  docToMarkdown,
  insertListParagraph as modelInsertListParagraph,
  insertParagraph as modelInsertParagraph,
  markdownToDoc,
  normalizeMarkdownNewlines,
  offsetsToSelection,
  replaceLine,
  replaceLineText,
  replaceSelection as modelReplaceSelection,
  selectionToOffsets as modelSelectionToOffsets,
  type EditorState,
  type RenderHint,
  type LogicalPosition,
  type TransactionResult,
} from "./editor-model.js";
import { normalizeEditableContent } from "./editor-normalize.js";
import { createEditorPasteHandler, hasPlainTextOnlyPaste } from "./editor-paste.js";
import { annotateEditorDom, createEditorRenderer, type DomMap } from "./editor-renderer.js";
import {
  createEditorSelectionController,
  isRangeAtStartOfBlock,
  type SelectionOffsets,
} from "./editor-selection.js";
import { createSourceModeController } from "./editor-source-mode.js";
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
import { matchPattern, patterns as inlineTransformPatterns } from "./inline-patterns.js";

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
  resolveImageUrl?: (src: string) => string;
};

export type EditorHandle = {
  getValue(): string;
  getSnapshot(): EditorSnapshot;
  setValue(md: string, cursorOffset?: number): void;
  getSelectionOffsets(): { start: number; end: number } | null;
  getCursorOffset(): number;
  applyFormat(op: (md: string, s: number, e: number) => FormatResult): void;
  undo(): void;
  redo(): void;
  toggleSourceMode(): void;
  setReadOnly(readonly: boolean): void;
  containsEditableTarget(target: EventTarget | null): boolean;
  focus(): void;
  setConfig(partial: Partial<EditorConfig>): void;
  readonly isSourceMode: boolean;
  readonly isReadOnly: boolean;
  readonly contentEl: HTMLElement;
  readonly sourceEl: HTMLTextAreaElement;
  destroy(): void;
};

export type EditorSnapshot = {
  markdown: string;
  cursorOffset: number;
  selection: { start: number; end: number } | null;
  revision: number;
  sourceMode: boolean;
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
  const domHelpers = createEditorDomHelpers(contentEl);
  const {
    lineHostForNode,
    getBlockHandle,
    getNextElementSibling,
    getPrevElementSibling,
    placeCursorAtBlockStart,
    placeCursorAtBlockEnd,
    ensureEmptyParagraphPlaceholder,
    getBlankLineBlock,
    isBlankLineElement,
    isEditableBlankLineElement,
    isVisibleContentBlock,
    hideBlankLine,
    showBlankLine,
    showActiveBlankLine,
    getIndentableBlock,
    getStructuralPasteBoundaryBlock,
    createBlankLineSpacer,
    createCursorParagraph,
  } = domHelpers;

  let _isSourceMode = false;
  const renderer = createEditorRenderer(
    contentEl,
    extensions,
    (src) => cfg.resolveImageUrl?.(src) ?? src,
  );
  const selection = createEditorSelectionController(contentEl);
  let domMap: DomMap = { lineToElement: new Map(), blockToElement: new Map() };
  let suppressNextInsertParagraph = false;
  let arrowNavigationHandled = false;
  let state: EditorState = (() => {
    const doc = markdownToDoc("");
    return {
      doc,
      selection: createTextSelection(doc, 0),
      revision: 0,
      composing: false,
      sourceMode: false,
    };
  })();

  function logicalPositionFromDom(node: Node | null, offset: number): LogicalPosition | null {
    return domHelpers.logicalPositionFromDom(state, node, offset);
  }

  function currentMarkdown(): string {
    return docToMarkdown(state.doc);
  }

  function setModelMarkdown(
    md: string,
    selectionOffsets?: SelectionOffsets,
    sourceMode = _isSourceMode,
  ): void {
    const doc = markdownToDoc(md);
    state = {
      ...state,
      doc,
      selection:
        selectionOffsets === undefined
          ? createTextSelection(doc, 0)
          : offsetsToSelection(doc, selectionOffsets.start, selectionOffsets.end),
      revision: state.revision + 1,
      sourceMode,
    };
  }

  function setModelSelection(selectionOffsets: SelectionOffsets | null): void {
    if (selectionOffsets === null) return;
    state = {
      ...state,
      selection: offsetsToSelection(state.doc, selectionOffsets.start, selectionOffsets.end),
    };
  }

  function syncModelFromSource(): void {
    const md = normalizeMarkdownNewlines(sourceEl.value);
    const offsets = { start: sourceEl.selectionStart, end: sourceEl.selectionEnd };
    if (md !== currentMarkdown()) {
      setModelMarkdown(md, offsets, true);
    } else {
      setModelSelection(offsets);
      state = { ...state, sourceMode: true };
    }
  }

  function annotateCurrentDom(): void {
    domMap = annotateEditorDom(contentEl, state.doc);
  }

  function renderCurrentModel(): void {
    renderer.render(currentMarkdown());
    if (
      contentEl.childElementCount === 0 &&
      state.doc.lines.length === 1 &&
      state.doc.lines[0]?.text === ""
    ) {
      contentEl.append(createCursorParagraph());
    }
    annotateCurrentDom();
    restoreDomSelectionFromModel();
    updateActiveBlankVisibility();
    showSingleEmptyDocumentHost();
  }

  function showSingleEmptyDocumentHost(): void {
    if (state.doc.lines.length !== 1 || state.doc.lines[0]?.text !== "") {
      return;
    }
    const host = contentEl.querySelector<HTMLElement>("[data-md-line-index='0']");
    if (host === null) {
      return;
    }
    delete host.dataset["mdBlank"];
    delete host.dataset["mdBlankRole"];
    host.hidden = false;
    host.setAttribute("contenteditable", "true");
    if (!host.querySelector("br") && (host.textContent ?? "") === "") {
      host.prepend(document.createElement("br"));
    }
  }

  function renderModelHint(hint: RenderHint): boolean {
    return hint.kind === "lines" && renderLineRangeFromModel(hint.startLine, hint.endLine);
  }

  function renderLineRangeFromModel(startLine: number, endLine: number): boolean {
    if (endLine !== startLine + 1) {
      return false;
    }
    const line = state.doc.lines[startLine];
    if (!line) {
      return false;
    }
    const blockRef = state.doc.blocks.byLine[startLine];
    const block = blockRef ? state.doc.blocks.byId.get(blockRef.blockId) : null;
    if (!block) {
      return false;
    }
    if (block.kind === "code" || block.kind === "table" || block.kind === "blockquote") {
      return false;
    }
    if (
      block.kind !== "paragraph" &&
      block.kind !== "blank" &&
      block.endLine !== block.startLine + 1
    ) {
      return false;
    }
    const oldLineHost = domMap.lineToElement.get(line.id);
    if (!oldLineHost) {
      return false;
    }
    const oldBlockRoot = oldLineHost.closest("[data-md-block-id]");
    if (!(oldBlockRoot instanceof HTMLElement) || oldBlockRoot.parentElement !== contentEl) {
      return false;
    }
    if (oldBlockRoot.querySelectorAll("[data-md-line-index]").length > 1) {
      return false;
    }
    const replacement = renderer.renderFragment(line.text);
    if (replacement.length !== 1) {
      return false;
    }
    oldBlockRoot.replaceWith(replacement[0]!);
    annotateCurrentDom();
    restoreDomSelectionFromModel();
    updateActiveBlankVisibility();
    return true;
  }

  function renderSelectionAndModel(md: string, selStart: number, selEnd: number): void {
    const normalized = normalizeMarkdownNewlines(md);
    setModelMarkdown(normalized, { start: selStart, end: selEnd });
    if (_isSourceMode) {
      sourceEl.value = normalized;
      sourceEl.setSelectionRange(selStart, selEnd);
    } else {
      renderCurrentModel();
    }
  }

  function commitTransaction(result: TransactionResult, notify = true): boolean {
    if (!result.changed) return false;
    state = result.state;
    if (!renderModelHint(result.renderHint)) {
      renderCurrentModel();
    }
    if (notify) {
      undoController.scheduleTypingCheckpoint();
      cfg.onChange?.();
    }
    return true;
  }

  function commitStructuralTransaction(result: TransactionResult): boolean {
    if (!result.changed) return false;
    undoController.checkpoint();
    return commitTransaction(result);
  }

  function currentSelectionOffsets(): SelectionOffsets | null {
    if (_isSourceMode) {
      return { start: sourceEl.selectionStart, end: sourceEl.selectionEnd };
    }
    return modelSelectionToOffsets(state.doc, state.selection);
  }

  function restoreDomSelectionFromModel(): void {
    renderBlockSelectionClasses();
    if (_isSourceMode || state.selection.kind !== "text") {
      window.getSelection()?.removeAllRanges();
      return;
    }
    const anchorPoint = domPointForPosition(state.selection.anchor);
    const focusPoint = domPointForPosition(state.selection.focus);
    if (!anchorPoint || !focusPoint) {
      selection.placeCursorAtEnd();
      syncSelectionFromDomMetadata();
      return;
    }
    const sel = window.getSelection();
    if (!sel) return;
    try {
      sel.removeAllRanges();
      if (typeof sel.setBaseAndExtent === "function") {
        sel.setBaseAndExtent(
          anchorPoint.node,
          anchorPoint.offset,
          focusPoint.node,
          focusPoint.offset,
        );
      } else {
        const range = document.createRange();
        const ordered = comparePositions(state.selection.anchor, state.selection.focus) <= 0;
        const start = ordered ? anchorPoint : focusPoint;
        const end = ordered ? focusPoint : anchorPoint;
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
        sel.addRange(range);
      }
    } catch {
      selection.placeCursorAtEnd();
    }
    syncSelectionFromDomMetadata();
  }

  function comparePositions(a: LogicalPosition, b: LogicalPosition): number {
    return a.line === b.line ? a.column - b.column : a.line - b.line;
  }

  function domPointForPosition(pos: LogicalPosition): { node: Node; offset: number } | null {
    const line = state.doc.lines[pos.line];
    if (!line) return null;
    const host = domMap.lineToElement.get(line.id);
    if (!host) return null;
    const clampedColumn = Math.min(Math.max(0, pos.column), line.text.length);
    if (line.text === "" || (host.textContent ?? "").replaceAll("​", "") === "") {
      if (isBlankLineElement(host)) {
        if (!isEditableBlankLineElement(host)) {
          return domPointNearStructuralBlankLine(host);
        }
        showActiveBlankLine(host);
      }
      ensureEmptyParagraphPlaceholder(host);
      return { node: host, offset: 0 };
    }

    const sourcePoint = domPointFromSourceSpan(host, clampedColumn);
    if (sourcePoint) return sourcePoint;

    const lineContentStart = Number(host.dataset["mdLineContentStart"]);
    let visualOffset = Number.isFinite(lineContentStart)
      ? Math.max(0, clampedColumn - lineContentStart)
      : clampedColumn;
    const hostText = hostTextWithoutControls(host);
    if (hostText.startsWith("\u00A0")) {
      visualOffset += 1;
    }
    return domPointFromVisualOffset(host, visualOffset);
  }

  function domPointNearStructuralBlankLine(blank: HTMLElement): { node: Node; offset: number } {
    const next = getNextElementSibling(blank);
    if (next && next.dataset["mdBlank"] !== "true") {
      return { node: next, offset: 0 };
    }
    const previous = getPrevElementSibling(blank);
    if (previous && previous.dataset["mdBlank"] !== "true") {
      const handle = hostDirectHandle(previous);
      return { node: previous, offset: handle ? childOffset(handle) : previous.childNodes.length };
    }
    return { node: contentEl, offset: childOffset(blank) };
  }

  function domPointFromSourceSpan(
    host: HTMLElement,
    column: number,
  ): { node: Node; offset: number } | null {
    const candidates = [...host.querySelectorAll<HTMLElement>("[data-md-content-start]")].filter(
      (el) => {
        const contentStart = sourceBoundary(el, "mdContentStart");
        const contentEnd = sourceBoundary(el, "mdContentEnd");
        const sourceStart = sourceBoundary(el, "mdSourceStart");
        const sourceEnd = sourceBoundary(el, "mdSourceEnd");
        return (
          contentStart !== null &&
          contentEnd !== null &&
          sourceStart !== null &&
          sourceEnd !== null &&
          column >= sourceStart &&
          column <= sourceEnd
        );
      },
    );
    candidates.sort((a, b) => (a.textContent ?? "").length - (b.textContent ?? "").length);
    const el = candidates[0];
    if (!el) return null;
    const contentStart = sourceBoundary(el, "mdContentStart")!;
    const contentEnd = sourceBoundary(el, "mdContentEnd")!;
    if (column <= contentStart) {
      return { node: el.parentNode ?? host, offset: childOffset(el) };
    }
    if (column >= contentEnd) {
      return { node: el.parentNode ?? host, offset: childOffset(el) + 1 };
    }
    return domPointFromVisualOffset(el, column - contentStart);
  }

  function replaceMarkdownRange(start: number, end: number, text: string): void {
    const md = currentMarkdown();
    const normalized = normalizeMarkdownNewlines(text);
    const cursor = start + normalized.length;
    renderSelectionAndModel(md.slice(0, start) + normalized + md.slice(end), cursor, cursor);
  }

  function syncSelectionFromDomMetadata(): boolean {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    if (!contentEl.contains(range.startContainer) || !contentEl.contains(range.endContainer)) {
      return false;
    }
    const anchor = logicalPositionFromDom(range.startContainer, range.startOffset);
    const focus = logicalPositionFromDom(range.endContainer, range.endOffset);
    if (!anchor || !focus) return false;
    state = {
      ...state,
      selection: { kind: "text", anchor, focus },
    };
    return true;
  }

  function syncActiveLineFromDom(): boolean {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    const host = lineHostForNode(range.startContainer);
    if (!host || !contentEl.contains(range.startContainer)) return false;
    const block = host.closest("[data-md-block-kind]");
    const blockKind = block instanceof HTMLElement ? block.dataset["mdBlockKind"] : undefined;
    if (
      blockKind !== "paragraph" &&
      blockKind !== "blank" &&
      blockKind !== "heading" &&
      blockKind !== "list" &&
      blockKind !== "blockquote"
    ) {
      return false;
    }
    const hasRichInline = [...host.children].some(
      (child) =>
        child instanceof HTMLElement &&
        child.tagName !== "BR" &&
        child.tagName !== "INPUT" &&
        child.tagName !== "BUTTON" &&
        child.className !== "md-block-handle",
    );
    const lineIndex = Number(host.dataset["mdLineIndex"]);
    if (!Number.isInteger(lineIndex)) return false;
    if (blockKind === "blank" && !isEditableBlankModelLine(lineIndex)) {
      return false;
    }
    if (hasRichInline) {
      return syncActiveSourceSpanFromDom(host, lineIndex, range);
    }
    const text = lineTextFromHost(host, lineIndex);
    const pos = logicalPositionFromDom(range.startContainer, range.startOffset);
    const result = replaceLineText(state, lineIndex, text, pos?.column ?? text.length);
    state = result.state;
    if (result.changed) annotateCurrentDom();
    return result.changed || result.renderHint.kind === "none";
  }

  function lineTextFromHost(host: HTMLElement, lineIndex: number): string {
    const rawText = (host.textContent ?? "").replaceAll("​", "");
    const lineContentStart = Number(host.dataset["mdLineContentStart"]);
    const contentText =
      Number.isFinite(lineContentStart) && lineContentStart > 0
        ? rawText.replace(/^\u00A0/, "")
        : rawText;
    const visualText = /^\u00A0*$/.test(contentText) ? "" : contentText.replaceAll("\u00A0", " ");
    if (!Number.isFinite(lineContentStart) || lineContentStart <= 0) {
      return visualText;
    }
    return state.doc.lines[lineIndex]!.text.slice(0, lineContentStart) + visualText;
  }

  function syncActiveSourceSpanFromDom(
    host: HTMLElement,
    lineIndex: number,
    range: Range,
  ): boolean {
    const node =
      range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
    const sourceElement = node?.closest("[data-md-content-start]");
    if (
      !(sourceElement instanceof HTMLElement) ||
      !host.contains(sourceElement) ||
      sourceElement.dataset["mdAtomicSource"] === "true"
    ) {
      return false;
    }
    const contentStart = sourceBoundary(sourceElement, "mdContentStart");
    const contentEnd = sourceBoundary(sourceElement, "mdContentEnd");
    if (contentStart === null || contentEnd === null) {
      return false;
    }
    const content = (sourceElement.textContent ?? "").replaceAll("​", "");
    const line = state.doc.lines[lineIndex]!.text;
    const text = line.slice(0, contentStart) + content + line.slice(contentEnd);
    const pos = logicalPositionFromDom(range.startContainer, range.startOffset);
    const result = replaceLineText(
      state,
      lineIndex,
      text,
      pos?.column ?? contentStart + content.length,
    );
    state = result.state;
    if (result.changed) annotateCurrentDom();
    return result.changed || result.renderHint.kind === "none";
  }

  function replaceEmptySelectedLineInput(text: string): boolean {
    if (state.selection.kind !== "text") {
      return false;
    }
    const { anchor, focus } = state.selection;
    if (anchor.line !== focus.line || anchor.column !== focus.column) {
      return false;
    }
    if (state.doc.lines[anchor.line]?.text !== "") {
      return false;
    }
    if (!isEditableBlankModelLine(anchor.line)) {
      return false;
    }
    if (shouldKeepMarkerInputPlain(text)) {
      const line = anchor.line;
      const result = replaceLineText(state, line, text);
      state = result.state;
      renderPlainLineHost(line, text);
      undoController.scheduleTypingCheckpoint();
      cfg.onChange?.();
      return true;
    }
    if (text === " " || text === "\u00A0") {
      const line = anchor.line;
      const result = replaceLineText(state, line, " ");
      state = result.state;
      renderPlainLineHost(line, " ");
      undoController.scheduleTypingCheckpoint();
      cfg.onChange?.();
      return true;
    }
    undoController.ensureTypingCheckpoint();
    const result = replaceLineText(state, anchor.line, text);
    state = result.state;
    renderPlainLineHost(anchor.line, text);
    undoController.scheduleTypingCheckpoint();
    cfg.onChange?.();
    return true;
  }

  function plainMarkerPrefixTextAfterInsert(data: string): string | null {
    if (data.length !== 1 || state.selection.kind !== "text") {
      return null;
    }
    const { anchor, focus } = state.selection;
    if (anchor.line !== focus.line || anchor.column !== focus.column) {
      return null;
    }
    const line = state.doc.lines[anchor.line]?.text;
    if (line === undefined || anchor.column !== line.length) {
      return null;
    }
    if (/^(\*|`|~|=)$/.test(line) && data === line) {
      return `${line}${data}`;
    }
    return null;
  }

  function leadingSpaceTextAfterInsert(data: string): { line: number; text: string } | null {
    if (data.length !== 1 || state.selection.kind !== "text") {
      return null;
    }
    const { anchor, focus } = state.selection;
    if (anchor.line !== focus.line || anchor.column !== focus.column) {
      return null;
    }
    const line = state.doc.lines[anchor.line]?.text;
    if (line === undefined || !line.startsWith(" ")) {
      return null;
    }
    return {
      line: anchor.line,
      text: `${line.slice(0, anchor.column)}${data}${line.slice(anchor.column)}`,
    };
  }

  function shouldKeepMarkerInputPlain(text: string): boolean {
    return /^[-*+>]$/.test(text);
  }

  function renderPlainLineHost(lineIndex: number, text: string): void {
    const line = state.doc.lines[lineIndex];
    const host = line ? domMap.lineToElement.get(line.id) : null;
    if (!line || !host) {
      renderCurrentModel();
      return;
    }
    const handle = hostDirectHandle(host);
    for (const child of Array.from(host.childNodes)) {
      if (child !== handle) {
        child.remove();
      }
    }
    const displayText = text.replace(/^ +/, (spaces) => "\u00A0".repeat(spaces.length));
    const textNode = document.createTextNode(displayText);
    if (handle) {
      host.insertBefore(textNode, handle);
    } else {
      host.append(textNode);
    }
    host.hidden = false;
    delete host.dataset["mdBlank"];
    delete host.dataset["mdBlankRole"];
    delete host.dataset["mdLineContentStart"];
    host.dataset["mdLineId"] = line.id;
    host.dataset["mdLineIndex"] = String(lineIndex);
    host.dataset["mdBlockKind"] = "paragraph";
    const range = document.createRange();
    range.setStart(textNode, text.length);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    annotateCurrentDom();
    updateActiveBlankVisibility();
  }

  function shouldRenderModelBlockInputTransform(): boolean {
    if (state.selection.kind !== "text") return false;
    const { anchor, focus } = state.selection;
    if (anchor.line !== focus.line || anchor.column !== focus.column) return false;
    const text = state.doc.lines[anchor.line]?.text ?? "";
    return (
      /^#{1,6}[ \u00A0]$/.test(text) ||
      /^[-*][ \u00A0]$/.test(text) ||
      /^\d+\.[ \u00A0]$/.test(text) ||
      /^\[([ xX])\][ \u00A0]$/.test(text) ||
      /^>[ \u00A0]$/.test(text) ||
      /^```[^ \u00A0]*[ \u00A0]$/.test(text)
    );
  }

  function shouldRenderModelInlineInputTransform(): boolean {
    if (state.selection.kind !== "text") return false;
    const { anchor, focus } = state.selection;
    if (anchor.line !== focus.line || anchor.column !== focus.column) return false;
    const text = state.doc.lines[anchor.line]?.text ?? "";
    return inlineTransformPatterns.some((pattern) => matchPattern(text, anchor.column, pattern));
  }

  function renderModelAfterInputTransform(): boolean {
    if (!shouldRenderModelBlockInputTransform() && !shouldRenderModelInlineInputTransform()) {
      return false;
    }
    const line = state.selection.kind === "text" ? state.selection.anchor.line : -1;
    if (!renderLineRangeFromModel(line, line + 1)) {
      renderCurrentModel();
    }
    return true;
  }

  function blockTransformTextAfterInsert(data: string): string | null {
    if (data !== " " && data !== "\u00A0") {
      return null;
    }
    if (state.selection.kind !== "text") {
      return null;
    }
    const { anchor, focus } = state.selection;
    if (anchor.line !== focus.line || anchor.column !== focus.column) {
      return null;
    }
    const line = state.doc.lines[anchor.line]?.text;
    if (line === undefined || anchor.column !== line.length) {
      return null;
    }
    if (
      /^#{1,6}$/.test(line) ||
      /^[-*]$/.test(line) ||
      /^\d+\.$/.test(line) ||
      /^>$/.test(line) ||
      /^\[([ xX])\]$/.test(line) ||
      /^```[^ \u00A0]*$/.test(line)
    ) {
      return `${line}${data}`;
    }
    return null;
  }

  function getValue(): string {
    return _isSourceMode ? normalizeMarkdownNewlines(sourceEl.value) : currentMarkdown();
  }

  function isEditableBlankModelLine(line: number): boolean {
    const blockRef = state.doc.blocks.byLine[line];
    return blockRef?.role === "blank" && blockRef.blankRole !== "separator";
  }

  function getSnapshot(): EditorSnapshot {
    if (_isSourceMode) {
      syncModelFromSource();
    } else if (state.selection.kind !== "block") {
      syncSelectionFromDomMetadata();
    }
    const offsets = currentSelectionOffsets();
    return {
      markdown: currentMarkdown(),
      cursorOffset: offsets?.start ?? -1,
      selection: offsets,
      revision: state.revision,
      sourceMode: _isSourceMode,
    };
  }

  function getSelectionOffsets(): SelectionOffsets | null {
    if (_isSourceMode) {
      return { start: sourceEl.selectionStart, end: sourceEl.selectionEnd };
    }
    if (state.selection.kind === "block") {
      return modelSelectionToOffsets(state.doc, state.selection);
    }
    if (syncSelectionFromDomMetadata()) {
      return modelSelectionToOffsets(state.doc, state.selection);
    }
    return modelSelectionToOffsets(state.doc, state.selection);
  }

  function getCursorOffset(): number {
    const offsets = getSelectionOffsets();
    return offsets?.start ?? -1;
  }

  function setValue(md: string, cursorOffset?: number): void {
    const normalized = normalizeMarkdownNewlines(md);
    const selectionOffsets =
      cursorOffset === undefined
        ? { start: 0, end: 0 }
        : { start: cursorOffset, end: cursorOffset };
    setModelMarkdown(normalized, selectionOffsets);
    if (_isSourceMode) {
      sourceEl.value = normalized;
    } else {
      renderCurrentModel();
    }
    const sel = syncSelectionFromDomMetadata()
      ? modelSelectionToOffsets(state.doc, state.selection)
      : currentSelectionOffsets();
    setModelSelection(sel);
    undoController.pushUndo(normalized, sel?.start ?? 0, sel?.end ?? 0);
  }

  const undoController = createEditorUndoController({
    getValue,
    getSelectionOffsets,
    renderSelection: renderSelectionAndModel,
    restoreSelection: restoreDomSelectionFromModel,
    getUndoStackMax: () => cfg.undoStackMax ?? 200,
    getTypingCheckpointMs: () => cfg.typingCheckpointMs ?? 1000,
    ...(cfg.onChange ? { onChange: cfg.onChange } : {}),
  });

  const transactions = createSelectionTransactionController({
    getValue,
    getSelectionOffsets,
    pushUndo: undoController.pushUndo,
    checkpoint: undoController.checkpoint,
    renderSelection: renderSelectionAndModel,
    restoreSelection: restoreDomSelectionFromModel,
    ...(cfg.onChange ? { onChange: cfg.onChange } : {}),
  });
  const blockSelectionController = createBlockSelectionController({
    contentEl,
    getState: () => state,
    setState: (nextState) => {
      state = nextState;
    },
    currentMarkdown,
    renderSelectionAndModel,
    renderCurrentModel,
    pushUndo: undoController.pushUndo,
    onChange: () => {
      cfg.onChange?.();
    },
  });
  const {
    renderBlockSelectionClasses,
    selectBlock,
    replaceBlockSelection,
    copyBlockSelection,
    collapseBlockSelectionToStart,
  } = blockSelectionController;
  const pasteHandler = createEditorPasteHandler({
    extensions,
    getImageWebpQuality: () => cfg.imageWebpQuality ?? 0.85,
    onImagePaste: (blob) => cfg.onImagePaste?.(blob),
    consumePlainTextPastePreference: () => {
      const usePlainTextPaste = preferPlainTextPaste;
      preferPlainTextPaste = false;
      return usePlainTextPaste;
    },
    replaceBlockSelection,
    replaceEmptySelectedLine,
    getBlockPasteSelectionOverride,
    syncSelectionFromDomMetadata,
    replaceSelectionWithTransactions: (text, selectionOverride) => {
      transactions.replaceSelection(text, selectionOverride);
    },
    replaceSelectionWithModel: (text) => {
      commitStructuralTransaction(modelReplaceSelection(state, text));
    },
  });
  const imageResizeController = createWikiImageResizeController({
    isSourceMode: () => _isSourceMode,
    checkpoint: undoController.checkpoint,
    replaceMarkdownRange,
    onChange: () => {
      cfg.onChange?.();
    },
  });
  const sourceModeController = createSourceModeController({
    sourceEl,
    contentEl,
    getIndentUnit: () => cfg.indentUnit ?? "\t",
    onChange: () => {
      cfg.onChange?.();
    },
    onSave: () => {
      cfg.onSave?.();
    },
    undo,
    redo,
    isSourceMode: () => _isSourceMode,
    syncModelFromSource,
    syncActiveLineFromDom,
    syncSelectionFromDomMetadata,
    currentMarkdown,
    currentSelectionOffsets,
    checkpointUndo: undoController.checkpoint,
    resetUndo: undoController.reset,
    scheduleTypingCheckpoint: undoController.scheduleTypingCheckpoint,
    setSourceMode: (sourceMode) => {
      _isSourceMode = sourceMode;
      state = { ...state, sourceMode };
    },
    renderCurrentModel,
  });

  function applyFormat(op: (md: string, s: number, e: number) => FormatResult): void {
    if (_isSourceMode) return;
    transactions.applySelectionEdit(op);
  }

  function undo(): void {
    if (!_isSourceMode) {
      syncActiveLineFromDom();
    }
    undoController.undo();
  }

  function redo(): void {
    if (!_isSourceMode) {
      syncActiveLineFromDom();
    }
    undoController.redo();
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

  function isListItemEmpty(item: HTMLElement): boolean {
    const clone = item.cloneNode(true) as HTMLElement;
    for (const nested of clone.querySelectorAll("ul, ol")) nested.remove();
    const text = (clone.textContent ?? "").replaceAll("​", "").replaceAll(" ", " ").trim();
    return text === "";
  }

  function showRepeatedBlankRuns(): void {
    const children = [...contentEl.children];
    let i = 0;
    while (i < children.length) {
      if (!isBlankLineElement(children[i] ?? null)) {
        i++;
        continue;
      }

      const start = i;
      while (i < children.length && isBlankLineElement(children[i] ?? null)) {
        i++;
      }
      const blanks = children.slice(start, i).filter(isBlankLineElement);
      const visibleBlanks =
        isVisibleContentBlock(children[start - 1] ?? null) &&
        isVisibleContentBlock(children[i] ?? null)
          ? blanks
          : blanks.length > 1
            ? blanks
            : blanks.slice(1);
      for (const blank of visibleBlanks) {
        showBlankLine(blank);
      }
    }
  }

  function updateActiveBlankVisibility(): void {
    for (const blank of contentEl.querySelectorAll(BLANK_LINE_SELECTOR)) {
      if (blank instanceof HTMLElement) {
        hideBlankLine(blank);
      }
    }
    showRepeatedBlankRuns();

    const sel = window.getSelection();
    const anchorNode = sel?.anchorNode;
    const activeBlock = anchorNode ? getIndentableBlock(anchorNode) : null;
    if (!activeBlock) {
      return;
    }

    if (isBlankLineElement(activeBlock)) {
      if (isEditableBlankLineElement(activeBlock)) {
        showActiveBlankLine(activeBlock);
      } else {
        placeCursorNearBlankLine(activeBlock);
      }
      return;
    }

    if (!isEmptyParagraphBlock(activeBlock)) {
      return;
    }

    const paragraphBlock = activeBlock as HTMLElement;
    let previous = paragraphBlock.previousElementSibling;
    while (isBlankLineElement(previous)) {
      showBlankLine(previous);
      previous = previous.previousElementSibling;
    }
    let next = paragraphBlock.nextElementSibling;
    while (isBlankLineElement(next)) {
      showBlankLine(next);
      next = next.nextElementSibling;
    }
  }

  function selectionStartsInBlankLine(): boolean {
    const sel = window.getSelection();
    const blank = sel?.anchorNode ? getBlankLineBlock(sel.anchorNode) : null;
    return blank !== null && blank.contentEditable !== "true";
  }

  function placeCursorNearBlankLine(blank: HTMLElement): void {
    if (isEditableBlankLineElement(blank)) {
      showActiveBlankLine(blank);
      placeCursorAtBlockStart(blank);
      return;
    }
    const nextEditable = getNextElementSibling(blank);
    if (isEditableBlankLineElement(nextEditable)) {
      showActiveBlankLine(nextEditable);
      placeCursorAtBlockStart(nextEditable);
      return;
    }
    const next = getNextElementSibling(blank);
    if (next && !isBlankLineElement(next)) {
      placeCursorAtBlockStart(next);
      return;
    }
    const previousEditable = getPrevElementSibling(blank);
    if (isEditableBlankLineElement(previousEditable)) {
      showActiveBlankLine(previousEditable);
      placeCursorAtBlockEnd(previousEditable);
      return;
    }
    const previous = getPrevElementSibling(blank);
    if (previous && !isBlankLineElement(previous)) {
      placeCursorAtBlockEnd(previous);
      return;
    }
  }

  function getListItemBlock(node: Node): HTMLElement | null {
    const block = getIndentableBlock(node);
    return block && isListItemBlock(block) ? block : null;
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
    const offsets = syncSelectionFromDomMetadata()
      ? modelSelectionToOffsets(state.doc, state.selection)
      : null;
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
      const offsets = syncSelectionFromDomMetadata()
        ? modelSelectionToOffsets(state.doc, state.selection)
        : null;
      if (!offsets) return false;
      undoController.pushUndo(md, offsets.start, offsets.end);
      const { md: newMd, selStart, selEnd } = shiftIndent(md, offsets.start, offsets.end, true);
      renderSelectionAndModel(newMd, selStart, selEnd);
    } else {
      const line = Number(listItem.dataset["mdLineIndex"]);
      if (Number.isInteger(line) && state.doc.lines[line] !== undefined) {
        const column = state.doc.lines[line]!.text.length;
        state = {
          ...state,
          selection: {
            kind: "text",
            anchor: { line, column },
            focus: { line, column },
          },
        };
      } else {
        syncSelectionFromDomMetadata();
      }
      if (commitStructuralTransaction(modelDeleteEmptyListItemBackward(state))) {
        return true;
      }
      return false;
    }
    normalizeEditableContent(contentEl, { preserveActiveEmptyBlock: true });
    syncSelectionFromDomMetadata();
    cfg.onChange?.();
    return true;
  }

  function isEmptyParagraphBlock(block: HTMLElement): boolean {
    if (block.dataset["mdBlank"] === "true" || (block.tagName !== "P" && block.tagName !== "DIV")) {
      return false;
    }
    return (block.textContent ?? "").replaceAll("​", "").trim() === "";
  }

  function handleModelEnter(): boolean {
    if (!syncSelectionFromDomMetadata()) {
      return false;
    }
    return (
      commitStructuralTransaction(modelInsertListParagraph(state)) ||
      commitStructuralTransaction(modelInsertParagraph(state))
    );
  }

  function moveCursorIntoBlankLine(
    blank: HTMLElement,
    activeEmpty?: HTMLElement,
    direction?: "previous" | "next",
  ): void {
    if (!isEditableBlankLineElement(blank)) {
      if (direction === "next") {
        const next = getNextElementSibling(blank);
        if (isEditableBlankLineElement(next)) {
          showActiveBlankLine(next);
          placeCursorAtBlockStart(next);
          return;
        }
        if (next && !isBlankLineElement(next)) {
          placeCursorAtBlockStart(next);
          return;
        }
      }
      if (direction === "previous") {
        const previous = getPrevElementSibling(blank);
        if (isEditableBlankLineElement(previous)) {
          showActiveBlankLine(previous);
          placeCursorAtBlockEnd(previous);
          return;
        }
        if (previous && !isBlankLineElement(previous)) {
          placeCursorAtBlockEnd(previous);
          return;
        }
      }
      placeCursorNearBlankLine(blank);
      return;
    }
    if (activeEmpty) {
      activeEmpty.replaceWith(createBlankLineSpacer());
    }
    const cursorLine = createCursorParagraph();
    blank.replaceWith(cursorLine);
    placeCursorAtBlockStart(cursorLine);
    updateActiveBlankVisibility();
  }

  function handleArrowThroughBlankLines(e: KeyboardEvent): boolean {
    if (
      (e.key !== "ArrowUp" && e.key !== "ArrowDown") ||
      e.shiftKey ||
      e.metaKey ||
      e.ctrlKey ||
      e.altKey
    ) {
      return false;
    }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed || !sel.anchorNode) {
      return false;
    }
    const activeBlock = getIndentableBlock(sel.anchorNode);
    if (!activeBlock) {
      return false;
    }

    const previous = activeBlock.previousElementSibling;
    const next = activeBlock.nextElementSibling;
    if (e.key === "ArrowUp" && isBlankLineElement(previous)) {
      e.preventDefault();
      moveCursorIntoBlankLine(
        previous,
        isEmptyParagraphBlock(activeBlock) ? activeBlock : undefined,
        "previous",
      );
      return true;
    }
    if (e.key === "ArrowDown" && isBlankLineElement(next)) {
      e.preventDefault();
      moveCursorIntoBlankLine(
        next,
        isEmptyParagraphBlock(activeBlock) ? activeBlock : undefined,
        "next",
      );
      return true;
    }
    return false;
  }

  type EditingKeyRouteOptions = {
    history?: boolean;
    blockSelection?: boolean;
    enter?: boolean;
    delete?: "content" | "document";
    arrowBlank?: boolean;
  };

  function routeEditingKey(e: KeyboardEvent, options: EditingKeyRouteOptions): boolean {
    const meta = e.metaKey || e.ctrlKey;
    if (
      e.type === "keydown" &&
      options.history &&
      meta &&
      e.key.toLowerCase() === "z" &&
      !e.shiftKey
    ) {
      e.preventDefault();
      undo();
      return true;
    }
    if (
      e.type === "keydown" &&
      options.history &&
      ((meta && e.shiftKey && e.key.toLowerCase() === "z") || (meta && e.key.toLowerCase() === "y"))
    ) {
      e.preventDefault();
      redo();
      return true;
    }
    if (e.type === "keydown" && options.blockSelection && state.selection.kind === "block") {
      if (e.key === "Escape") {
        e.preventDefault();
        collapseBlockSelectionToStart();
        return true;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        replaceBlockSelection("");
        return true;
      }
      if (e.key.length === 1 && !meta && !e.altKey) {
        e.preventDefault();
        replaceBlockSelection(e.key);
        return true;
      }
    }
    if (e.type === "keydown" && options.enter && e.key === "Enter" && !e.shiftKey) {
      if (handleModelEnter()) {
        suppressNextInsertParagraph = true;
        window.setTimeout(() => {
          suppressNextInsertParagraph = false;
        }, 0);
        e.preventDefault();
        return true;
      }
    }
    if (
      e.type === "keydown" &&
      options.delete !== undefined &&
      (e.key === "Backspace" || e.key === "Delete")
    ) {
      if (
        e.key === "Backspace" &&
        options.delete === "content" &&
        handleEmptyListItemBackspace(e)
      ) {
        return true;
      }
      syncActiveLineFromDom();
      const result =
        e.key === "Backspace"
          ? syncSelectionFromDomMetadata() &&
            (options.delete === "content"
              ? commitStructuralTransaction(modelDeleteEmptyListItemBackward(state)) ||
                commitStructuralTransaction(modelDeleteBackward(state))
              : commitStructuralTransaction(modelDeleteBackward(state)))
          : syncSelectionFromDomMetadata() &&
            commitStructuralTransaction(modelDeleteForward(state));
      if (result) {
        e.preventDefault();
        return true;
      }
    }
    if (options.arrowBlank) {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") {
        return false;
      }
      if (handleArrowThroughBlankLines(e)) {
        arrowNavigationHandled = true;
        return true;
      }
      if (e.type === "keyup") {
        arrowNavigationHandled = false;
      }
    }
    return false;
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.defaultPrevented) {
      return;
    }
    const meta = e.metaKey || e.ctrlKey;
    if (e.key.length === 1 && !meta && !e.altKey && state.selection.kind !== "block") {
      undoController.ensureTypingCheckpoint();
    }
    if (meta && e.key === "s") {
      e.preventDefault();
      e.stopPropagation();
      cfg.onSave?.();
      return;
    }
    if (routeEditingKey(e, { history: true, blockSelection: true })) {
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
    if (e.key === " " || e.key === "\u00A0") {
      const text = blockTransformTextAfterInsert(e.key);
      if (text !== null && state.selection.kind === "text") {
        e.preventDefault();
        const line = state.selection.anchor.line;
        undoController.checkpoint();
        const result = replaceLineText(state, line, text, text.length);
        state = result.state;
        renderModelAfterInputTransform();
        undoController.scheduleTypingCheckpoint();
        cfg.onChange?.();
        return;
      }
    }
    if (routeEditingKey(e, { arrowBlank: true })) {
      return;
    }
    routeEditingKey(e, { delete: "content", enter: true });
  }

  function onDocumentEditingKey(e: KeyboardEvent): void {
    if (e.type === "keydown") {
      arrowNavigationHandled = false;
    } else if (arrowNavigationHandled) {
      arrowNavigationHandled = false;
      return;
    }
    if (e.defaultPrevented || _isSourceMode) {
      return;
    }
    const active = document.activeElement;
    if (
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active instanceof HTMLSelectElement
    ) {
      return;
    }
    if (routeEditingKey(e, { history: true, blockSelection: true })) {
      return;
    }
    const anchor = window.getSelection()?.anchorNode;
    if (anchor === null || anchor === undefined || !contentEl.contains(anchor)) {
      return;
    }
    const meta = e.metaKey || e.ctrlKey;
    if (
      e.type === "keydown" &&
      e.key.length === 1 &&
      !meta &&
      !e.altKey &&
      state.selection.kind !== "block"
    ) {
      undoController.ensureTypingCheckpoint();
    }
    if (routeEditingKey(e, { enter: true, delete: "document", arrowBlank: true })) {
      return;
    }
  }

  function onInput(): void {
    if (
      state.doc.lines.length === 1 &&
      state.doc.lines[0]?.text === "" &&
      (contentEl.textContent ?? "").replaceAll("​", "") !== ""
    ) {
      undoController.pushUndo("", 0, 0);
    }
    if (state.composing) {
      syncActiveLineFromDom();
      undoController.scheduleTypingCheckpoint();
      cfg.onChange?.();
      return;
    }
    const activeBlock = getIndentableBlock(window.getSelection()?.anchorNode ?? contentEl);
    normalizeEditableContent(activeBlock ?? contentEl, { preserveActiveEmptyBlock: true });
    const blank = window.getSelection()?.anchorNode;
    const blankBlock = blank ? getBlankLineBlock(blank) : null;
    if (blankBlock) {
      placeCursorNearBlankLine(blankBlock);
    }
    updateActiveBlankVisibility();
    const lineSynced = syncActiveLineFromDom();
    if (lineSynced && renderModelAfterInputTransform()) {
      undoController.scheduleTypingCheckpoint();
      cfg.onChange?.();
      return;
    }
    if (!lineSynced) syncSelectionFromDomMetadata();
    undoController.scheduleTypingCheckpoint();
    cfg.onChange?.();
  }

  function replaceEmptySelectedLine(text: string): boolean {
    syncSelectionFromDomMetadata();
    if (state.selection.kind !== "text") {
      return false;
    }
    const { anchor, focus } = state.selection;
    if (anchor.line !== focus.line || anchor.column !== focus.column) {
      return false;
    }
    if (state.doc.lines[anchor.line]?.text !== "") {
      return false;
    }
    if (!isEditableBlankModelLine(anchor.line)) {
      return false;
    }
    return commitStructuralTransaction(replaceLine(state, anchor.line, text));
  }

  function onBeforeInput(e: InputEvent): void {
    if (state.composing) {
      return;
    }
    if (e.inputType === "historyUndo") {
      e.preventDefault();
      undo();
      return;
    }
    if (e.inputType === "historyRedo") {
      e.preventDefault();
      redo();
      return;
    }
    if (e.inputType === "insertText" && e.data !== null && state.selection.kind !== "block") {
      syncSelectionFromDomMetadata();
    }
    if (
      e.inputType === "insertText" &&
      e.data !== null &&
      state.doc.lines.length === 1 &&
      state.doc.lines[0]?.text === ""
    ) {
      undoController.pushUndo("", 0, 0);
    }
    if (e.inputType === "insertText" && e.data !== null && state.selection.kind !== "block") {
      undoController.ensureTypingCheckpoint();
    }
    if (state.selection.kind === "block") {
      if (e.inputType === "insertText" && e.data !== null) {
        e.preventDefault();
        replaceBlockSelection(e.data);
        return;
      }
      if (e.inputType === "insertParagraph") {
        e.preventDefault();
        replaceBlockSelection("");
        return;
      }
      if (e.inputType === "deleteContentBackward" || e.inputType === "deleteContentForward") {
        e.preventDefault();
        replaceBlockSelection("");
        return;
      }
    }
    if (
      e.inputType === "insertText" &&
      e.data !== null &&
      state.selection.kind === "text" &&
      state.selection.anchor.line === state.selection.focus.line &&
      state.selection.anchor.column === state.selection.focus.column &&
      state.doc.lines[state.selection.anchor.line]?.text === ""
    ) {
      e.preventDefault();
      replaceEmptySelectedLineInput(e.data);
      return;
    }
    if (e.inputType === "insertText" && e.data !== null) {
      const leadingSpaceText = leadingSpaceTextAfterInsert(e.data);
      if (leadingSpaceText !== null) {
        e.preventDefault();
        const result = replaceLineText(
          state,
          leadingSpaceText.line,
          leadingSpaceText.text,
          leadingSpaceText.text.length,
        );
        state = result.state;
        renderPlainLineHost(leadingSpaceText.line, leadingSpaceText.text);
        undoController.scheduleTypingCheckpoint();
        cfg.onChange?.();
        return;
      }
      const plainMarkerText = plainMarkerPrefixTextAfterInsert(e.data);
      if (plainMarkerText !== null && state.selection.kind === "text") {
        e.preventDefault();
        const line = state.selection.anchor.line;
        const result = replaceLineText(state, line, plainMarkerText);
        state = result.state;
        renderPlainLineHost(line, plainMarkerText);
        undoController.scheduleTypingCheckpoint();
        cfg.onChange?.();
        return;
      }
      const text = blockTransformTextAfterInsert(e.data);
      if (text !== null && state.selection.kind === "text") {
        e.preventDefault();
        const line = state.selection.anchor.line;
        undoController.checkpoint();
        const result = replaceLineText(state, line, text, text.length);
        state = result.state;
        renderModelAfterInputTransform();
        undoController.scheduleTypingCheckpoint();
        cfg.onChange?.();
        return;
      }
    }
    if (e.inputType === "insertParagraph") {
      if (suppressNextInsertParagraph) {
        suppressNextInsertParagraph = false;
        e.preventDefault();
        return;
      }
      if (handleModelEnter()) {
        e.preventDefault();
        return;
      }
    }
    if (e.inputType === "deleteContentBackward") {
      if (
        syncSelectionFromDomMetadata() &&
        commitStructuralTransaction(modelDeleteBackward(state))
      ) {
        e.preventDefault();
        return;
      }
    }
    if (e.inputType === "deleteContentForward") {
      if (
        syncSelectionFromDomMetadata() &&
        commitStructuralTransaction(modelDeleteForward(state))
      ) {
        e.preventDefault();
        return;
      }
    }
    if (selectionStartsInBlankLine()) {
      e.preventDefault();
      preferPlainTextPaste = false;
      return;
    }
    if (e.inputType !== "insertFromPaste" && e.inputType !== "insertFromPasteAsQuotation") {
      preferPlainTextPaste = false;
      return;
    }
    const dataTransfer = e.dataTransfer;
    preferPlainTextPaste = dataTransfer !== null && hasPlainTextOnlyPaste(dataTransfer);
  }

  function onCheckboxEvent(e: Event): void {
    if (e.target instanceof HTMLInputElement && e.target.type === "checkbox") {
      const host = e.target.closest("[data-md-line-index]");
      if (!(host instanceof HTMLElement)) {
        cfg.onChange?.();
        return;
      }
      const lineIndex = Number(host.dataset["mdLineIndex"]);
      const line = Number.isInteger(lineIndex) ? state.doc.lines[lineIndex] : undefined;
      if (!line) {
        cfg.onChange?.();
        return;
      }
      const marker = e.target.checked ? "[x]" : "[ ]";
      const text = line.text.replace(/\[([ xX])\]/, marker);
      if (text === line.text) {
        cfg.onChange?.();
        return;
      }
      undoController.checkpoint();
      const column =
        state.selection.kind === "text"
          ? Math.min(state.selection.anchor.column, text.length)
          : text.length;
      state = replaceLineText(state, lineIndex, text, column).state;
      renderCurrentModel();
      undoController.scheduleTypingCheckpoint();
      cfg.onChange?.();
    }
  }

  function onContentPaste(e: ClipboardEvent): void {
    void pasteHandler.onPaste(e);
  }

  function onContentCopy(e: ClipboardEvent): void {
    copyBlockSelection(e);
  }

  function onContentCut(e: ClipboardEvent): void {
    if (copyBlockSelection(e)) {
      replaceBlockSelection("");
    }
  }

  function onContentSelectionCommit(): void {
    if (_isSourceMode || state.selection.kind === "block") return;
    syncSelectionFromDomMetadata();
  }

  function onCompositionStart(): void {
    state = { ...state, composing: true };
  }

  function onCompositionEnd(): void {
    state = { ...state, composing: false };
    syncActiveLineFromDom();
    renderModelAfterInputTransform();
    cfg.onChange?.();
  }

  function onContentPointerDown(e: PointerEvent): void {
    const handle = getBlockHandle(e.target);
    if (handle) {
      e.preventDefault();
      const blockId = handle.dataset["mdBlockHandle"];
      if (blockId) {
        contentEl.focus();
        selectBlock(blockId, e.shiftKey);
      }
      return;
    }
    const blank = getBlankLineBlock(e.target instanceof Node ? e.target : null);
    if (!blank) return;
    e.preventDefault();
    placeCursorNearBlankLine(blank);
  }

  contentEl.addEventListener("keydown", onKeyDown);
  contentEl.addEventListener("beforeinput", onBeforeInput);
  contentEl.addEventListener("input", onInput);
  contentEl.addEventListener("compositionstart", onCompositionStart);
  contentEl.addEventListener("compositionend", onCompositionEnd);
  contentEl.addEventListener("keyup", onContentSelectionCommit);
  contentEl.addEventListener("mouseup", onContentSelectionCommit);
  contentEl.addEventListener("paste", onContentPaste);
  contentEl.addEventListener("copy", onContentCopy);
  contentEl.addEventListener("cut", onContentCut);
  contentEl.addEventListener("change", onCheckboxEvent);
  contentEl.addEventListener("click", onCheckboxEvent);
  contentEl.addEventListener("pointerdown", onContentPointerDown);
  contentEl.addEventListener("pointerdown", imageResizeController.onImagePointerDown);
  window.addEventListener("keydown", onDocumentEditingKey, true);
  window.addEventListener("keyup", onDocumentEditingKey, true);
  document.addEventListener("pointermove", imageResizeController.onDocumentPointerMove);
  document.addEventListener("pointerup", imageResizeController.endImageResize);
  document.addEventListener("pointercancel", imageResizeController.endImageResize);
  sourceEl.addEventListener("input", sourceModeController.onSourceInput);
  sourceEl.addEventListener("keydown", sourceModeController.onSourceKeyDown);

  function setConfig(partial: Partial<EditorConfig>): void {
    cfg = { ...cfg, ...partial };
    if (partial.contentClassName !== undefined) contentEl.className = partial.contentClassName;
    if (partial.sourceClassName !== undefined) sourceEl.className = partial.sourceClassName;
  }

  function focus(): void {
    if (_isSourceMode) {
      sourceEl.focus();
      return;
    }
    contentEl.focus();
    restoreDomSelectionFromModel();
  }

  function setReadOnly(readonly: boolean): void {
    contentEl.contentEditable = readonly ? "false" : "true";
    sourceEl.readOnly = readonly;
    if (readonly) {
      contentEl.setAttribute("aria-readonly", "true");
    } else {
      contentEl.removeAttribute("aria-readonly");
    }
  }

  function containsEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Node)) {
      return false;
    }
    return contentEl.contains(target) || sourceEl.contains(target);
  }

  function destroy(): void {
    undoController.destroy();
    contentEl.removeEventListener("keydown", onKeyDown);
    contentEl.removeEventListener("beforeinput", onBeforeInput);
    contentEl.removeEventListener("input", onInput);
    contentEl.removeEventListener("compositionstart", onCompositionStart);
    contentEl.removeEventListener("compositionend", onCompositionEnd);
    contentEl.removeEventListener("keyup", onContentSelectionCommit);
    contentEl.removeEventListener("mouseup", onContentSelectionCommit);
    contentEl.removeEventListener("paste", onContentPaste);
    contentEl.removeEventListener("copy", onContentCopy);
    contentEl.removeEventListener("cut", onContentCut);
    contentEl.removeEventListener("change", onCheckboxEvent);
    contentEl.removeEventListener("click", onCheckboxEvent);
    contentEl.removeEventListener("pointerdown", onContentPointerDown);
    contentEl.removeEventListener("pointerdown", imageResizeController.onImagePointerDown);
    window.removeEventListener("keydown", onDocumentEditingKey, true);
    window.removeEventListener("keyup", onDocumentEditingKey, true);
    document.removeEventListener("pointermove", imageResizeController.onDocumentPointerMove);
    document.removeEventListener("pointerup", imageResizeController.endImageResize);
    document.removeEventListener("pointercancel", imageResizeController.endImageResize);
    sourceEl.removeEventListener("input", sourceModeController.onSourceInput);
    sourceEl.removeEventListener("keydown", sourceModeController.onSourceKeyDown);
    contentEl.remove();
    sourceEl.remove();
  }

  return {
    getValue,
    getSnapshot,
    setValue,
    getSelectionOffsets,
    getCursorOffset,
    applyFormat,
    undo,
    redo,
    toggleSourceMode: sourceModeController.toggleSourceMode,
    setReadOnly,
    containsEditableTarget,
    focus,
    setConfig,
    get isSourceMode() {
      return _isSourceMode;
    },
    get isReadOnly() {
      return contentEl.contentEditable === "false";
    },
    contentEl,
    sourceEl,
    destroy,
  };
}
