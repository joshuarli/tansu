import { execFileSync, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { requireTargetNote, targetNotePath } from "./note-cache-target.mjs";
import { stopProcessGroup } from "./process-group.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const RESULTS_DIR = join(REPO_ROOT, ".work", "tmp", "bench-results");
const SEARCH_QUERY = "Claude";
const args = parseArgs(process.argv.slice(2));
const runs = Number(args.runs ?? 9);
const delayMs = Number(args.delay ?? 200);

async function main() {
  execFileSync("deno", ["task", "build:dev"], { cwd: REPO_ROOT, stdio: "inherit" });
  await mkdir(RESULTS_DIR, { recursive: true });

  const root = await mkdtemp(join(tmpdir(), "tansu2-cache-bench-"));
  let server;
  try {
    const fixture = JSON.parse(
      execFileSync(process.execPath, ["scripts/test-fixture.mjs", root, "--copy-vaults"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      }),
    );
    await rm(fixture.vaultOne, { recursive: true, force: true });
    await cp(join(REPO_ROOT, "tests", "fixtures", "demo-vault"), fixture.vaultOne, { recursive: true });
    await requireTargetNote(fixture.vaultOne);
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(
      "cargo",
      ["run", "--quiet", "--bin", "tansu2", "--", "--port", String(port)],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, XDG_CONFIG_HOME: fixture.configHome, XDG_DATA_HOME: fixture.dataHome },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );

    await waitForReady(`${baseUrl}/api/v2/health`);
    const globalBootstrap = await fetch(`${baseUrl}/api/v2/bootstrap`).then((response) => response.json());
    const vault = globalBootstrap.vaults.find((item) => item.name === "One");
    if (vault === undefined) throw new Error("benchmark fixture has no vault One");
    const serverIdentity = { serverInstanceId: globalBootstrap.serverInstanceId, vaultId: vault.vaultId };
    const vaultBootstrap = await vaultJson(baseUrl, serverIdentity, "/bootstrap");
    const target = vaultBootstrap.notes.find((note) => note.path === targetNotePath);
    if (target === undefined) throw new Error(`cache benchmark target is missing: ${targetNotePath}`);
    const browser = await chromium.launch();
    try {
      const results = {
        generatedAt: new Date().toISOString(),
        runs,
        syntheticDelayMs: delayMs,
        target: target.path,
        actual: await runSuite(browser, baseUrl, serverIdentity, target, 0),
        delayed: await runSuite(browser, baseUrl, serverIdentity, target, delayMs),
      };
      const output = join(RESULTS_DIR, `note-cache-${Date.now()}.json`);
      await writeFile(output, `${JSON.stringify(results, null, 2)}\n`, "utf8");
      printSummary(results, output);
    } finally {
      await browser.close();
    }
  } finally {
    if (server !== undefined) await stopProcessGroup(server);
    await rm(root, { recursive: true, force: true });
  }
}

async function runSuite(browser, baseUrl, serverIdentity, target, noteDelayMs) {
  const metrics = {
    missOpen: [],
    cachedRecentOpen: [],
    cachedSearchOpen: [],
    cachedClosedReopen: [],
    restoredActive: [],
  };
  for (let i = 0; i < runs; i += 1) {
    metrics.missOpen.push(await measureMissOpen(browser, baseUrl, serverIdentity, target, noteDelayMs));
    metrics.cachedRecentOpen.push(await measureCachedRecent(browser, baseUrl, serverIdentity, target, noteDelayMs));
    metrics.cachedSearchOpen.push(await measureCachedSearch(browser, baseUrl, serverIdentity, target, noteDelayMs));
    metrics.cachedClosedReopen.push(await measureClosedReopen(browser, baseUrl, serverIdentity, target, noteDelayMs));
    metrics.restoredActive.push(await measureRestoredActive(browser, baseUrl, serverIdentity, target, noteDelayMs));
  }
  return Object.fromEntries(
    Object.entries(metrics).map(([key, values]) => [key, summarize(values)]),
  );
}

async function measureMissOpen(browser, baseUrl, serverIdentity, target, noteDelayMs) {
  const { context, page } = await newMeasuredPage(browser, serverIdentity, target.noteId, noteDelayMs);
  try {
    await page.goto(baseUrl);
    await page.waitForSelector(".main");
    return await measureEditorAfterAction(page, "note-row", targetNotePath);
  } finally {
    await context.close();
  }
}

