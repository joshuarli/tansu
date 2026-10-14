import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, firefox, webkit } from "playwright";

import { createTestFixture } from "../scripts/test-fixture.mjs";
import { directorySize } from "./directory-size.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const BENCH_DIR = join(REPO_ROOT, "bench");
const RESULTS_DIR = join(BENCH_DIR, "results");

const args = parseArgs(process.argv.slice(2));
const warmups = Number(args.warmups ?? 2);
const runs = Number(args.runs ?? 5);
const browsers = String(args.browser ?? "chromium")
  .split(",")
  .filter(Boolean);
const checkBudgets = args["check-budgets"] !== "false" && args.calibrate !== "true";

const browserTypes = { chromium, firefox, webkit };

async function main() {
  execFileSync("deno", ["task", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
  await mkdir(RESULTS_DIR, { recursive: true });

  const root = await mkdtemp(join(tmpdir(), "tansu2-bench-"));
  const fixture = await createBenchmarkFixture(root);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverStart = performance.now();
  const server = spawn(
    "cargo",
    ["run", "--quiet", "--bin", "tansu2", "--", "--port", String(port)],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, XDG_CONFIG_HOME: fixture.configHome, XDG_DATA_HOME: fixture.dataHome },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const results = {
    generatedAt: new Date().toISOString(),
    config: { warmups, runs, browsers },
    metrics: {},
  };

  try {
    await waitForReady(`${baseUrl}/api/health`);
    results.metrics.coldStartup = [performance.now() - serverStart];

    for (const name of browsers) {
      const type = browserTypes[name];
      if (type === undefined) {
        throw new Error(`unknown browser: ${name}`);
      }
      const browser = await type.launch();
      try {
        results.metrics[name] = await runBrowserBenchmarks(browser, baseUrl, fixture);
      } finally {
        await browser.close();
      }
    }

    results.metrics.productionBundleBytes = [
      await fileSize(join(REPO_ROOT, "web", "static", "app.js")),
    ];
    results.metrics.catalogBytes = [await directorySize(join(fixture.dataHome, "tansu"))];
    const rss = server.pid === undefined ? null : rssBytes(server.pid);
    if (rss !== null) {
      results.metrics.serverRssBytes = [rss];
    }

    const summary = summarizeResults(results);
    if (checkBudgets) {
      checkBudget(summary, await readBudgets());
    }
    const output = join(RESULTS_DIR, `integrated-${Date.now()}.json`);
    await writeFile(output, `${JSON.stringify({ summary, raw: results }, null, 2)}\n`, "utf8");
    printSummary(summary, output);
  } finally {
    server.kill();
  }
}

async function runBrowserBenchmarks(browser, baseUrl, fixture) {
  const page = await browser.newPage();
  const out = {};
  try {
    const bootstrap = await fetchJson(`${baseUrl}/api/bootstrap`, { vault: 0 });
    const first = bootstrap.notes[0];
    const second = bootstrap.notes[1] ?? first;

    out.warmStartup = await measure(async () => {
      await fetchJson(`${baseUrl}/api/health`);
    });
    out.bootstrap = await measure(async () => {
      await fetchJson(`${baseUrl}/api/bootstrap`, { vault: 0 });
    });
    out.firstEditorInteractive = await measure(async () => {
      await page.goto(baseUrl);
      await page.waitForSelector(".main");
      await page.locator(".note-row").first().click();
      await page.waitForSelector(".app-editor");
    });
    out.openNote = await measure(async () => {
      await fetchJson(`${baseUrl}/api/notes/${encodeURIComponent(first.noteId)}`, { vault: 0 });
    });
    out.switchNote = await measure(async () => {
      await page
        .locator(`.note-row[title="${cssEscape(second.path)}"]`)
        .first()
        .click();
      await page.locator(`.tab.active[title="${cssEscape(second.title)}"]`).waitFor();
    });
    out.editSave = await measure(async () => {
      const document = await fetchJson(`${baseUrl}/api/notes/${encodeURIComponent(first.noteId)}`, {
        vault: 0,
      });
      await fetchJson(`${baseUrl}/api/notes/${encodeURIComponent(first.noteId)}`, {
        method: "PUT",
        vault: 0,
        body: {
          content: `${document.content}\nbench ${Date.now()}\n`,
          baseSeq: document.meta.seq,
          baseHash: document.meta.contentHash,
          checkpoint: false,
        },
      });
    });
    out.search = await measure(async () => {
      await fetchJson(`${baseUrl}/api/search?q=GlobalFoundries`, { vault: 0 });
    });
    out.conflictRestore = await measure(async () => {
      const document = await fetchJson(`${baseUrl}/api/notes/${encodeURIComponent(first.noteId)}`, {
        vault: 0,
      });
      await fetchJson(`${baseUrl}/api/notes/${encodeURIComponent(first.noteId)}`, {
        method: "PUT",
        vault: 0,
        body: {
          content: `${document.content}\ncurrent ${Date.now()}\n`,
          baseSeq: document.meta.seq,
          baseHash: document.meta.contentHash,
          checkpoint: false,
        },
      });
      const conflict = await fetchJson(`${baseUrl}/api/notes/${encodeURIComponent(first.noteId)}`, {
        method: "PUT",
        vault: 0,
        allowError: true,
        body: {
          content: `${document.content}\nstale ${Date.now()}\n`,
          baseSeq: document.meta.seq,
          baseHash: document.meta.contentHash,
          checkpoint: false,
        },
      });
      const draftId = conflict.error.draft.draftId;
      await fetchJson(
        `${baseUrl}/api/notes/${encodeURIComponent(first.noteId)}/conflicts/${draftId}/restore`,
        {
          method: "POST",
          vault: 0,
        },
      );
    });
    out.ssePropagation = await measure(async () => {
      await page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const source = new EventSource("/events?vault=0");
            const timer = setTimeout(() => {
              source.close();
              reject(new Error("SSE timeout"));
            }, 5000);
            source.addEventListener("open", () => {
              void fetch("/api/notes", {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-Tansu-Vault": "0" },
                body: JSON.stringify({
                  path: `sse-${Date.now()}.md`,
                  content: "# SSE\n\nbench\n",
                  source: null,
                }),
              });
            });
            source.addEventListener("message", (event) => {
              const payload = JSON.parse(event.data);
              if (payload.kind === "note_changed") {
                clearTimeout(timer);
                source.close();
                resolve(null);
              }
            });
          }),
      );
    });
    out.watcherExternalEdit = await measure(async () => {
      const path = join(fixture.vaultOne, "external-bench.md");
      await writeFile(path, `# External\n\n${Date.now()}\n`, "utf8");
      await poll(async () => {
        const latest = await fetchJson(`${baseUrl}/api/bootstrap`, { vault: 0 });
        return latest.notes.some((note) => note.path === "external-bench.md");
      });
    });
    out.imagePath = await measure(async () => {
      const response = await fetch(
        `${baseUrl}/api/assets?name=${encodeURIComponent("z-images/sample.webp")}&vault=0`,
      );
      if (!response.ok) {
        throw new Error(`asset request failed: ${response.status}`);
      }
      const blob = await response.blob();
      const upload = await fetch(`${baseUrl}/api/images`, {
        method: "POST",
        headers: { "Content-Type": "image/webp", "X-Tansu-Vault": "0" },
        body: blob,
      });
      if (!upload.ok) {
        throw new Error(`image upload failed: ${upload.status}`);
      }
    });
    out.revisionRestore = await measure(async () => {
      const document = await fetchJson(`${baseUrl}/api/notes/${encodeURIComponent(first.noteId)}`, {
        vault: 0,
      });
      const saved = await fetchJson(`${baseUrl}/api/notes/${encodeURIComponent(first.noteId)}`, {
        method: "PUT",
        vault: 0,
        body: {
          content: `${document.content}\nrevision ${Date.now()}\n`,
          baseSeq: document.meta.seq,
          baseHash: document.meta.contentHash,
          checkpoint: true,
        },
      });
      const revisions = await fetchJson(
        `${baseUrl}/api/notes/${encodeURIComponent(first.noteId)}/revisions`,
        { vault: 0 },
      );
      const revision = revisions.find((item) => item.eventId > 0) ?? revisions[0];
      await fetchJson(
        `${baseUrl}/api/notes/${encodeURIComponent(saved.meta.noteId)}/revisions/${revision.eventId}/restore`,
        {
          method: "POST",
          vault: 0,
        },
      );
    });
    return out;
  } finally {
    await page.close();
  }
}

