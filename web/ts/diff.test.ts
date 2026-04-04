import { computeDiff } from "./diff.ts";
import { assertEqual, assert } from "./test-helper.ts";

// No changes
{
  const hunks = computeDiff("hello\nworld", "hello\nworld");
  assertEqual(hunks.length, 0, "identical texts produce no hunks");
}

// Single line change
{
  const hunks = computeDiff("hello\nworld", "hello\nearth");
  assertEqual(hunks.length, 1, "one hunk for single change");
  const lines = hunks[0]!.lines;
  assert(
    lines.some((l) => l.type === "del" && l.text === "world"),
    "deleted line present",
  );
  assert(
    lines.some((l) => l.type === "add" && l.text === "earth"),
    "added line present",
  );
  assert(
    lines.some((l) => l.type === "ctx" && l.text === "hello"),
    "context line present",
  );
}

// Pure addition
{
  const hunks = computeDiff("a\nb", "a\nb\nc");
  assertEqual(hunks.length, 1, "one hunk for addition");
  const addLines = hunks[0]!.lines.filter((l) => l.type === "add");
  assertEqual(addLines.length, 1, "one added line");
  assertEqual(addLines[0]!.text, "c", "added line text");
}

// Pure deletion
{
  const hunks = computeDiff("a\nb\nc", "a\nb");
  assertEqual(hunks.length, 1, "one hunk for deletion");
  const delLines = hunks[0]!.lines.filter((l) => l.type === "del");
  assertEqual(delLines.length, 1, "one deleted line");
  assertEqual(delLines[0]!.text, "c", "deleted line text");
}

// Changes far apart produce separate hunks
{
  const oldLines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  const newLines = [...oldLines];
  newLines[2] = "changed 2";
  newLines[17] = "changed 17";
  const hunks = computeDiff(oldLines.join("\n"), newLines.join("\n"));
  assert(hunks.length >= 2, `far apart changes produce multiple hunks (got ${hunks.length})`);
}

// Empty old (all additions)
{
  const hunks = computeDiff("", "hello\nworld");
  assertEqual(hunks.length, 1, "one hunk for all-add");
  const addLines = hunks[0]!.lines.filter((l) => l.type === "add");
  assert(addLines.length >= 1, "has added lines");
}

// Empty new (all deletions)
{
  const hunks = computeDiff("hello\nworld", "");
  assertEqual(hunks.length, 1, "one hunk for all-del");
  const delLines = hunks[0]!.lines.filter((l) => l.type === "del");
  assert(delLines.length >= 1, "has deleted lines");
}

console.log("All diff tests passed");
