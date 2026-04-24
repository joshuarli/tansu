type EditorEvent =
  | { type: "undo" | "redo" }
  | {
      type: "format";
      kind: "bold" | "italic" | "highlight" | "strikethrough" | "heading" | "code-block";
      detail?: string;
    }
  | { type: "block-transform"; trigger: "space" | "enter"; to: string }
  | { type: "inline-transform"; tag: string }
  | { type: "indent"; direction: "in" | "out" }
  | { type: "paste"; kind: "image" | "text" }
  | { type: "save"; path: string; trigger: "manual" | "auto" };

// No-op hook point. Wire in subscribers here when needed.
export function dispatchEditorAction(_e: EditorEvent): void {
  /* intentional no-op */
}
