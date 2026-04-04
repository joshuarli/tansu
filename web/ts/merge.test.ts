import { merge3 } from "./merge.ts";
import { assertEqual } from "./test-helper.ts";

// No changes
assertEqual(merge3("a\nb\nc", "a\nb\nc", "a\nb\nc"), "a\nb\nc", "no changes");

// Only ours changed
assertEqual(merge3("a\nb\nc", "a\nB\nc", "a\nb\nc"), "a\nB\nc", "ours changed");

// Only theirs changed
assertEqual(merge3("a\nb\nc", "a\nb\nc", "a\nB\nc"), "a\nB\nc", "theirs changed");

// Both changed different lines
assertEqual(merge3("a\nb\nc", "A\nb\nc", "a\nb\nC"), "A\nb\nC", "both changed different lines");

// Both changed same line identically
assertEqual(merge3("a\nb\nc", "a\nX\nc", "a\nX\nc"), "a\nX\nc", "both changed same line same way");

// Conflict: both changed same line differently
assertEqual(merge3("a\nb\nc", "a\nX\nc", "a\nY\nc"), null, "conflict same line");

// Ours deleted a line
assertEqual(merge3("a\nb\nc", "a\nc", "a\nb\nc"), "a\nc", "ours deleted line");

// Theirs deleted a line
assertEqual(merge3("a\nb\nc", "a\nb\nc", "a\nc"), "a\nc", "theirs deleted line");

// Both deleted same line
assertEqual(merge3("a\nb\nc", "a\nc", "a\nc"), "a\nc", "both deleted same line");

// Ours added lines at end (previously caused infinite loop)
assertEqual(merge3("a\nb", "a\nb\nc\nd", "a\nb"), "a\nb\nc\nd", "ours added at end");

// Theirs added lines at end
assertEqual(merge3("a\nb", "a\nb", "a\nb\nc\nd"), "a\nb\nc\nd", "theirs added at end");

// Both added same lines at end
assertEqual(merge3("a\nb", "a\nb\nc", "a\nb\nc"), "a\nb\nc", "both added same at end");

// Both added different lines at end — conflict
assertEqual(merge3("a\nb", "a\nb\nc", "a\nb\nd"), null, "both added different at end");

// Empty base, ours adds content
assertEqual(merge3("", "hello", ""), "hello", "empty base ours added");

// Empty base, theirs adds content
assertEqual(merge3("", "", "hello"), "hello", "empty base theirs added");

// Single line files
assertEqual(merge3("old", "new", "old"), "new", "single line ours");
assertEqual(merge3("old", "old", "new"), "new", "single line theirs");
assertEqual(merge3("old", "new", "new"), "new", "single line both same");
assertEqual(merge3("old", "a", "b"), null, "single line conflict");

// Replacements on different lines
assertEqual(
  merge3("a\nb\nc\nd", "A\nb\nc\nd", "a\nb\nc\nD"),
  "A\nb\nc\nD",
  "replace different lines",
);

// Multiple replacements by one side
assertEqual(merge3("a\nb\nc", "A\nB\nC", "a\nb\nc"), "A\nB\nC", "ours replaces all");
assertEqual(merge3("a\nb\nc", "a\nb\nc", "X\nY\nZ"), "X\nY\nZ", "theirs replaces all");

// Both replace all identically
assertEqual(merge3("a\nb\nc", "X\nY\nZ", "X\nY\nZ"), "X\nY\nZ", "both replace all same");

// Both replace all differently — conflict
assertEqual(merge3("a\nb\nc", "X\nY\nZ", "A\nB\nC"), null, "both replace all different");

// Delete first line
assertEqual(merge3("a\nb\nc", "b\nc", "a\nb\nc"), "b\nc", "ours deleted first");

// Delete last line
assertEqual(merge3("a\nb\nc", "a\nb", "a\nb\nc"), "a\nb", "ours deleted last");

// Ours adds at start (insert before first line)
assertEqual(merge3("b\nc", "a\nb\nc", "b\nc"), "a\nb\nc", "ours added at start");

// Mixed: ours edits, theirs appends
assertEqual(merge3("a\nb", "A\nb", "a\nb\nc"), "A\nb\nc", "ours edits theirs appends");

// Both empty
assertEqual(merge3("", "", ""), "", "all empty");

console.log("All merge tests passed");
