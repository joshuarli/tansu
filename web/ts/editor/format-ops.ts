export type FormatResult = {
  md: string;
  selStart: number;
  selEnd: number;
};

function splitSelectedBlocks(slice: string): string[] {
  return slice.split("\n\n");
}

function toggleMarkerAcrossBlocks(
  md: string,
  start: number,
  end: number,
  marker: string,
  isWrappedBlock?: (block: string) => boolean,
): FormatResult {
  const n = marker.length;
  const slice = md.slice(start, end);
  const blocks = splitSelectedBlocks(slice);
  const nonEmpty = blocks.filter((block) => block.trim().length > 0);
  const wrapped =
    isWrappedBlock ?? ((block: string) => block.startsWith(marker) && block.endsWith(marker));

  const allWrapped =
    nonEmpty.length > 0 && nonEmpty.every((block) => block.length >= 2 * n && wrapped(block));

  const newSlice = blocks
    .map((block) => {
      if (block.trim().length === 0) {
        return block;
      }
      if (allWrapped && wrapped(block) && block.length >= 2 * n) {
        return block.slice(n, block.length - n);
      }
      if (allWrapped) {
        return block;
      }
      return `${marker}${block}${marker}`;
    })
    .join("\n\n");

  return {
    md: md.slice(0, start) + newSlice + md.slice(end),
    selStart: start,
    selEnd: end + (allWrapped ? -nonEmpty.length * 2 * n : nonEmpty.length * 2 * n),
  };
}

function toggleMarker(md: string, start: number, end: number, marker: string): FormatResult {
  const n = marker.length;
  if (md.slice(start, end).includes("\n\n")) {
    return toggleMarkerAcrossBlocks(md, start, end, marker);
  }
  const isWrapped =
    start >= n &&
    end + n <= md.length &&
    md.slice(start - n, start) === marker &&
    md.slice(end, end + n) === marker;

  if (isWrapped) {
    const newMd = md.slice(0, start - n) + md.slice(start, end) + md.slice(end + n);
    return { md: newMd, selStart: start - n, selEnd: end - n };
  }

  const newMd = md.slice(0, start) + marker + md.slice(start, end) + marker + md.slice(end);
  return { md: newMd, selStart: start + n, selEnd: end + n };
}

export function toggleBold(md: string, start: number, end: number): FormatResult {
  return toggleMarker(md, start, end, "**");
}

export function toggleItalic(md: string, start: number, end: number): FormatResult {
  if (md.slice(start, end).includes("\n\n")) {
    return toggleMarkerAcrossBlocks(
      md,
      start,
      end,
      "*",
      (block) =>
        block.startsWith("*") &&
        block.endsWith("*") &&
        !block.startsWith("**") &&
        !block.endsWith("**"),
    );
  }
  const n = 1;
  const marker = "*";

  const hasSingleStarBefore = start >= n && md.slice(start - n, start) === marker;
  const hasSingleStarAfter = end + n <= md.length && md.slice(end, end + n) === marker;
  const hasBoldBefore = start >= 2 && md.slice(start - 2, start) === "**";
  const hasBoldAfter = end + 2 <= md.length && md.slice(end, end + 2) === "**";

  const isWrapped = hasSingleStarBefore && hasSingleStarAfter && !hasBoldBefore && !hasBoldAfter;

  if (isWrapped) {
    const newMd = md.slice(0, start - n) + md.slice(start, end) + md.slice(end + n);
    return { md: newMd, selStart: start - n, selEnd: end - n };
  }

  const newMd = md.slice(0, start) + marker + md.slice(start, end) + marker + md.slice(end);
  return { md: newMd, selStart: start + n, selEnd: end + n };
}

export function toggleStrikethrough(md: string, start: number, end: number): FormatResult {
  return toggleMarker(md, start, end, "~~");
}

export function toggleHighlight(md: string, start: number, end: number): FormatResult {
  return toggleMarker(md, start, end, "==");
}

export function clearInlineFormats(md: string, start: number, end: number): FormatResult {
  const slice = md.slice(start, end);
  const stripped = slice
    .replaceAll("**", "")
    .replaceAll("~~", "")
    .replaceAll("==", "")
    .replaceAll("`", "")
    .replaceAll("*", "")
    .replaceAll("_", "");
  const newMd = md.slice(0, start) + stripped + md.slice(end);
  return { md: newMd, selStart: start, selEnd: start + stripped.length };
}

function lineStart(md: string, offset: number): number {
  const idx = md.lastIndexOf("\n", offset - 1);
  return idx === -1 ? 0 : idx + 1;
}

function lineEnd(md: string, offset: number): number {
  const idx = md.indexOf("\n", offset);
  return idx === -1 ? md.length : idx;
}

