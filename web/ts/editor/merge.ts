import { lcs } from "./util.js";

export function merge3(base: string, ours: string, theirs: string): string | null {
  const baseLines = base.split("\n");
  const ourLines = ours.split("\n");
  const theirLines = theirs.split("\n");

  const ourEdits = computeEdits(baseLines, ourLines);
  const theirEdits = computeEdits(baseLines, theirLines);

  const result: string[] = [];

  for (let bi = 0; bi <= baseLines.length; bi++) {
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

type EditSet = {
  replacements: Map<number, string[]>;
  insertions: Map<number, string[]>;
};

function computeEdits(base: string[], modified: string[]): EditSet {
  const replacements = new Map<number, string[]>();
  const insertions = new Map<number, string[]>();
  const matches = lcs(base, modified);

  let bi = 0;
  let mi = 0;

  for (const [anchorB, anchorM] of matches) {
    processRegion(replacements, insertions, base, modified, bi, anchorB, mi, anchorM);
    bi = anchorB + 1;
    mi = anchorM + 1;
  }

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
    insertions.set(bStart, modified.slice(mStart, mEnd));
    return;
  }

  const paired = Math.min(bCount, mCount);
  for (let i = 0; i < paired; i++) {
    replacements.set(bStart + i, [modified[mStart + i]!]);
  }

  for (let i = paired; i < bCount; i++) {
    replacements.set(bStart + i, []);
  }

  if (mCount > paired) {
    insertions.set(bStart + paired, modified.slice(mStart + paired, mEnd));
  }
}
