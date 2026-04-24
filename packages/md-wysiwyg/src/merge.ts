/// Line-based 3-way merge.
/// Returns the merged result, or null if there are conflicts.

import { lcs } from "./util.js";

export function merge3(base: string, ours: string, theirs: string): string | null {
  const baseLines = base.split("\n");
  const ourLines = ours.split("\n");
  const theirLines = theirs.split("\n");

  const ourEdits = computeEdits(baseLines, ourLines);
  const theirEdits = computeEdits(baseLines, theirLines);

  const result: string[] = [];

  for (let bi = 0; bi <= baseLines.length; bi++) {
    // First, handle insertions before this base position
    const ourIns = ourEdits.insertions.get(bi);
    const theirIns = theirEdits.insertions.get(bi);
    if (ourIns && theirIns) {
      if (arrEq(ourIns, theirIns)) {
        for (const l of ourIns) {
          result.push(l);
        }
      } else {
        return null;
      }
    } else if (ourIns) {
      for (const l of ourIns) {
        result.push(l);
      }
    } else if (theirIns) {
      for (const l of theirIns) {
        result.push(l);
      }
    }

    // Then, handle the base line itself (skip for the sentinel position after end)
    if (bi >= baseLines.length) {
      break;
    }

    const ourRep = ourEdits.replacements.get(bi);
    const theirRep = theirEdits.replacements.get(bi);
    const hasOur = ourRep !== undefined;
    const hasTheir = theirRep !== undefined;

    if (!hasOur && !hasTheir) {
      result.push(baseLines[bi]!);
    } else if (hasOur && !hasTheir) {
      if (ourRep!.length > 0) {
        result.push(ourRep![0]!);
      }
      // length 0 = deletion
    } else if (!hasOur && hasTheir) {
      if (theirRep!.length > 0) {
        result.push(theirRep![0]!);
      }
    } else {
      if (arrEq(ourRep!, theirRep!)) {
        if (ourRep!.length > 0) {
          result.push(ourRep![0]!);
        }
      } else {
        return null;
      }
    }
  }

  return result.join("\n");
}

function arrEq(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((l, i) => l === b[i]);
}

interface EditSet {
  // Replacements: base line index → replacement (single line or empty for deletion)
  replacements: Map<number, string[]>;
  // Insertions: position index → lines inserted before that base position
  // Position baseLines.length = appended after end
  insertions: Map<number, string[]>;
}

/// Compute edits from base to modified using LCS as anchors.
function computeEdits(base: string[], modified: string[]): EditSet {
  const replacements = new Map<number, string[]>();
  const insertions = new Map<number, string[]>();
  const matches = lcs(base, modified);

  let bi = 0;
  let mi = 0;

  for (const [anchorB, anchorM] of matches) {
    // Region before this anchor: base[bi..anchorB) and modified[mi..anchorM)
    processRegion(replacements, insertions, base, modified, bi, anchorB, mi, anchorM);
    bi = anchorB + 1;
    mi = anchorM + 1;
  }

  // Region after last anchor
  processRegion(replacements, insertions, base, modified, bi, base.length, mi, modified.length);

  return { replacements, insertions };
}

function processRegion(
  replacements: Map<number, string[]>,
  insertions: Map<number, string[]>,
  _base: string[],
  modified: string[],
  bStart: number,
  bEnd: number,
  mStart: number,
  mEnd: number,
) {
  const bCount = bEnd - bStart;
  const mCount = mEnd - mStart;

  if (bCount === 0 && mCount === 0) {
    return;
  }

  if (bCount === 0) {
    // Pure insertion before bStart
    insertions.set(bStart, modified.slice(mStart, mEnd));
    return;
  }

  // Replace base lines 1:1 with modified lines where possible
  const paired = Math.min(bCount, mCount);
  for (let i = 0; i < paired; i++) {
    replacements.set(bStart + i, [modified[mStart + i]!]);
  }

  // Extra base lines are deletions
  for (let i = paired; i < bCount; i++) {
    replacements.set(bStart + i, []);
  }

  // Extra modified lines are insertions after the last paired base line
  if (mCount > paired) {
    insertions.set(bStart + paired, modified.slice(mStart + paired, mEnd));
  }
}
