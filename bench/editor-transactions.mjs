import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { renderStressNote } from "./corpus.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const HARNESS_ROOT = resolve(REPO_ROOT, ".work/tmp/editor-harness");
const RESULTS_ROOT = resolve(REPO_ROOT, ".work/tmp/bench-results");
const ROUND_COUNT = 5;
const TRANSACTIONS_PER_ROUND = 20;
const TYPING_SEQUENCE = "quick brown fox quic";
const SIZE_BYTES = new Map([
  ["50kb", 50 * 1024],
  ["250kb", 250 * 1024],
  ["1mb", 1024 * 1024],
]);
const requestedSize = process.argv[2];
if (requestedSize !== undefined && !SIZE_BYTES.has(requestedSize)) {
  throw new Error("usage: node bench/editor-transactions.mjs [50kb|250kb|1mb]");
}
const SIZES = requestedSize === undefined ? [...SIZE_BYTES.values()] : [SIZE_BYTES.get(requestedSize)];

execFileSync(process.execPath, ["web/ts/editor/harness/build.mjs"], {
  cwd: REPO_ROOT,
  stdio: "inherit",
});

const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/harness.js", ["harness.js", "text/javascript; charset=utf-8"]],
  ["/editor.css", ["editor.css", "text/css; charset=utf-8"]],
]);
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const file = files.get(pathname);
  if (file === undefined) {
    response.writeHead(404);
    response.end();
    return;
  }
  const [filename, contentType] = file;
  response.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
  response.end(await readFile(resolve(HARNESS_ROOT, filename)));
});

await new Promise((resolveListen, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolveListen);
});
const address = server.address();
if (address === null || typeof address === "string") {
  throw new Error("editor benchmark server has no TCP address");
}

const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    locale: "en-US",
    timezoneId: "UTC",
    viewport: { width: 1024, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await page.waitForFunction(() => window.tansuEditorHarness !== undefined);

  const report = {
    benchmark: "tansu-codemirror-transactions",
    browser: browser.version(),
    locale: "en-US",
    timezone: "UTC",
    rounds: ROUND_COUNT,
    transactionsPerRound: TRANSACTIONS_PER_ROUND,
    typingSequence: TYPING_SEQUENCE,
    notes: [],
  };

  for (const sizeBytes of SIZES) {
    const source = renderStressNote(sizeBytes);
    if (Buffer.byteLength(source, "utf8") !== sizeBytes) {
      throw new Error(`stress note is not exactly ${sizeBytes} bytes`);
    }
    const openSamples = [];
    const typingRoundP95 = [];
    const snapshotSamples = [];

    for (let round = 0; round < ROUND_COUNT; round += 1) {
      openSamples.push(await page.evaluate(
        (value) => window.tansuEditorHarness.attachSource(value),
        source,
      ));
      await page.evaluate(() => {
        window.tansuEditorHarness.resetTransactions();
        window.tansuEditorHarness.focusAtEnd();
      });
      for (let transaction = 0; transaction < TRANSACTIONS_PER_ROUND; transaction += 1) {
        await page.keyboard.insertText(TYPING_SEQUENCE[transaction]);
      }
      const transactionSamples = await page.evaluate(() => window.tansuEditorHarness.transactions());
      if (transactionSamples.length !== TRANSACTIONS_PER_ROUND) {
        throw new Error(
          `captured ${transactionSamples.length} transactions; expected ${TRANSACTIONS_PER_ROUND}`,
        );
      }
      typingRoundP95.push(percentile([...transactionSamples].sort((a, b) => a - b), 0.95));
      snapshotSamples.push(await page.evaluate(() => window.tansuEditorHarness.snapshot().elapsedMs));
    }

    const switchSamples = sizeBytes === 50 * 1024
      ? await page.evaluate(async (value) => {
        window.tansuEditorHarness.prepareSources([value, value]);
        await window.tansuEditorHarness.switchSession(0);
        const samples = [];
        for (let turn = 0; turn < 10; turn += 1) {
          samples.push(await window.tansuEditorHarness.switchSession(turn % 2 === 0 ? 1 : 0));
        }
        return samples;
      }, source)
      : [];

    report.notes.push({
      bytes: sizeBytes,
      characters: source.length,
      editorUsefulOpenMs: summarize(openSamples),
      typingTransactionRoundP95Ms: summarize(typingRoundP95),
      loadedNoteSwitchMs: switchSamples.length === 0 ? null : summarize(switchSamples),
      sourceSnapshotMs: summarize(snapshotSamples),
    });
  }

  await context.close();
  await mkdir(RESULTS_ROOT, { recursive: true });
  const output = resolve(RESULTS_ROOT, `editor-transactions-${Date.now()}.json`);
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`report: ${output}\n`);
} finally {
  await browser.close();
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    minMs: round(sorted[0]),
    medianMs: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    samplesMs: sorted.map(round),
  };
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function round(value) {
  return Math.round(value * 100) / 100;
}
