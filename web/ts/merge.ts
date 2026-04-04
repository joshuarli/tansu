/// Line-based 3-way merge.
/// Returns the merged result, or null if there are conflicts.

export function merge3(base: string, ours: string, theirs: string): string | null {
  const baseLines = base.split('\n');
  const ourLines = ours.split('\n');
  const theirLines = theirs.split('\n');

  const ourDiff = diff(baseLines, ourLines);
  const theirDiff = diff(baseLines, theirLines);

  const result: string[] = [];
  let bi = 0;
  let oi = 0;
  let ti = 0;

  while (bi < baseLines.length || oi < ourLines.length || ti < theirLines.length) {
    const ourOp = ourDiff[bi] ?? 'delete';
    const theirOp = theirDiff[bi] ?? 'delete';

    if (ourOp === 'keep' && theirOp === 'keep') {
      result.push(baseLines[bi]!);
      bi++; oi++; ti++;
    } else if (ourOp === 'keep' && theirOp === 'delete') {
      bi++; oi++;
    } else if (ourOp === 'delete' && theirOp === 'keep') {
      bi++; ti++;
    } else if (ourOp === 'delete' && theirOp === 'delete') {
      bi++;
    } else if (ourOp === 'replace' && theirOp === 'keep') {
      if (oi < ourLines.length) { result.push(ourLines[oi]!); oi++; }
      bi++; ti++;
    } else if (ourOp === 'keep' && theirOp === 'replace') {
      if (ti < theirLines.length) { result.push(theirLines[ti]!); ti++; }
      bi++; oi++;
    } else if (ourOp === 'replace' && theirOp === 'replace') {
      if (oi < ourLines.length && ti < theirLines.length && ourLines[oi] === theirLines[ti]) {
        result.push(ourLines[oi]!);
        oi++; ti++; bi++;
      } else {
        return null; // conflict
      }
    } else {
      return null; // delete vs replace conflict
    }
  }

  while (oi < ourLines.length) { result.push(ourLines[oi]!); oi++; }
  while (ti < theirLines.length) { result.push(theirLines[ti]!); ti++; }

  return result.join('\n');
}

type DiffOp = 'keep' | 'delete' | 'replace';

function diff(base: string[], modified: string[]): DiffOp[] {
  const n = base.length;
  const m = modified.length;

  // LCS table
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (base[i - 1] === modified[j - 1]) {
        table[i]![j] = table[i - 1]![j - 1]! + 1;
      } else {
        table[i]![j] = Math.max(table[i - 1]![j]!, table[i]![j - 1]!);
      }
    }
  }

  const ops: DiffOp[] = new Array<DiffOp>(n).fill('delete');
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (base[i - 1] === modified[j - 1]) {
      ops[i - 1] = 'keep';
      i--; j--;
    } else if (table[i - 1]![j]! >= table[i]![j - 1]!) {
      ops[i - 1] = 'replace';
      i--;
    } else {
      j--;
    }
  }

  return ops;
}