async function measureCachedRecent(browser, baseUrl, serverIdentity, target, noteDelayMs) {
  const { context, page } = await newMeasuredPage(browser, serverIdentity, target.noteId, noteDelayMs);
  try {
    await prewarmTarget(page, baseUrl, target.title);
    await closeActiveTab(page);
    return await measureEditorAfterAction(page, "note-row", targetNotePath);
  } finally {
    await context.close();
  }
}

async function measureCachedSearch(browser, baseUrl, serverIdentity, target, noteDelayMs) {
  const { context, page } = await newMeasuredPage(browser, serverIdentity, target.noteId, noteDelayMs);
  try {
    await prewarmTarget(page, baseUrl, target.title);
    await closeActiveTab(page);
    await page.keyboard.press("Control+Shift+f");
    await page.locator(".search-panel input").fill(SEARCH_QUERY);
    await page.waitForSelector(".search-result-row");
    return await measureEditorAfterAction(page, "search-result", targetNotePath);
  } finally {
    await context.close();
  }
}

async function measureClosedReopen(browser, baseUrl, serverIdentity, target, noteDelayMs) {
  const { context, page } = await newMeasuredPage(browser, serverIdentity, target.noteId, noteDelayMs);
  try {
    await prewarmTarget(page, baseUrl, target.title);
    await closeActiveTab(page);
    await page.keyboard.press("Control+k");
    await page.locator(".command-input").fill("reopen");
    return await measureEditorAfterAction(page, "command-row");
  } finally {
    await context.close();
  }
}

async function measureRestoredActive(browser, baseUrl, serverIdentity, target, noteDelayMs) {
  const { context, page } = await newMeasuredPage(browser, serverIdentity, target.noteId, noteDelayMs);
  try {
    await prewarmTarget(page, baseUrl, target.title);
    await page.waitForTimeout(350);
    await page.reload();
    await page.waitForSelector(".cm-editor");
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
    async ({ action, actionArg }) => {
      performance.clearMarks();
      const start = performance.now();
      const editorReady = waitForEditor();
      if (action === "note-row") {
        [...document.querySelectorAll(".note-row")]
          .find((row) => row.getAttribute("title") === actionArg)
          ?.click();
      } else if (action === "search-result") {
        [...document.querySelectorAll(".search-result-row")]
          .find((row) => row.textContent?.includes(actionArg))
          ?.click();
      } else if (action === "command-row") {
        document.querySelector(".command-row")?.click();
      } else {
        throw new Error(`unknown cache benchmark action: ${action}`);
      }
      await editorReady;
      return performance.now() - start;

      function waitForEditor() {
        if (document.querySelector(".cm-editor")) {
          return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
          const observer = new MutationObserver(() => {
            if (document.querySelector(".cm-editor")) {
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
    { action, actionArg },
  );
}

async function newMeasuredPage(browser, serverIdentity, noteId, noteDelayMs) {
  const context = await browser.newContext();
  const page = await context.newPage();
  if (noteDelayMs > 0) {
    const notePath = `/api/v2/vaults/${encodeURIComponent(serverIdentity.vaultId)}/notes/${encodeURIComponent(noteId)}`;
    await page.route(`**${notePath}`, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const isNoteOpen = request.method() === "GET" && url.pathname === notePath;
      if (isNoteOpen) {
        await new Promise((resolve) => setTimeout(resolve, noteDelayMs));
      }
      await route.continue();
    });
  }
  return { context, page };
}

async function prewarmTarget(page, baseUrl, title) {
  await page.goto(baseUrl);
  await page.waitForSelector(".main");
  await page.keyboard.press("Control+p");
  const panel = page.locator(".quick-open-panel");
  await panel.waitFor({ state: "visible" });
  await panel.locator(".command-input").fill(title);
  const row = panel.locator(".quick-open-results .command-row").filter({ hasText: title }).first();
  await row.waitFor({ state: "visible" });
  await row.click();
  await panel.waitFor({ state: "detached" });
  await page.waitForFunction((expected) =>
    document.querySelector(".tab.active")?.getAttribute("title") === expected &&
    (document.querySelector(".cm-content")?.textContent?.trim().length ?? 0) > 0,
  title);
}

async function closeActiveTab(page) {
  const activeTab = page.locator(".tab.active");
  await activeTab.locator('[title="Close"]').click();
  await activeTab.waitFor({ state: "detached" });
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
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not become ready");
}

async function vaultJson(baseUrl, identity, path) {
  const response = await fetch(`${baseUrl}/api/v2/vaults/${encodeURIComponent(identity.vaultId)}${path}`, {
    headers: {
      Accept: "application/json",
      "X-Tansu-Server-Instance": identity.serverInstanceId,
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`request failed: ${response.status} ${JSON.stringify(body)}`);
  return body;
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
