import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_ROOT = join(REPO_ROOT, "tests", "fixtures", "test-vaults");
const DEFAULT_OUTPUT = join(REPO_ROOT, ".work", "tmp", "o1-corpus");
const NOTE_COUNTS = [2_500, 10_000];
const STRESS_SIZES = [50, 250, 1_024].map((kilobytes) => kilobytes * 1_024);
const TOPICS = ["storage", "search", "editor", "recovery", "vault", "markdown"];
const UNICODE = ["café", "naïve", "東京", "🧭", "Δοκιμή", "über"];

export function renderCorpusNote(seed, index) {
  const random = seededRandom(seed ^ Math.imul(index + 1, 0x9e3779b1));
  const topic = TOPICS[Math.floor(random() * TOPICS.length)];
  const word = UNICODE[Math.floor(random() * UNICODE.length)];
  const number = String(index + 1).padStart(5, "0");
  return `# ${topic} note ${number}\n\nSeeded corpus entry ${number} discusses ${topic}, ${word}, and stable note lookup.\n\n| Field | Value |\n| --- | --- |\n| corpus | ${number} |\n| topic | ${topic} |\n\n![Corpus image](z-images/sample.webp)\n`;
}

export function renderStressNote(sizeBytes) {
  if (!STRESS_SIZES.includes(sizeBytes)) {
    throw new Error(`unsupported stress note size: ${sizeBytes}`);
  }
  const prefix = `# Stress note ${sizeBytes}\n\nUnicode coverage: café 東京 🧭 Δοκιμή.\n\n| Column A | Column B |\n| --- | --- |\n| table | value |\n\n![Stress image](z-images/sample.webp)\n\n`;
  const remainingBytes = sizeBytes - Buffer.byteLength(prefix, "utf8");
  if (remainingBytes < 0) {
    throw new Error(`stress note structure exceeds requested size: ${sizeBytes}`);
  }
  return `${prefix}${"x".repeat(remainingBytes)}`;
}

export async function generateCorpus(seed = 0x5eed1234) {
  await resetCorpusOutput();
  const outputRoot = DEFAULT_OUTPUT;

  const fixturesOutput = join(outputRoot, "fixture-vaults");
  await cp(FIXTURE_ROOT, fixturesOutput, { recursive: true });

  for (const count of NOTE_COUNTS) {
    const corpusRoot = join(outputRoot, `notes-${count}`);
    await writeCorpusNotes(corpusRoot, seed, count);
  }

  const stressRoot = join(outputRoot, "stress");
  await mkdir(stressRoot, { recursive: true });
  for (const sizeBytes of STRESS_SIZES) {
    await writeFile(join(stressRoot, `note-${sizeLabel(sizeBytes)}.md`), renderStressNote(sizeBytes));
  }

  await validateCorpus(seed);
  return outputRoot;
}

export async function validateCorpus(seed = 0x5eed1234) {
  const outputRoot = DEFAULT_OUTPUT;

  for (const vaultName of await readdir(FIXTURE_ROOT)) {
    const sourceVault = join(FIXTURE_ROOT, vaultName);
    if (!(await stat(sourceVault)).isDirectory()) continue;
    const copiedVault = join(outputRoot, "fixture-vaults", vaultName);
    await assertSameTree(sourceVault, copiedVault);
    const expectedCount = await countMarkdown(sourceVault);
    const actualCount = await countMarkdown(copiedVault);
    if (actualCount !== expectedCount) {
      throw new Error(`${vaultName} note count is ${actualCount}; expected ${expectedCount}`);
    }
  }

  for (const count of NOTE_COUNTS) {
    const corpusRoot = join(outputRoot, `notes-${count}`);
    const actualCount = await countMarkdown(corpusRoot);
    if (actualCount !== count) {
      throw new Error(`notes-${count} contains ${actualCount} notes; expected ${count}`);
    }
    for (let index = 0; index < count; index += 1) {
      const number = String(index + 1).padStart(5, "0");
      const source = await readFile(join(corpusRoot, `note-${number}.md`), "utf8");
      if (source !== renderCorpusNote(seed, index)) {
        throw new Error(`notes-${count}/note-${number}.md does not match seed ${seed}`);
      }
    }
  }

  for (const sizeBytes of STRESS_SIZES) {
    const source = await readFile(join(outputRoot, "stress", `note-${sizeLabel(sizeBytes)}.md`));
    if (source.byteLength !== sizeBytes) {
      throw new Error(`stress note is ${source.byteLength} bytes; expected ${sizeBytes}`);
    }
    const text = source.toString("utf8");
    for (const marker of ["| Column A | Column B |", "![Stress image]", "café 東京 🧭 Δοκιμή"]) {
      if (!text.includes(marker)) {
        throw new Error(`stress note ${sizeLabel(sizeBytes)} is missing ${marker}`);
      }
    }
  }
  return true;
}

export async function writeCorpusNotes(corpusRoot, seed, count) {
  await mkdir(corpusRoot, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    const number = String(index + 1).padStart(5, "0");
    await writeFile(join(corpusRoot, `note-${number}.md`), renderCorpusNote(seed, index));
  }
}

export async function resetCorpusOutput() {
  await rm(DEFAULT_OUTPUT, { recursive: true, force: true });
  await mkdir(DEFAULT_OUTPUT, { recursive: true });
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function sizeLabel(sizeBytes) {
  return sizeBytes === 1_024 * 1_024 ? "1mb" : `${sizeBytes / 1_024}kb`;
}

async function countMarkdown(root) {
  let count = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) count += await countMarkdown(path);
    else if (entry.isFile() && entry.name.endsWith(".md")) count += 1;
  }
  return count;
}

async function assertSameTree(sourceRoot, copiedRoot) {
  const sourceEntries = await listTree(sourceRoot);
  const copiedEntries = await listTree(copiedRoot);
  if (sourceEntries.length !== copiedEntries.length) {
    throw new Error(`fixture copy entry count differs: ${sourceRoot}`);
  }
  for (let index = 0; index < sourceEntries.length; index += 1) {
    const [sourcePath, sourceBytes] = sourceEntries[index];
    const [copiedPath, copiedBytes] = copiedEntries[index];
    if (sourcePath !== copiedPath || !sourceBytes.equals(copiedBytes)) {
      throw new Error(`fixture copy differs at ${sourcePath}`);
    }
  }
}

async function listTree(root, base = root) {
  const entries = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) entries.push(...await listTree(path, base));
    else if (entry.isFile()) entries.push([relative(base, path), await readFile(path)]);
  }
  return entries.sort(([left], [right]) => left.localeCompare(right));
}

async function main() {
  const [command = "generate", ...args] = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--seed")) {
    throw new Error("usage: node bench/corpus.mjs [generate|validate] [--seed INTEGER]");
  }
  const seed = parseSeed(args[1] ?? "0x5eed1234");
  if (command === "generate") {
    await generateCorpus(seed);
    console.log(`generated and validated corpus at ${DEFAULT_OUTPUT} (seed ${seed})`);
  } else if (command === "validate") {
    await validateCorpus(seed);
    console.log(`validated corpus at ${DEFAULT_OUTPUT}`);
  } else {
    throw new Error("usage: node bench/corpus.mjs [generate|validate] [--seed INTEGER]");
  }
}

function parseSeed(value) {
  const seed = Number(value);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error(`seed must be an integer between 0 and 4294967295: ${value}`);
  }
  return seed;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
