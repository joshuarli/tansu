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

export type SelectionTransactionController = {
  applySelectionEdit(op: (md: string, selStart: number, selEnd: number) => FormatResult): boolean;
  replaceSelection(text: string): boolean;
};

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

  function replaceSelection(text: string): boolean {
    const md = opts.getValue();
    const selection = opts.getSelectionOffsets();
    const start = selection?.start ?? md.length;
    const end = selection?.end ?? start;
    opts.checkpoint();
    commit({
      md: md.slice(0, start) + text + md.slice(end),
      selStart: start + text.length,
      selEnd: start + text.length,
    });
    return true;
  }

  return {
    applySelectionEdit,
    replaceSelection,
  };
}
