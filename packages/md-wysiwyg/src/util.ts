export const BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "UL",
  "OL",
  "BLOCKQUOTE",
  "PRE",
  "TABLE",
  "HR",
]);

export function isBlockTag(tagName: string): boolean {
  return BLOCK_TAGS.has(tagName);
}

/// Noncharacter codepoints used as in-band markers during rendering.
/// FDD0–FDD2 are permanently reserved by Unicode and never appear in real text.
export const CURSOR_SENTINEL = "﷐";
export const SEL_START_SENTINEL = "﷑";
export const SEL_END_SENTINEL = "﷒";

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function stemFromPath(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.md$/i, "");
}

export function clampNodeOffset(node: Node, offset: number): number {
  if (offset < 0) {
    return 0;
  }
  if (node.nodeType === Node.TEXT_NODE) {
    return Math.min(offset, node.textContent?.length ?? 0);
  }
  return Math.min(offset, node.childNodes.length);
}

/// Compute LCS and return matching pairs [aIndex, bIndex].
export function lcs(as: string[], bs: string[]): [number, number][] {
  const n = as.length;
  const m = bs.length;

  const table: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from<number>({ length: m + 1 }).fill(0),
  );
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      table[i]![j] =
        as[i - 1] === bs[j - 1]
          ? table[i - 1]![j - 1]! + 1
          : Math.max(table[i - 1]![j]!, table[i]![j - 1]!);
    }
  }

  const matches: [number, number][] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (as[i - 1] === bs[j - 1]) {
      matches.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (table[i - 1]![j]! >= table[i]![j - 1]!) {
      i--;
    } else {
      j--;
    }
  }
  matches.reverse();
  return matches;
}
