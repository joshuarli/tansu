export interface LoupeImageOccurrence {
  alt: string;
  destination: string;
  start: number;
  end: number;
  linkedImage?: {
    destination: string;
    start: number;
    end: number;
  };
}

interface CodeRange {
  start: number;
  end: number;
}

function computeCodeRanges(markdown: string): CodeRange[] {
  const ranges: CodeRange[] = [];
  const lineStarts: number[] = [0];
  for (let i = 0; i < markdown.length; i++) {
    if (markdown[i] === "\n") {
      lineStarts.push(i + 1);
    }
  }
  let openFence: { char: string; length: number; start: number } | null = null;
  for (let lineIndex = 0; lineIndex < lineStarts.length; lineIndex++) {
    const lineStart = lineStarts[lineIndex] as number;
    const lineEnd =
      lineIndex + 1 < lineStarts.length ? (lineStarts[lineIndex + 1] as number) - 1 : markdown.length;
    const line = markdown.slice(lineStart, lineEnd);
    const fenceMatch = /^( {0,3})(`{3,}|~{3,})/.exec(line);
    if (fenceMatch === null) {
      continue;
    }
    const fenceRun = fenceMatch[2] as string;
    const fenceChar = fenceRun[0] as string;
    const rest = line.slice(fenceMatch[0].length);
    if (openFence === null) {
      if (fenceChar === "`" && rest.includes("`")) {
        continue;
      }
      openFence = { char: fenceChar, length: fenceRun.length, start: lineStart };
    } else if (
      fenceChar === openFence.char &&
      fenceRun.length >= openFence.length &&
      /^[ \t]*$/.test(rest)
    ) {
      ranges.push({ start: openFence.start, end: lineEnd });
      openFence = null;
    }
  }
  if (openFence !== null) {
    ranges.push({ start: openFence.start, end: markdown.length });
  }

  let cursor = 0;
  const segments: CodeRange[] = [];
  for (const range of ranges) {
    if (cursor < range.start) {
      segments.push({ start: cursor, end: range.start });
    }
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < markdown.length) {
    segments.push({ start: cursor, end: markdown.length });
  }
  for (const segment of segments) {
    let i = segment.start;
    while (i < segment.end) {
      if (markdown[i] !== "`") {
        i++;
        continue;
      }
      let runLength = 0;
      while (markdown[i + runLength] === "`") {
        runLength++;
      }
      let j = i + runLength;
      let closed = false;
      while (j < segment.end) {
        if (markdown[j] !== "`") {
          j++;
          continue;
        }
        let closeLength = 0;
        while (markdown[j + closeLength] === "`") {
          closeLength++;
        }
        if (closeLength === runLength) {
          ranges.push({ start: i, end: j + closeLength });
          i = j + closeLength;
          closed = true;
          break;
        }
        j += closeLength;
      }
      if (!closed) {
        i += runLength;
      }
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  return ranges;
}

function isMarkdownSpace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n";
}

function parseLinkTitle(markdown: string, pos: number): number | null {
  const opener = markdown[pos];
  if (opener === '"' || opener === "'") {
    let i = pos + 1;
    while (i < markdown.length) {
      const char = markdown[i];
      if (char === "\\") {
        i += 2;
        continue;
      }
      if (char === opener) {
        return i + 1;
      }
      i++;
    }
    return null;
  }
  if (opener === "(") {
    let i = pos + 1;
    let depth = 1;
    while (i < markdown.length) {
      const char = markdown[i];
      if (char === "\\") {
        i += 2;
        continue;
      }
      if (char === "(") {
        depth++;
      } else if (char === ")") {
        depth--;
        if (depth === 0) {
          return i + 1;
        }
      }
      i++;
    }
    return null;
  }
  return null;
}