async function measure(fn) {
  for (let i = 0; i < warmups; i += 1) {
    await fn();
  }
  const values = [];
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    await fn();
    values.push(performance.now() - start);
  }
  return values;
}

async function createBenchmarkFixture(root) {
  return await createTestFixture(root, { copyVaults: true });
}

async function fetchJson(url, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.vault !== undefined) {
    headers.set("X-Tansu-Vault", String(options.vault));
  }
  let body;
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(options.body);
  }
  const response = await fetch(url, { method: options.method ?? "GET", headers, body });
  const data = await response.json();
  if (!response.ok && !options.allowError) {
    throw new Error(`request failed: ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function waitForReady(url) {
  await poll(async () => {
    try {
      const response = await fetch(url);
      return response.ok;
    } catch {
      return false;
    }
  }, 30_000);
}

async function poll(fn, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for condition");
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

function summarizeResults(results) {
  const out = {};
  flattenMetrics(results.metrics, [], out);
  return out;
}

function flattenMetrics(value, path, out) {
  if (Array.isArray(value)) {
    const sorted = [...value].toSorted((a, b) => a - b);
    out[path.join(".")] = {
      medianMs: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
    };
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    flattenMetrics(child, [...path, key], out);
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return Math.round(sorted[index] * 100) / 100;
}

async function readBudgets() {
  const text = await import("node:fs/promises").then((fs) =>
    fs.readFile(join(BENCH_DIR, "budgets.json"), "utf8"),
  );
  return JSON.parse(text).integrated ?? {};
}

function checkBudget(summary, budgets) {
  const failures = [];
  for (const [metric, budget] of Object.entries(budgets)) {
    const value = summary[metric];
    if (value === undefined) continue;
    if (budget.medianMs !== undefined && value.medianMs > budget.medianMs) {
      failures.push(`${metric} median ${value.medianMs}ms > ${budget.medianMs}ms`);
    }
    if (budget.p95Ms !== undefined && value.p95Ms > budget.p95Ms) {
      failures.push(`${metric} p95 ${value.p95Ms}ms > ${budget.p95Ms}ms`);
    }
    if (budget.maxBytes !== undefined && value.p95Ms > budget.maxBytes) {
      failures.push(`${metric} ${value.p95Ms} bytes > ${budget.maxBytes} bytes`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`benchmark budgets failed:\n${failures.join("\n")}`);
  }
}

function printSummary(summary, output) {
  console.log(`benchmark results: ${output}`);
  for (const [metric, value] of Object.entries(summary)) {
    const unit = metric.endsWith("Bytes") ? "bytes" : "ms";
    console.log(`${metric}: median=${value.medianMs} ${unit} p95=${value.p95Ms} ${unit}`);
  }
}

async function fileSize(path) {
  return (await stat(path)).size;
}

function rssBytes(pid) {
  try {
    const output = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
    return Number(output) * 1024;
  } catch {
    return null;
  }
}

function cssEscape(value) {
  return value.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`);
}

function parseArgs(values) {
  const parsed = {};
  for (const arg of values) {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=");
    parsed[key] = value;
  }
  return parsed;
}

await main();
