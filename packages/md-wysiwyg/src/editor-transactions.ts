import type { SelectionOffsets } from "./editor-selection.js";
import type { FormatResult } from "./format-ops.js";

type SelectionTransactionOptions = {
  getValue: () => string;
  getSelectionOffsets: () => SelectionOffsets | null;
  pushUndo: (md: string, selStart: number, selEnd: number) => void;
  checkpoint: () => void;
  renderSelection: (md: string, selStart: number, selEnd: number) => void;
  restoreSelection: () => void;
  onChange?: () => void;
};

type SelectionTransactionController = {
  applySelectionEdit(op: (md: string, selStart: number, selEnd: number) => FormatResult): boolean;
  replaceSelection(text: string, selectionOverride?: SelectionOffsets): boolean;
};

function countLeadingNewlines(text: string): number {
  let count = 0;
  while (count < text.length && text[count] === "\n") {
    count++;
  }
  return count;
}

function countTrailingNewlines(text: string): number {
  let count = 0;
  while (count < text.length && text[text.length - 1 - count] === "\n") {
    count++;
  }
  return count;
}

function normalizeBlockPasteInsertion(before: string, text: string, after: string): string {
  if (!text.includes("\n\n")) {
    return text;
  }

  let normalized = text;
  if (before !== "" && normalized !== "") {
    const boundaryNewlines = countTrailingNewlines(before) + countLeadingNewlines(normalized);
    if (boundaryNewlines < 2) {
      normalized = `${"\n".repeat(2 - boundaryNewlines)}${normalized}`;
    }
  }

  if (after !== "" && normalized !== "") {
    const boundaryNewlines = countTrailingNewlines(normalized) + countLeadingNewlines(after);
    if (boundaryNewlines < 2) {
      normalized = `${normalized}${"\n".repeat(2 - boundaryNewlines)}`;
    }
  }

  return normalized;
}

export function createSelectionTransactionController(
  opts: Readonly<SelectionTransactionOptions>,
): SelectionTransactionController {
  function commit(result: FormatResult): void {
    opts.renderSelection(result.md, result.selStart, result.selEnd);
    opts.restoreSelection();
    opts.onChange?.();
  }

  function applySelectionEdit(
    op: (md: string, selStart: number, selEnd: number) => FormatResult,
  ): boolean {
    const selection = opts.getSelectionOffsets();
    if (!selection) return false;
    const md = opts.getValue();
    opts.pushUndo(md, selection.start, selection.end);
    commit(op(md, selection.start, selection.end));
    return true;
  }

  function replaceSelection(text: string, selectionOverride?: SelectionOffsets): boolean {
    const md = opts.getValue();
    const selection = selectionOverride ?? opts.getSelectionOffsets();
    const start = selection?.start ?? md.length;
    const end = selection?.end ?? start;
    const replacement = normalizeBlockPasteInsertion(md.slice(0, start), text, md.slice(end));
    opts.checkpoint();
    commit({
      md: md.slice(0, start) + replacement + md.slice(end),
      selStart: start + replacement.length,
      selEnd: start + replacement.length,
    });
    return true;
  }

  return {
    applySelectionEdit,
    replaceSelection,
  };
}
