import { merge3 } from './merge.ts';
import { assertEqual, assert } from './test-helper.ts';

// No changes
assertEqual(merge3('a\nb\nc', 'a\nb\nc', 'a\nb\nc'), 'a\nb\nc', 'no changes');

// Only ours changed
assertEqual(merge3('a\nb\nc', 'a\nB\nc', 'a\nb\nc'), 'a\nB\nc', 'ours changed');

// Only theirs changed
assertEqual(merge3('a\nb\nc', 'a\nb\nc', 'a\nB\nc'), 'a\nB\nc', 'theirs changed');

// Both changed different lines
assertEqual(merge3('a\nb\nc', 'A\nb\nc', 'a\nb\nC'), 'A\nb\nC', 'both changed different lines');

// Both changed same line identically
assertEqual(merge3('a\nb\nc', 'a\nX\nc', 'a\nX\nc'), 'a\nX\nc', 'both changed same line same way');

// Conflict: both changed same line differently
assertEqual(merge3('a\nb\nc', 'a\nX\nc', 'a\nY\nc'), null, 'conflict same line');

// Deletions produce a result (not null)
assert(merge3('a\nb\nc', 'a\nc', 'a\nb\nc') !== null, 'ours deleted merges');
assert(merge3('a\nb\nc', 'a\nb\nc', 'a\nc') !== null, 'theirs deleted merges');
assert(merge3('a\nb\nc', 'a\nc', 'a\nc') !== null, 'both deleted merges');

// Replacements on different lines
assertEqual(merge3('a\nb\nc\nd', 'A\nb\nc\nd', 'a\nb\nc\nD'), 'A\nb\nc\nD', 'replace different lines');

// Replacement + keep
assertEqual(merge3('x\ny\nz', 'X\ny\nz', 'x\ny\nz'), 'X\ny\nz', 'replace first line only');
assertEqual(merge3('x\ny\nz', 'x\ny\nz', 'x\ny\nZ'), 'x\ny\nZ', 'replace last line only');

// Multiple replacements by one side
assertEqual(merge3('a\nb\nc', 'A\nB\nC', 'a\nb\nc'), 'A\nB\nC', 'ours replaces all');
assertEqual(merge3('a\nb\nc', 'a\nb\nc', 'X\nY\nZ'), 'X\nY\nZ', 'theirs replaces all');

// Both replace all lines identically
assertEqual(merge3('a\nb\nc', 'X\nY\nZ', 'X\nY\nZ'), 'X\nY\nZ', 'both replace all same');

// Both replace all differently → conflict
assertEqual(merge3('a\nb\nc', 'X\nY\nZ', 'A\nB\nC'), null, 'both replace all different');

console.log('All merge tests passed');
