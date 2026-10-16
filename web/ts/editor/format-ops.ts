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
