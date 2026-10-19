import type { EditorState, Text } from "@codemirror/state";

export type FrontmatterRange =
  | { from: number; to: number; foldTo: number; kind: "closed" }
  | { from: number; to: number; foldTo: number; kind: "unterminated" };

export function frontmatterRange(source: EditorState | Text): FrontmatterRange | null {
  const doc = "doc" in source ? source.doc : source;
  const firstLine = doc.line(1);
  if (firstLine.text !== "---" && firstLine.text !== "\uFEFF---") return null;

  let closingLine: number | null = null;
  for (let number = 2; number <= doc.lines; number++) {
    if (doc.line(number).text === "---") {
      closingLine = number;
      break;
    }
  }
  const foldTo = closingLine === null ? doc.length : doc.line(closingLine).to;
  let to = foldTo;
  while (to < doc.length && doc.sliceString(to, to + 1) === "\n") to++;
  return closingLine === null
    ? { from: firstLine.from, to, foldTo, kind: "unterminated" }
    : { from: firstLine.from, to, foldTo, kind: "closed" };
}
