import type { Page } from "playwright";

import { setup, teardown } from "./setup.ts";

// Mulberry32 — fast seedable PRNG, good enough for fuzz sequences
function mulberry32(seed: number): () => number {
  return function prng() {
    seed |= 0;
    seed = (seed + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// Only alphanumeric + space — avoids markdown transform triggers (* ` # _ etc.)
const SAFE_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789   ";

function randomText(rand: () => number, minLen: number, maxLen: number): string {
  const len = minLen + Math.floor(rand() * (maxLen - minLen + 1));
  return Array.from({ length: len }, () => SAFE_CHARS[Math.floor(rand() * SAFE_CHARS.length)]).join(
    "",
  );
}

const FUZZ_ITERATIONS = Number.parseInt(process.env.FUZZ_ITERATIONS ?? "30", 10);
const FUZZ_SEED = Number.parseInt(process.env.FUZZ_SEED ?? "42", 10);

describe(`e2e: fuzz editor source toggle (seed=${FUZZ_SEED}, iterations=${FUZZ_ITERATIONS})`, () => {
  let page: Page;

  beforeAll(async () => {
    const ctx = await setup();
    ({ page } = ctx);
    await page.goto(ctx.baseUrl);
    await page.waitForSelector("#tab-bar", { timeout: 5000 });
    await page.keyboard.press("Meta+k");
    await page.waitForSelector("#search-input", { timeout: 2000 });
    await page.fill("#search-input", "test");
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    await page.waitForSelector(".editor-content", { timeout: 3000 });
  }, 30_000);

  afterAll(async () => {
    await teardown();
  });

  async function resetEditor(content: string) {
    await page.click(".editor-toolbar-btn--source");
    await page.fill(".editor-source", content);
    await page.click(".editor-toolbar-btn--source");
    await page.click(".editor-content");
  }

  async function getSourceContent(): Promise<string> {
    await page.click(".editor-toolbar-btn--source");
    const src = await page.$eval(".editor-source", (el: HTMLTextAreaElement) => el.value);
    await page.click(".editor-toolbar-btn--source");
    return src;
  }

  it("typed plain text appears verbatim in source mode", async () => {
    const rand = mulberry32(FUZZ_SEED);

    for (let i = 0; i < FUZZ_ITERATIONS; i++) {
      const text = randomText(rand, 5, 60);
      await resetEditor("");
      await page.keyboard.type(text);
      const source = await getSourceContent();
      expect(source, `iteration ${i} (seed=${FUZZ_SEED}): typed "${text}"`).toBe(text);
    }
  }, 120_000);

  // Replicates the exact reported scenario: typed lines were lost after a
  // double-newline block, leaving only trailing blank-line separators in the output.
  it("reported scenario: typed lines not lost after double-newline block", async () => {
    await resetEditor("sdf\n\nsdf");
    await page.keyboard.press("Meta+End");
    const lines = ["a", "sd", "s", "d", "csd", "dsfb", "b"];
    for (const line of lines) {
      await page.keyboard.press("Enter");
      await page.keyboard.type(line);
    }
    const source = await getSourceContent();
    expect(source).toBe(`sdf\n\nsdf\n${lines.join("\n")}`);
  }, 30_000);

  // Types multiple lines after double-newline initial content. Exercises the path
  // where Chrome may produce &nbsp;-only placeholder paragraphs or orphan text nodes
  // adjacent to the data-md-blank sentinel block, which domToMarkdown would drop.
  it("multi-line typing after double-newline initial content appears in source", async () => {
    const rand = mulberry32(FUZZ_SEED + 1);
    const LINES_PER_ITER = 5;

    for (let i = 0; i < FUZZ_ITERATIONS; i++) {
      const lines = Array.from({ length: LINES_PER_ITER }, () => randomText(rand, 2, 12));
      await resetEditor("sdf\n\nsdf");
      await page.keyboard.press("Meta+End");
      for (const line of lines) {
        await page.keyboard.press("Enter");
        await page.keyboard.type(line);
      }
      const source = await getSourceContent();
      const expected = `sdf\n\nsdf\n${lines.join("\n")}`;
      expect(source, `iteration ${i} (seed=${FUZZ_SEED + 1}): lines=${JSON.stringify(lines)}`).toBe(
        expected,
      );
    }
  }, 120_000);
});
