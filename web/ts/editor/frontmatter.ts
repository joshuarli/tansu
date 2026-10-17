import type { EditorState } from "@codemirror/state";

export type FrontmatterRange = {
  from: number;
  to: number;
  foldTo: number;
  closingLine: number;
};

export function frontmatterRange(state: EditorState): FrontmatterRange | null {
  const firstLine = state.doc.line(1);
  if (firstLine.text !== "---" && firstLine.text !== "\uFEFF---") return null;

  let closingLine = 0;
  for (let number = 2; number <= state.doc.lines; number++) {
    if (state.doc.line(number).text === "---") {
      closingLine = number;
      break;
    }
  }
  if (closingLine === 0) return null;

  const foldTo = state.doc.line(closingLine).to;
  let to = foldTo;
  while (to < state.doc.length && state.doc.sliceString(to, to + 1) === "\n") to++;
  return { from: firstLine.from, to, foldTo, closingLine };
}