export function toggleHeading(
  md: string,
  selStart: number,
  level: 1 | 2 | 3 | 4 | 5 | 6,
): FormatResult {
  const ls = lineStart(md, selStart);
  const le = lineEnd(md, selStart);
  const line = md.slice(ls, le);

  const existingMatch = line.match(/^(#{1,6})\s/);
  const existingPrefix = existingMatch ? existingMatch[0] : "";
  const existingLevel = existingMatch ? existingMatch[1]!.length : 0;

  const newPrefix = existingLevel === level ? "" : `${"#".repeat(level)} `;

  const delta = newPrefix.length - existingPrefix.length;
  const newLine = newPrefix + line.slice(existingPrefix.length);
  const newMd = md.slice(0, ls) + newLine + md.slice(le);

  const newSelStart = Math.max(ls, selStart + delta);
  return { md: newMd, selStart: newSelStart, selEnd: newSelStart };
}

export function toggleCodeFence(md: string, selStart: number, selEnd: number): FormatResult {
  const ls = lineStart(md, selStart);
  const le = lineEnd(md, selEnd);

  const prevLineEnd = ls > 0 ? ls - 1 : 0;
  const prevLineStart = prevLineEnd > 0 ? lineStart(md, prevLineEnd - 1) : 0;
  const prevLine = prevLineEnd > 0 ? md.slice(prevLineStart, prevLineEnd) : "";

  const afterLe = le < md.length ? le + 1 : le;
  const nextLineEnd = lineEnd(md, afterLe);
  const nextLine = le < md.length ? md.slice(afterLe, nextLineEnd) : "";

  if (prevLine.trimEnd() === "```" && nextLine.trimEnd() === "```") {
    const fenceBeforeStart = prevLineStart;
    const fenceBeforeEnd = prevLineEnd + 1;

    const removedBefore = fenceBeforeEnd - fenceBeforeStart;

    const before = md.slice(0, fenceBeforeStart);
    const content = md.slice(fenceBeforeEnd, le);
    const afterFenceEnd = nextLineEnd < md.length ? nextLineEnd + 1 : nextLineEnd;
    const rest = md.slice(afterFenceEnd);

    const newMd = before + content + (rest ? "\n" + rest : "");
    const newSelStart = Math.max(fenceBeforeStart, selStart - removedBefore);
    const newSelEnd = Math.max(newSelStart, selEnd - removedBefore);
    return { md: newMd, selStart: newSelStart, selEnd: newSelEnd };
  }

  const before = md.slice(0, ls);
  const content = md.slice(ls, le);
  const after = md.slice(le);

  const newMd = `${before}\`\`\`\n${content}\n\`\`\`${after}`;
  const newSelStart = selStart + 4;
  const newSelEnd = selEnd + 4;
  return { md: newMd, selStart: newSelStart, selEnd: newSelEnd };
}

import { LIST_INDENT_SPACES } from "./constants.js";

export function shiftIndent(
  md: string,
  selStart: number,
  selEnd: number,
  dedent: boolean,
): FormatResult {
  const firstLineStart = lineStart(md, selStart);
  const lastLineEnd = lineEnd(md, selEnd);

  const linesStr = md.slice(firstLineStart, lastLineEnd);
  const lines = linesStr.split("\n");

  let newSelStart = selStart;
  let newSelEnd = selEnd;
  let offset = 0;

  const transformed: string[] = [];
  let lineOffset = firstLineStart;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineAbsStart = lineOffset;

    let newLine: string;
    let delta: number;

    if (dedent) {
      if (line.startsWith("\t")) {
        newLine = line.slice(1);
        delta = -1;
      } else {
        const spaceMatch = line.match(new RegExp(`^ {1,${LIST_INDENT_SPACES}}`));
        if (spaceMatch) {
          newLine = line.slice(spaceMatch[0].length);
          delta = -spaceMatch[0].length;
        } else {
          newLine = line;
          delta = 0;
        }
      }
    } else {
      newLine = `${" ".repeat(LIST_INDENT_SPACES)}${line}`;
      delta = LIST_INDENT_SPACES;
    }

    transformed.push(newLine);

    if (selStart >= lineAbsStart + (i > 0 ? 1 : 0) && selStart <= lineAbsStart + line.length) {
      newSelStart =
        dedent && delta < 0
          ? Math.max(lineAbsStart + offset, selStart + offset + delta)
          : selStart + offset + delta;
    }
    if (selEnd >= lineAbsStart && selEnd <= lineAbsStart + line.length) {
      newSelEnd = Math.max(
        newSelStart,
        dedent && delta < 0
          ? Math.max(lineAbsStart + offset, selEnd + offset + delta)
          : selEnd + offset + delta,
      );
    }

    offset += delta;
    lineOffset += line.length + 1;
  }

  const newContent = transformed.join("\n");
  const newMd = md.slice(0, firstLineStart) + newContent + md.slice(lastLineEnd);

  return {
    md: newMd,
    selStart: Math.max(0, newSelStart),
    selEnd: Math.max(0, newSelEnd),
  };
}
