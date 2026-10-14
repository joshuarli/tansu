import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { requireTargetNote, targetNotePath } from "./note-cache-target.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const RESULTS_DIR = join(REPO_ROOT, "bench", "results");
const SEARCH_QUERY = "GlobalFoundries";
const args = parseArgs(process.argv.slice(2));
const runs = Number(args.runs ?? 9);
const delayMs = Number(args.delay ?? 200);

async function main() {
  execFileSync("deno", ["task", "build:dev"], { cwd: REPO_ROOT, stdio: "inherit" });
  await mkdir(RESULTS_DIR, { recursive: true });

  const root = await mkdtemp(join(tmpdir(), "tansu2-cache-bench-"));
  const fixture = JSON.parse(
    execFileSync(process.execPath, ["scripts/test-fixture.mjs", root, "--copy-vaults"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }),
  );
  await requireTargetNote(fixture.vaultOne);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(
    "cargo",
    ["run", "--quiet", "--bin", "tansu2", "--", "--port", String(port)],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, XDG_CONFIG_HOME: fixture.configHome, XDG_DATA_HOME: fixture.dataHome },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  try {
    await waitForReady(`${baseUrl}/api/health`);
    const browser = await chromium.launch();
    try {
      const results = {
        generatedAt: new Date().toISOString(),
        runs,
        syntheticDelayMs: delayMs,
        actual: await runSuite(browser, baseUrl, 0),
        delayed: await runSuite(browser, baseUrl, delayMs),
      };
      const output = join(RESULTS_DIR, `note-cache-${Date.now()}.json`);
      await writeFile(output, `${JSON.stringify(results, null, 2)}\n`, "utf8");
      printSummary(results, output);
    } finally {
      await browser.close();
    }
  } finally {
    server.kill();
  }
}

async function runSuite(browser, baseUrl, noteDelayMs) {
  const metrics = {
    missOpen: [],
    cachedRecentOpen: [],
    cachedSearchOpen: [],
    cachedClosedReopen: [],
    restoredActive: [],
  };
  for (let i = 0; i < runs; i += 1) {
    metrics.missOpen.push(await measureMissOpen(browser, baseUrl, noteDelayMs));
    metrics.cachedRecentOpen.push(await measureCachedRecent(browser, baseUrl, noteDelayMs));
    metrics.cachedSearchOpen.push(await measureCachedSearch(browser, baseUrl, noteDelayMs));
    metrics.cachedClosedReopen.push(await measureClosedReopen(browser, baseUrl, noteDelayMs));
    metrics.restoredActive.push(await measureRestoredActive(browser, baseUrl, noteDelayMs));
  }
  return Object.fromEntries(
    Object.entries(metrics).map(([key, values]) => [key, summarize(values)]),
  );
}

async function measureMissOpen(browser, baseUrl, noteDelayMs) {
  const { context, page } = await newMeasuredPage(browser, noteDelayMs);
  try {
    await page.goto(baseUrl);
    await page.waitForSelector(".main");
    return await measureEditorAfterAction(
      page,
      (notePath) => {
        [...document.querySelectorAll(".note-row")]
          .find((row) => row.getAttribute("title") === notePath)
          ?.click();
      },
      targetNotePath,
    );
  } finally {
    await context.close();
  }
}

async function measureCachedRecent(browser, baseUrl, noteDelayMs) {
  const { context, page } = await newMeasuredPage(browser, noteDelayMs);
  try {
    await prewarmTarget(page, baseUrl);
    await closeActiveTab(page);
    return await measureEditorAfterAction(
      page,
      (notePath) => {
        [...document.querySelectorAll(".note-row")]
          .find((row) => row.getAttribute("title") === notePath)
          ?.click();
      },
      targetNotePath,
    );
  } finally {
    await context.close();
  }
}

async function measureCachedSearch(browser, baseUrl, noteDelayMs) {
  const { context, page } = await newMeasuredPage(browser, noteDelayMs);
  try {
    await prewarmTarget(page, baseUrl);
    await closeActiveTab(page);
    await page.locator('.sidebar-controls [title="Search notes"]').click();
    await page.locator(".search-panel input").fill(SEARCH_QUERY);
    await page.waitForSelector(".search-result-row");
    return await measureEditorAfterAction(
      page,
      (notePath) => {
        const rows = [...document.querySelectorAll(".search-result-row")];
        rows.find((row) => row.textContent?.includes(notePath))?.click();
      },
      targetNotePath,
    );
  } finally {
    await context.close();
  }
}

