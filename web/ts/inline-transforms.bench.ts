export {};

import { matchPattern, patterns } from "./inline-transforms.ts";

const bold = patterns[0]!;
const em = patterns[4]!;
const code = patterns[3]!;

function bench(name: string, fn: () => void, iterations = 500_000) {
  for (let i = 0; i < 1000; i++) fn(); // warmup
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = performance.now() - start;
  const nsOp = (elapsed * 1e6) / iterations;
  return { name, nsOp, iterations };
}

const results = [
  // Hot path: no match (every non-matching keystroke)
  bench("no match (short text)", () => matchPattern("hello world", 11, bold)),
  bench("no match (long text)", () =>
    matchPattern("the quick brown fox jumps over the lazy dog and more text here", 62, bold)),
  bench("no match (all patterns)", () => {
    const text = "just some normal text without any markers at all";
    const pos = text.length;
    for (const pat of patterns) matchPattern(text, pos, pat);
  }),

  // Match cases
  bench("bold match", () => matchPattern("**bold**", 8, bold)),
  bench("italic match", () => matchPattern("*italic*", 8, em)),
  bench("code match", () => matchPattern("`code` ", 7, code)),
  bench("bold in long text", () =>
    matchPattern("some preamble text here and **bold** at the end", 48, bold)),

  // Worst case: long text, marker at start
  bench("bold far back", () => {
    const text = "**" + "x".repeat(150) + "**";
    matchPattern(text, text.length, bold);
  }),

  // Simulated keystroke burst: 5 patterns × no match
  bench("full check (no match)", () => {
    const text = "typing some regular text here";
    const pos = text.length;
    for (const pat of patterns) matchPattern(text, pos, pat);
  }),
];

console.log("\n  inline-transforms benchmark");
console.log("  " + "-".repeat(52));
for (const r of results) {
  const ns = r.nsOp < 1000 ? `${r.nsOp.toFixed(0)} ns` : `${(r.nsOp / 1000).toFixed(1)} µs`;
  console.log(`  ${r.name.padEnd(35)} ${ns.padStart(10)}/op`);
}
console.log();

// Regression gate: full pattern scan must stay under 1µs per keystroke
const fullCheck = results.find((r) => r.name === "full check (no match)")!;
if (fullCheck.nsOp > 1000) {
  console.error(`REGRESSION: full check took ${fullCheck.nsOp.toFixed(0)} ns/op (limit: 1000 ns)`);
  process.exit(1);
}
console.log(`  ✓ regression gate passed (${fullCheck.nsOp.toFixed(0)} ns < 1000 ns)\n`);