function parseLinkDestination(
  markdown: string,
  pos: number,
): { destination: string; end: number } | null {
  let i = pos;
  while (isMarkdownSpace(markdown[i])) {
    i++;
  }
  let destination: string;
  if (markdown[i] === "<") {
    i++;
    const start = i;
    while (i < markdown.length && markdown[i] !== ">") {
      if (markdown[i] === "\\") {
        i += 2;
        continue;
      }
      if (markdown[i] === "\n" || markdown[i] === "<") {
        return null;
      }
      i++;
    }
    if (markdown[i] !== ">") {
      return null;
    }
    destination = markdown.slice(start, i);
    i++;
  } else {
    const start = i;
    let depth = 0;
    while (i < markdown.length) {
      const char = markdown[i] as string;
      if (char === "\\") {
        i += 2;
        continue;
      }
      if (char === "(") {
        depth++;
      } else if (char === ")") {
        if (depth === 0) {
          break;
        }
        depth--;
      } else if (isMarkdownSpace(char) || char.charCodeAt(0) < 0x20) {
        break;
      }
      i++;
    }
    destination = markdown.slice(start, i);
  }
  let k = i;
  while (isMarkdownSpace(markdown[k])) {
    k++;
  }
  if (markdown[k] === ")") {
    return { destination, end: k + 1 };
  }
  if (k === i) {
    return null;
  }
  const titleEnd = parseLinkTitle(markdown, k);
  if (titleEnd === null) {
    return null;
  }
  k = titleEnd;
  while (isMarkdownSpace(markdown[k])) {
    k++;
  }
  if (markdown[k] !== ")") {
    return null;
  }
  return { destination, end: k + 1 };
}

function parseImageAt(markdown: string, bangIndex: number): LoupeImageOccurrence | null {
  let depth = 1;
  let j = bangIndex + 2;
  while (j < markdown.length) {
    const char = markdown[j];
    if (char === "\\") {
      j += 2;
      continue;
    }
    if (char === "[") {
      depth++;
    } else if (char === "]") {
      depth--;
      if (depth === 0) {
        break;
      }
    }
    j++;
  }
  if (depth !== 0 || markdown[j + 1] !== "(") {
    return null;
  }
  const parsed = parseLinkDestination(markdown, j + 2);
  if (parsed === null) {
    return null;
  }
  const linkedImage = parseEnclosingImageLink(markdown, bangIndex, parsed.end);
  return {
    alt: markdown.slice(bangIndex + 2, j),
    destination: parsed.destination,
    start: bangIndex,
    end: parsed.end,
    ...(linkedImage === null ? {} : { linkedImage }),
  };
}

function parseEnclosingImageLink(
  markdown: string,
  imageStart: number,
  imageEnd: number,
): NonNullable<LoupeImageOccurrence["linkedImage"]> | null {
  const linkStart = imageStart - 1;
  if (
    linkStart < 0 ||
    markdown[linkStart] !== "[" ||
    isMarkdownEscaped(markdown, linkStart) ||
    markdown[imageEnd] !== "]" ||
    markdown[imageEnd + 1] !== "("
  ) {
    return null;
  }
  const parsed = parseLinkDestination(markdown, imageEnd + 2);
  return parsed === null
    ? null
    : { destination: parsed.destination, start: linkStart, end: parsed.end };
}

function isMarkdownEscaped(markdown: string, index: number): boolean {
  let backslashCount = 0;
  for (let i = index - 1; i >= 0 && markdown[i] === "\\"; i--) {
    backslashCount++;
  }
  return backslashCount % 2 === 1;
}

export function findLoupeImageOccurrences(markdown: string): LoupeImageOccurrence[] {
  const codeRanges = computeCodeRanges(markdown);
  const occurrences: LoupeImageOccurrence[] = [];
  let i = 0;
  let codeIndex = 0;
  while (i < markdown.length) {
    while (codeIndex < codeRanges.length && i >= (codeRanges[codeIndex] as CodeRange).end) {
      codeIndex++;
    }
    const code = codeIndex < codeRanges.length ? (codeRanges[codeIndex] as CodeRange) : null;
    if (code !== null && i >= code.start) {
      i = code.end;
      continue;
    }
    if (markdown[i] === "!" && markdown[i + 1] === "[" && !isMarkdownEscaped(markdown, i)) {
      const occurrence = parseImageAt(markdown, i);
      if (occurrence !== null) {
        if (code !== null && occurrence.end > code.start) {
          i = code.end;
          continue;
        }
        occurrences.push(occurrence);
        i = occurrence.end;
        continue;
      }
    }
    i++;
  }
  return occurrences;
}

function unescapeMarkdownDestination(destination: string): string {
  return destination.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
}

export function resolveLoupeImageUrl(destination: string, sourceUrl: string): string | null {
  const trimmed = unescapeMarkdownDestination(destination).trim();
  if (trimmed === "" || trimmed.startsWith("#")) {
    return null;
  }
  let resolved: URL;
  try {
    resolved = new URL(trimmed, sourceUrl);
  } catch {
    return null;
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    return null;
  }
  return resolved.href;
}
