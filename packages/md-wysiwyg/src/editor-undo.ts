import type { SelectionOffsets } from "./editor-selection.js";

type UndoEntry = {
  md: string;
  selStart: number;
  selEnd: number;
};

type UndoControllerOptions = {
  getValue: () => string;
  getSelectionOffsets: () => SelectionOffsets | null;
  renderSelection: (md: string, selStart: number, selEnd: number) => void;
  restoreSelection: () => void;
  getUndoStackMax: () => number;
  getTypingCheckpointMs: () => number;
  onChange?: () => void;
};

export type EditorUndoController = {
  pushUndo(md: string, selStart: number, selEnd: number): void;
  checkpoint(): void;
  scheduleTypingCheckpoint(): void;
  clearTypingCheckpoint(): void;
  undo(): void;
  redo(): void;
  destroy(): void;
};

export function createEditorUndoController(
  opts: Readonly<UndoControllerOptions>,
): EditorUndoController {
  const undoStack: UndoEntry[] = [];
  let undoIndex = -1;
  let typingTimer: ReturnType<typeof setTimeout> | null = null;

  function pushUndo(md: string, selStart: number, selEnd: number): void {
    undoStack.splice(undoIndex + 1);
    const top = undoStack[undoIndex];
    if (top && top.md === md && top.selStart === selStart && top.selEnd === selEnd) return;
    undoStack.push({ md, selStart, selEnd });
    if (undoStack.length > opts.getUndoStackMax()) {
      undoStack.shift();
      return;
    }
    undoIndex++;
  }

  function clearTypingCheckpoint(): void {
    if (typingTimer !== null) {
      clearTimeout(typingTimer);
      typingTimer = null;
    }
  }

  function checkpoint(): void {
    clearTypingCheckpoint();
    const md = opts.getValue();
    const sel = opts.getSelectionOffsets();
    pushUndo(md, sel?.start ?? 0, sel?.end ?? 0);
  }

  function scheduleTypingCheckpoint(): void {
    clearTypingCheckpoint();
    typingTimer = setTimeout(() => {
      typingTimer = null;
      const md = opts.getValue();
      const sel = opts.getSelectionOffsets();
      pushUndo(md, sel?.start ?? 0, sel?.end ?? 0);
    }, opts.getTypingCheckpointMs());
  }

  function undo(): void {
    checkpoint();
    if (undoIndex <= 0) return;
    undoIndex--;
    const entry = undoStack[undoIndex]!;
    opts.renderSelection(entry.md, entry.selStart, entry.selEnd);
    opts.restoreSelection();
    opts.onChange?.();
  }

  function redo(): void {
    if (undoIndex >= undoStack.length - 1) return;
    undoIndex++;
    const entry = undoStack[undoIndex]!;
    opts.renderSelection(entry.md, entry.selStart, entry.selEnd);
    opts.restoreSelection();
    opts.onChange?.();
  }

  return {
    pushUndo,
    checkpoint,
    scheduleTypingCheckpoint,
    clearTypingCheckpoint,
    undo,
    redo,
    destroy() {
      clearTypingCheckpoint();
    },
  };
}
