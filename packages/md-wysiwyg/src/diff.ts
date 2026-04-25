/// Line-based diff with compact rendering, like git diff.

import { DIFF_CONTEXT_LINES } from "./constants.js";
import { escapeHtml, lcs } from "./util.js";

export type DiffLine = {
  type: "add" | "del" | "ctx";
  text: string;
};

export type DiffHunk = {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
};

/// Compute diff hunks between old and new text.
export function computeDiff(oldText: string, newText: string): DiffHunk[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const matches = lcs(oldLines, newLines);

  // Build raw diff lines with original line numbers
  const raw: { type: "add" | "del" | "ctx"; text: string; oldNum: number; newNum: number }[] = [];
  let oi = 0;
  let ni = 0;

  for (const [anchorO, anchorN] of matches) {
    while (oi < anchorO) {
      raw.push({ type: "del", text: oldLines[oi]!, oldNum: oi, newNum: ni });
      oi++;
    }
    while (ni < anchorN) {
      raw.push({ type: "add", text: newLines[ni]!, oldNum: oi, newNum: ni });
      ni++;
    }
    raw.push({ type: "ctx", text: oldLines[oi]!, oldNum: oi, newNum: ni });
    oi++;
    ni++;
  }
  while (oi < oldLines.length) {
    raw.push({ type: "del", text: oldLines[oi]!, oldNum: oi, newNum: ni });
    oi++;
  }
  while (ni < newLines.length) {
    raw.push({ type: "add", text: newLines[ni]!, oldNum: oi, newNum: ni });
    ni++;
  }

  // Group into hunks with context lines
  return buildHunks(raw);
}

function buildHunks(
  raw: { type: "add" | "del" | "ctx"; text: string; oldNum: number; newNum: number }[],
): DiffHunk[] {
  // Find ranges of changed lines, expand by CONTEXT
  const changed: boolean[] = raw.map((r) => r.type !== "ctx");
  const included: boolean[] = Array.from<boolean>({ length: raw.length }).fill(false);

  for (let i = 0; i < raw.length; i++) {
    if (changed[i]) {
      for (
        let j = Math.max(0, i - DIFF_CONTEXT_LINES);
        j <= Math.min(raw.length - 1, i + DIFF_CONTEXT_LINES);
        j++
      ) {
        included[j] = true;
      }
    }
  }

  const hunks: DiffHunk[] = [];
  let i = 0;
  while (i < raw.length) {
    if (!included[i]) {
      i++;
      continue;
    }

    const lines: DiffLine[] = [];
    const firstRaw = raw[i]!;
    const oldStart = firstRaw.type === "add" ? firstRaw.oldNum - 1 : firstRaw.oldNum;
    const newStart = firstRaw.type === "del" ? firstRaw.newNum - 1 : firstRaw.newNum;

    while (i < raw.length && included[i]) {
      const r = raw[i]!;
      lines.push({ type: r.type, text: r.text });
      i++;
    }

    hunks.push({ oldStart, newStart, lines });
  }

  return hunks;
}

/// Render diff hunks as an HTML element.
export function renderDiff(hunks: DiffHunk[]): HTMLElement {
  const container = document.createElement("div");
  container.className = "diff-view";

  if (hunks.length === 0) {
    container.textContent = "No changes.";
    return container;
  }

  for (const hunk of hunks) {
    const hunkEl = document.createElement("div");
    hunkEl.className = "diff-hunk";

    const header = document.createElement("div");
    header.className = "diff-hunk-header";
    header.textContent = `@@ -${hunk.oldStart + 1} +${hunk.newStart + 1} @@`;
    hunkEl.append(header);

    for (const line of hunk.lines) {
      const lineEl = document.createElement("div");
      lineEl.className = `diff-line diff-${line.type}`;
      let prefix: string;
      if (line.type === "add") {
        prefix = "+";
      } else if (line.type === "del") {
        prefix = "-";
      } else {
        prefix = " ";
      }
      lineEl.innerHTML = `<span class="diff-prefix">${prefix}</span>${escapeHtml(line.text)}`;
      hunkEl.append(lineEl);
    }

    container.append(hunkEl);
  }

  return container;
}
