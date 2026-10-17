import { syntaxTree } from "@codemirror/language";
import type { ChangeSpec, EditorState } from "@codemirror/state";
import { frontmatterRange } from "./frontmatter.js";

export type SourceBlock = {
  from: number;
  to: number;
  list: number | null;
};

export type BlockMove = {
  changes: ChangeSpec;
  movedFrom: number;
  movedTo: number;
};

const MOVABLE_BLOCKS = new Set([
  "Paragraph",
  "ATXHeading1",
  "ATXHeading2",
  "ATXHeading3",
  "ATXHeading4",
  "ATXHeading5",
  "ATXHeading6",
  "SetextHeading1",
  "SetextHeading2",
  "FencedCode",
  "CodeBlock",
  "Table",
  "Blockquote",
  "HorizontalRule",
  "HTMLBlock",
]);

export function topLevelBlocks(state: EditorState): SourceBlock[] {
  const frontmatter = frontmatterRange(state);
  const start = frontmatter?.to ?? 0;
  const blocks: SourceBlock[] = [];
  const cursor = syntaxTree(state).topNode.cursor();
  if (!cursor.firstChild()) return blocks;
  do {
    if (cursor.from < start || cursor.from >= cursor.to) continue;
    if (MOVABLE_BLOCKS.has(cursor.name)) {
      blocks.push({ from: cursor.from, to: cursor.to, list: null });
    } else if (cursor.name === "BulletList" || cursor.name === "OrderedList") {
      const list = cursor.node;
      for (let item = list.firstChild; item !== null; item = item.nextSibling) {
        if (item.name === "ListItem") blocks.push({ from: item.from, to: item.to, list: list.from });
      }
    }
  } while (cursor.nextSibling());
  return blocks;
}

export function blockIndexAt(blocks: readonly SourceBlock[], position: number): number {
  return blocks.findIndex((block) => position >= block.from && position <= block.to);
}

function newlineCount(text: string): number {
  return text.split("\n").length - 1;
}

function blockSeparator(gap: string | null, listItem: boolean): string {
  return gap !== null && newlineCount(gap) >= (listItem ? 1 : 2) ? gap : listItem ? "\n" : "\n\n";
}

export function planBlockMove(
  state: EditorState,
  blocks: readonly SourceBlock[],
  index: number,
  gap: number,
): BlockMove | null {
  const moved = blocks[index];
  if (moved === undefined || gap < 0 || gap > blocks.length) return null;
  if (gap === index || gap === index + 1) return null;
  const text = state.sliceDoc(moved.from, moved.to);
  const previous = blocks[index - 1];
  const next = blocks[index + 1];
  const removeBefore = previous !== undefined &&
    (next === undefined || (moved.list !== null && previous.list === moved.list) ||
      !(moved.list !== null && next.list === moved.list));
  const removal = removeBefore
    ? { from: previous.to, to: moved.to }
    : { from: moved.from, to: next!.from };
  const removedLength = removal.to - removal.from;
  const listItem = moved.list !== null;

  const target = blocks[gap];
  const before = blocks[gap - 1];
  let insertAt: number;
  let insert: string;
  let textOffset: number;
  if (before === undefined) {
    const sameList = listItem && target!.list !== null;
    const separator = sameList ? "\n" : blockSeparator(state.sliceDoc(target!.to, blocks[1]!.from), false);
    insertAt = target!.from;
    insert = text + separator;
    textOffset = 0;
  } else {
    const between = target !== undefined
      ? state.sliceDoc(before.to, target.from)
      : blocks[gap - 2] !== undefined
      ? state.sliceDoc(blocks[gap - 2]!.to, before.from)
      : null;
    const separator = listItem && before.list !== null ? "\n" : blockSeparator(between, false);
    insertAt = before.to;
    insert = separator + text;
    textOffset = separator.length;
  }
  const movedFrom = (insertAt >= removal.to ? insertAt - removedLength : insertAt) + textOffset;
  return {
    changes: [removal, { from: insertAt, insert }],
    movedFrom,
    movedTo: movedFrom + text.length,
  };
}
