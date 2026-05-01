import type { MarkdownExtension } from "./extension.js";
import { domToMarkdown, getCursorMarkdownOffset } from "./serialize.js";
import { clampNodeOffset, CURSOR_SENTINEL } from "./util.js";

export type SelectionOffsets = {
  start: number;
  end: number;
};

type EditorSelectionController = {
  getSelectionOffsets(): SelectionOffsets | null;
  getCursorOffset(): number;
  restoreSelectionFromRenderedMarkers(): void;
  restoreCursorMarker(scroll?: boolean): void;
  placeCursorAtEnd(): void;
};

export function createEditorSelectionController(
  contentEl: HTMLElement,
  extensions: readonly MarkdownExtension[],
): EditorSelectionController {
  const renderOpts = { extensions: [...extensions] };

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
      const range = document.createRange();
      range.setStartAfter(startSpan);
      range.setEndBefore(endSpan);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {
      /* degrade gracefully */
    }
    startSpan.remove();
    endSpan.remove();
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

  function getSelectionOffsets(): SelectionOffsets | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!contentEl.contains(range.startContainer) || !contentEl.contains(range.endContainer)) {
      return null;
    }

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

  return {
    getSelectionOffsets,
    getCursorOffset,
    restoreSelectionFromRenderedMarkers,
    restoreCursorMarker,
    placeCursorAtEnd,
  };
}

export function isRangeAtStartOfBlock(range: Range, block: HTMLElement): boolean {
  const before = range.cloneRange();
  before.selectNodeContents(block);
  before.setEnd(range.startContainer, clampNodeOffset(range.startContainer, range.startOffset));
  return before.toString().replaceAll("​", "") === "";
}