async function measureClosedReopen(browser, baseUrl, noteDelayMs) {
  const { context, page } = await newMeasuredPage(browser, noteDelayMs);
  try {
    await prewarmTarget(page, baseUrl);
    await closeActiveTab(page);
    await page.locator('.sidebar-controls [title="Commands"]').click();
    await page.locator(".command-input").fill("reopen");
    return await measureEditorAfterAction(page, () => {
      document.querySelector(".command-row")?.click();
    });
  } finally {
    await context.close();
  }
}

async function measureRestoredActive(browser, baseUrl, noteDelayMs) {
  const { context, page } = await newMeasuredPage(browser, noteDelayMs);
  try {
    await prewarmTarget(page, baseUrl);
    await page.waitForTimeout(350);
    await page.reload();
    await page.waitForSelector(".app-editor");
    return await page.evaluate(() => {
      const mount = performance.getEntriesByName("tansu:editor:mount").at(-1);
      return mount?.startTime ?? 0;
    });
  } finally {
    await context.close();
  }
}

async function measureEditorAfterAction(page, action, actionArg = null) {
  return await page.evaluate(
    async ({ actionSource, actionArg }) => {
      const action = new Function("arg", `return (${actionSource})(arg)`);
      performance.clearMarks();
      const start = performance.now();
      const editorReady = waitForEditor();
      action(actionArg);
      await editorReady;
      return performance.now() - start;

      function waitForEditor() {
        if (document.querySelector(".app-editor")) {
          return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
          const observer = new MutationObserver(() => {
            if (document.querySelector(".app-editor")) {
              window.clearTimeout(timeout);
              observer.disconnect();
              resolve(null);
            }
          });
          const timeout = window.setTimeout(() => {
            observer.disconnect();
            reject(new Error("editor did not open during cache benchmark"));
          }, 10_000);
          observer.observe(document.body, { childList: true, subtree: true });
        });
      }
    },
    { actionSource: action.toString(), actionArg },
  );
}

async function newMeasuredPage(browser, noteDelayMs) {
  const context = await browser.newContext();
  const page = await context.newPage();
  if (noteDelayMs > 0) {
    await page.route("**/api/notes/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const isNoteOpen = request.method() === "GET" && /^\/api\/notes\/[^/]+$/.test(url.pathname);
      if (isNoteOpen) {
        await new Promise((resolve) => setTimeout(resolve, noteDelayMs));
      }
      await route.continue();
    });
  }
  return { context, page };
}

async function prewarmTarget(page, baseUrl) {
  await page.goto(baseUrl);
  await page.waitForSelector(".main");
  await page
    .locator(`.note-row[title="${cssEscape(targetNotePath)}"]`)
    .first()
    .click();
  await page.waitForSelector(".app-editor");
  await page.waitForTimeout(50);
}

async function closeActiveTab(page) {
  await page.locator('.tab.active [title="Close"]').click();
  await page.waitForSelector(".app-editor", { state: "detached" });
}

function summarize(values) {
  const sorted = values.toSorted((a, b) => a - b);
  return {
    medianMs: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    minMs: round(sorted[0]),
    maxMs: round(sorted.at(-1)),
    samplesMs: sorted.map(round),
  };
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

function round(value) {
  return Math.round(value * 10) / 10;
}

async function waitForReady(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until the server is listening.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not become ready");
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("missing server address"));
        }
      });
    });
    server.on("error", reject);
  });
}

function parseArgs(values) {
  const parsed = {};
  for (const arg of values) {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=");
    parsed[key] = value;
  }
  return parsed;
}

function cssEscape(value) {
  return value.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`);
}

function printSummary(results, output) {
  console.log(`note cache benchmark results: ${output}`);
  printSuite("actual", results.actual);
  printSuite(`delayed openNote ${results.syntheticDelayMs}ms`, results.delayed);
}

function printSuite(label, suite) {
  console.log(label);
  for (const [metric, value] of Object.entries(suite)) {
    console.log(`${metric}: median=${value.medianMs}ms p95=${value.p95Ms}ms`);
  }
}

await main();
