import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, webkit } from "playwright";

import { createTestFixture } from "../scripts/test-fixture.mjs";
import { canonicalSourceHash } from "../web/ts/save-delta.ts";
import { directorySize } from "./directory-size.mjs";
import { stopProcessGroup } from "./process-group.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const BENCH_DIR = join(REPO_ROOT, "bench");
const RESULTS_DIR = join(REPO_ROOT, ".work", "tmp", "bench-results");
const SEARCH_QUERY = "alpha";
const SEARCH_RESULT_PATH = "search.md";
const LARGE_NOTE_PATH = "tns-19-20-baseline.md";
const LARGE_NOTE_BYTES = 1024 * 1024;
const LARGE_NOTE_MATCHES = 100;
const LARGE_NOTE_QUERY = "needle";

const args = parseArgs(process.argv.slice(2));
const warmups = Number(args.warmups ?? 2);
const runs = Number(args.runs ?? 5);
const browsers = String(args.browser ?? "chromium")
  .split(",")
  .filter(Boolean);
const checkBudgets = args["check-budgets"] !== "false" && args.calibrate !== "true";

const browserTypes = { chromium, webkit };

async function main() {
  execFileSync("deno", ["task", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
  await mkdir(RESULTS_DIR, { recursive: true });

  const root = await mkdtemp(join(tmpdir(), "tansu2-bench-"));
  let server;
  try {
    const fixture = await createBenchmarkFixture(root);
    const largeNote = await createLargeNote(fixture.vaultOne);
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const serverStart = performance.now();
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

    const results = {
      generatedAt: new Date().toISOString(),
      config: { warmups, runs, browsers, largeNote: { bytes: largeNote.bytes, matches: largeNote.matches } },
      metrics: {},
    };
    await waitForReady(`${baseUrl}/api/v2/health`);
    results.metrics.coldStartup = [performance.now() - serverStart];
    const globalBootstrap = await fetchJson(`${baseUrl}/api/v2/bootstrap`);
    const vault = globalBootstrap.vaults.find((item) => item.name === "One");
    if (vault === undefined) throw new Error("benchmark fixture has no vault One");
    const identity = { serverInstanceId: globalBootstrap.serverInstanceId, vaultId: vault.vaultId };
    const vaultBootstrap = await vaultJson(baseUrl, identity, "/bootstrap");
    const first = vaultBootstrap.notes.find((note) => note.path === "one.md");
    const second = vaultBootstrap.notes.find((note) => note.path === "search.md");
    if (first === undefined || second === undefined) throw new Error("benchmark fixture is missing its seeded notes");

    for (const name of browsers) {
      const type = browserTypes[name];
      if (type === undefined) {
        throw new Error(`unknown browser: ${name}`);
      }
      const browser = await type.launch();
      try {
        results.metrics[name] = await runBrowserBenchmarks(browser, baseUrl, fixture, identity, first, second, largeNote);
      } finally {
        await browser.close();
      }
    }

    results.metrics.productionBundleBytes = [
      await productionBundleSizeBytes(),
    ];
    results.metrics.catalogBytes = [await directorySize(join(fixture.dataHome, "tansu"))];
    results.metrics.serverRssBytes = [processTreeRssBytes(server.pid)];

    const summary = summarizeResults(results);
    if (checkBudgets) {
      checkBudget(summary, await readBudgets());
    }
    const output = join(RESULTS_DIR, `integrated-${Date.now()}.json`);
    await writeFile(output, `${JSON.stringify({ summary, raw: results }, null, 2)}\n`, "utf8");
    printSummary(summary, output);
  } finally {
    if (server !== undefined) await stopProcessGroup(server);
    await rm(root, { recursive: true, force: true });
  }
}

async function runBrowserBenchmarks(browser, baseUrl, fixture, identity, first, second, largeNote) {
  const page = await browser.newPage();
  const out = {};
  try {
    out.warmStartup = await measure(async () => {
      const response = await fetch(`${baseUrl}/api/v2/health`);
      requireOk(response);
    });
    out.bootstrap = await measure(async () => {
      await vaultJson(baseUrl, identity, "/bootstrap");
    });
    let activeNote = first;
    out.firstEditorInteractive = await measure(async () => {
      await page.goto(baseUrl);
      await page.waitForSelector(".main");
      await openNoteThroughQuickOpen(page, first.title);
      await page.waitForSelector(".cm-editor");
      activeNote = first;
    });
    out.openNote = await measure(async () => {
      await vaultJson(baseUrl, identity, `/notes/${encodeURIComponent(first.noteId)}`);
    });
    out.switchNote = await measure(async () => {
      const target = activeNote.noteId === first.noteId ? second : first;
      await openNoteThroughQuickOpen(page, target.title);
      await page.locator(`.tab.active[title="${cssEscape(target.title)}"]`).waitFor();
      activeNote = target;
    });
    out.editSave = await measure(async () => {
      const document = await vaultJson(baseUrl, identity, `/notes/${encodeURIComponent(first.noteId)}`);
      await saveNote(baseUrl, identity, first.noteId, document.meta, `${document.content}\nbench ${randomUUID()}\n`);
    });
    await page.keyboard.press("Control+Shift+f");
    const searchInput = page.locator(".search-panel input");
    const searchTiming = await measureSearchPaint(page, searchInput, SEARCH_QUERY, SEARCH_RESULT_PATH);
    out.searchPainted = searchTiming.paintedMs;
    out.searchRequest = searchTiming.requestMs;
    out.searchRequestEnd = searchTiming.requestEndMs;
    out.searchResultInserted = searchTiming.resultInsertedMs;
    out.searchLongTask = searchTiming.longTaskMs;
    out.searchApi = await measure(async () => {
      const response = await vaultJson(baseUrl, identity, "/search", {
        method: "POST",
        body: { query: SEARCH_QUERY, mode: "default", limit: 50, overlays: [] },
      });
      if (!response.hits.some((hit) => hit.path === SEARCH_RESULT_PATH)) {
        throw new Error("search API response did not include the expected fixture note");
      }
    });
    out.conflictRestore = await measure(async () => {
      const base = await vaultJson(baseUrl, identity, `/notes/${encodeURIComponent(first.noteId)}`);
      await saveNote(baseUrl, identity, first.noteId, base.meta, `${base.content}\ncurrent ${randomUUID()}\n`);
      const current = await vaultJson(baseUrl, identity, `/notes/${encodeURIComponent(first.noteId)}`);
      const conflict = await saveNote(baseUrl, identity, first.noteId, base.meta, `${base.content}\nstale ${randomUUID()}\n`);
      if (conflict.outcome.state !== "conflict") throw new Error("stale benchmark save did not conflict");
      const draftId = conflict.outcome.draft.draftId;
      await vaultJson(baseUrl, identity, `/notes/${encodeURIComponent(first.noteId)}/conflicts/${draftId}/restore`, {
        method: "POST",
        body: { mutationId: randomUUID(), precondition: precondition(current.meta) },
      });
    });
    let eventCursor = 0;
    out.ssePropagation = await measure(async () => {
      const document = await vaultJson(baseUrl, identity, `/notes/${encodeURIComponent(first.noteId)}`);
      const stream = await openEvents(baseUrl, identity, eventCursor);
      try {
        const change = waitForNoteChange(stream.reader, eventCursor, first.noteId, document.meta.revision + 1);
        await saveNote(baseUrl, identity, first.noteId, document.meta, `${document.content}\nsse ${randomUUID()}\n`);
        const event = await change;
        eventCursor = event.eventVersion;
      } finally {
        await stream.close();
      }
    });
    out.watcherExternalEdit = await measure(async () => {
      const pathName = `external-bench-${randomUUID()}.md`;
      const path = join(fixture.vaultOne, pathName);
      await writeFile(path, `# External\n\n${Date.now()}\n`, "utf8");
      await poll(async () => {
        const latest = await vaultJson(baseUrl, identity, "/bootstrap");
        return latest.notes.some((note) => note.path === pathName);
      });
    });
    out.imagePath = await measure(async () => {
      const assetUrl = `${baseUrl}/api/v2/vaults/${encodeURIComponent(identity.vaultId)}/assets?name=${encodeURIComponent("z-images/sample.webp")}`;
      const response = await fetch(assetUrl, { headers: identityHeaders(identity) });
      requireOk(response);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const upload = await vaultRequest(baseUrl, identity, "/images", {
        method: "POST",
        headers: { "Content-Type": "image/webp", "X-Tansu-Mutation-Id": randomUUID() },
        body: bytes,
      });
      requireOk(upload);
      const created = await upload.json();
      const stored = await fetch(
        `${baseUrl}/api/v2/vaults/${encodeURIComponent(identity.vaultId)}/assets?name=${encodeURIComponent(created.name)}`,
        { headers: identityHeaders(identity) },
      );
      requireOk(stored);
      await stored.arrayBuffer();
    });
    out.revisionRestore = await measure(async () => {
      const document = await vaultJson(baseUrl, identity, `/notes/${encodeURIComponent(first.noteId)}`);
      const revision = await vaultJson(baseUrl, identity, `/notes/${encodeURIComponent(first.noteId)}/revisions`)
        .then((items) => items.find((item) => item.sourceHash === first.sourceHash));
      if (revision === undefined) throw new Error("benchmark note has no original revision");
      await saveNote(baseUrl, identity, first.noteId, document.meta, `${document.content}\nrevision ${randomUUID()}\n`);
      const current = await vaultJson(baseUrl, identity, `/notes/${encodeURIComponent(first.noteId)}`);
      await vaultJson(baseUrl, identity, `/notes/${encodeURIComponent(first.noteId)}/revisions/${revision.revision}/restore`, {
        method: "POST",
        body: { mutationId: randomUUID(), precondition: precondition(current.meta) },
      });
    });
    const largeNoteMeta = (await vaultJson(baseUrl, identity, "/bootstrap")).notes
      .find((note) => note.path === largeNote.path);
    if (largeNoteMeta === undefined) throw new Error("large benchmark note was not indexed");
    await page.keyboard.press("Escape");
    await page.locator(".search-panel").waitFor({ state: "detached" });
    const largeNoteUrl = new URL(
      `/api/v2/vaults/${encodeURIComponent(identity.vaultId)}/notes/${encodeURIComponent(largeNoteMeta.noteId)}`,
      baseUrl,
    ).pathname;
    const largeNoteResponse = page.waitForResponse((response) =>
      response.request().method() === "GET" && new URL(response.url()).pathname === largeNoteUrl
    );
    await openNoteThroughQuickOpen(page, largeNote.title);
    const loadedLargeNote = await largeNoteResponse.then((response) => response.json());
    if (Buffer.byteLength(loadedLargeNote.content) !== largeNote.bytes) {
      throw new Error("large benchmark note response has an unexpected size");
    }
    await page.locator(`.tab.active[title="${cssEscape(largeNote.title)}"]`).waitFor();
    await page.locator(".cm-editor .cm-content").waitFor({ state: "visible" });
    if (!(await page.locator(".cm-editor .cm-content").textContent())?.includes(LARGE_NOTE_QUERY)) {
      throw new Error("large benchmark note content was not loaded in the editor");
    }
    const findInput = page.locator('.main .find-bar input[data-key="current-note-find"]');
    const findCount = page.locator(".main .find-bar .find-count");
    const findShortcut = process.platform === "darwin" ? "Meta+f" : "Control+f";
    out.largeNoteFindOpen = await measureUiTransition(
      page,
      async () => {
        await page.keyboard.press(findShortcut);
        await findInput.waitFor({ state: "visible" });
      },
      async () => {
        if (!await findInput.isVisible()) throw new Error("Find panel did not open");
      },
      async () => {
        await page.keyboard.press("Escape");
        await findInput.waitFor({ state: "detached" });
      },
    );
    out.largeNoteFindResults100 = await measureUiTransition(
      page,
      async () => {
        await page.keyboard.press(findShortcut);
        await findInput.waitFor({ state: "visible" });
        await findInput.fill("");
        await page.waitForFunction(() => document.querySelector(".main .find-count")?.textContent === "");
      },
      async () => {
        await findInput.fill(LARGE_NOTE_QUERY);
        await page.waitForFunction((expected) => document.querySelector(".main .find-count")?.textContent === `1 of ${expected}`, LARGE_NOTE_MATCHES);
      },
      async () => {
        await page.keyboard.press("Escape");
        await findInput.waitFor({ state: "detached" });
      },
    );
    const sidebar = page.locator('[data-view-region="sidebar"]');
    const sidebarToggle = page.locator(".sidebar-collapse");
    const activateSidebarToggle = async () => {
      await sidebarToggle.evaluate((element) => {
        if (!(element instanceof HTMLButtonElement)) throw new Error("The sidebar toggle is missing");
        element.click();
      });
    };
    out.largeNoteSidebarToggle = await measureUiTransition(
      page,
      async () => {
        if (await sidebar.evaluate((element) => element.classList.contains("sidebar-collapsed"))) {
          await activateSidebarToggle();
        }
        await sidebar.waitFor({ state: "visible" });
      },
      async () => {
        await activateSidebarToggle();
        await page.waitForFunction(() =>
          document.querySelector('[data-view-region="sidebar"]')?.classList.contains("sidebar-collapsed") === true
        );
        if (!await page.locator(`.tab.active[title="${cssEscape(largeNote.title)}"]`).isVisible()) {
          throw new Error("large benchmark note was not open during sidebar toggle");
        }
      },
      async () => {
        await activateSidebarToggle();
        await page.waitForFunction(() =>
          document.querySelector('[data-view-region="sidebar"]')?.classList.contains("sidebar-collapsed") === false
        );
      },
    );
    return out;
  } finally {
    await page.close();
  }
}

async function openNoteThroughQuickOpen(page, title) {
  await page.keyboard.press("Control+p");
  const panel = page.locator(".quick-open-panel");
  await panel.waitFor({ state: "visible" });
  await panel.locator(".command-input").fill(title);
  const row = panel.locator(".quick-open-results .command-row").filter({ hasText: title }).first();
  await row.waitFor({ state: "visible" });
  await row.click();
  await panel.waitFor({ state: "detached" });
}

async function measureUiTransition(page, setup, transition, cleanup) {
  for (let i = 0; i < warmups; i += 1) {
    await setup();
    await transition();
    await cleanup();
  }
  const values = [];
  for (let i = 0; i < runs; i += 1) {
    await setup();
    const start = performance.now();
    await transition();
    values.push(performance.now() - start);
    await cleanup();
  }
  return values;
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

async function measureSearchPaint(page, input, query, expectedPath) {
  await page.evaluate(() => {
    globalThis.__tansuSearchLongTasks = [];
    globalThis.__tansuSearchLongTaskObserver = new PerformanceObserver((list) => {
      globalThis.__tansuSearchLongTasks.push(...list.getEntries().map(({ startTime, duration }) => ({ startTime, duration })));
    });
    globalThis.__tansuSearchLongTaskObserver.observe({ type: "longtask", buffered: true });
  });
  const measureOne = async () => {
    await input.fill("");
    await page.locator(".search-panel .search-result-row").first().waitFor({ state: "detached" });
    await page.evaluate(() => {
      performance.clearResourceTimings();
      performance.clearMarks("tansu:search:start");
      performance.clearMeasures("tansu:search:painted");
      performance.mark("tansu:search:start");
      globalThis.__tansuSearchResultInsertedAt = null;
      globalThis.__tansuSearchMutationObserver?.disconnect();
      globalThis.__tansuSearchMutationObserver = new MutationObserver(() => {
        if (document.querySelector(".search-panel .search-result-row") !== null) {
          globalThis.__tansuSearchResultInsertedAt ??= performance.now();
        }
      });
      globalThis.__tansuSearchMutationObserver.observe(
        document.querySelector(".search-panel .command-list"),
        { childList: true, subtree: true },
      );
    });
    await input.fill(query);
    return await page.evaluate(async (expectedPath) => {
      const expectedResult = () => [...document.querySelectorAll(".search-panel .search-result-row")]
        .find((row) => row.textContent?.includes(expectedPath) && row.getClientRects().length > 0);
      if (expectedResult() === undefined) {
        await new Promise((resolve) => {
          const list = document.querySelector(".search-panel .command-list");
          if (list === null) throw new Error("search result list is missing");
          const observer = new MutationObserver(() => {
            if (expectedResult() !== undefined) {
              observer.disconnect();
              resolve();
            }
          });
          observer.observe(list, { childList: true, subtree: true });
        });
      }
      if (expectedResult() === undefined) throw new Error("search results did not contain the expected note");
      const start = performance.getEntriesByName("tansu:search:start", "mark").at(-1);
      const observer = globalThis.__tansuSearchLongTaskObserver;
      globalThis.__tansuSearchLongTasks.push(...observer.takeRecords().map(({ startTime, duration }) => ({ startTime, duration })));
      const request = performance.getEntriesByType("resource")
        .findLast((entry) => new URL(entry.name).pathname.endsWith("/search"));
      if (start === undefined || request === undefined) throw new Error("search request timing is missing");
      const paintedMs = await new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          resolve(performance.measure("tansu:search:painted", "tansu:search:start").duration);
        }));
      });
      globalThis.__tansuSearchMutationObserver.disconnect();
      return {
        paintedMs,
        requestMs: request.duration,
        requestEndMs: request.responseEnd - start.startTime,
        resultInsertedMs: globalThis.__tansuSearchResultInsertedAt === null
          ? -1
          : globalThis.__tansuSearchResultInsertedAt - start.startTime,
        longTaskMs: Math.max(0, ...globalThis.__tansuSearchLongTasks
          .filter((task) => task.startTime >= start.startTime && task.startTime < start.startTime + paintedMs)
          .map((task) => task.duration)),
      };
    }, expectedPath);
  };
  for (let i = 0; i < warmups; i += 1) await measureOne();
  const values = { paintedMs: [], requestMs: [], requestEndMs: [], resultInsertedMs: [], longTaskMs: [] };
  for (let i = 0; i < runs; i += 1) {
    const sample = await measureOne();
    values.paintedMs.push(sample.paintedMs);
    values.requestMs.push(sample.requestMs);
    values.requestEndMs.push(sample.requestEndMs);
    values.resultInsertedMs.push(sample.resultInsertedMs);
    values.longTaskMs.push(sample.longTaskMs);
  }
  return values;
}

async function createBenchmarkFixture(root) {
  return await createTestFixture(root, { copyVaults: true });
}

async function createLargeNote(vaultPath) {
  const matches = `${LARGE_NOTE_QUERY}\n`.repeat(LARGE_NOTE_MATCHES);
  const title = "TNS-19/20 Baseline";
  const prefix = `# ${title}\n\n${matches}`;
  const paddingBytes = LARGE_NOTE_BYTES - Buffer.byteLength(prefix);
  const padding = `${"x".repeat(1023)}\n`.repeat(Math.floor(paddingBytes / 1024)) +
    "x".repeat(paddingBytes % 1024);
  const content = `${prefix}${padding}`;
  if (Buffer.byteLength(content) !== LARGE_NOTE_BYTES) {
    throw new Error(`large benchmark note is not ${LARGE_NOTE_BYTES} bytes`);
  }
  const path = join(vaultPath, LARGE_NOTE_PATH);
  await writeFile(path, content, "utf8");
  const info = await stat(path);
  if (info.size !== LARGE_NOTE_BYTES || content.match(/needle/g)?.length !== LARGE_NOTE_MATCHES) {
    throw new Error("large benchmark note has an unexpected size or match count");
  }
  return { path: LARGE_NOTE_PATH, title, bytes: info.size, matches: LARGE_NOTE_MATCHES };
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`request failed: ${response.status}`);
  return await response.json();
}

function identityHeaders(identity) {
  return new Headers({ "X-Tansu-Server-Instance": identity.serverInstanceId });
}

async function vaultRequest(baseUrl, identity, path, options = {}) {
  const headers = identityHeaders(identity);
  new Headers(options.headers).forEach((value, key) => headers.set(key, value));
  let body = options.body;
  if (body !== undefined && !(body instanceof Uint8Array) && typeof body !== "string") {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(body);
  }
  return await fetch(`${baseUrl}/api/v2/vaults/${encodeURIComponent(identity.vaultId)}${path}`, {
    ...options,
    headers,
    body,
  });
}

async function vaultJson(baseUrl, identity, path, options = {}) {
  const response = await vaultRequest(baseUrl, identity, path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(`request failed: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function saveNote(baseUrl, identity, noteId, meta, content) {
  return await vaultJson(baseUrl, identity, `/notes/${encodeURIComponent(noteId)}`, {
    method: "PUT",
    body: {
      mutationId: randomUUID(),
      precondition: precondition(meta),
      content,
      sourceHash: await canonicalSourceHash(content),
    },
  });
}

function precondition(meta) {
  return {
    baseRevision: meta.revision,
    baseSourceHash: meta.sourceHash,
    baseDiskHash: meta.diskHash,
  };
}

async function openEvents(baseUrl, identity, eventVersion) {
  const response = await vaultRequest(baseUrl, identity, `/events?after=${eventVersion}`, {
    headers: { Accept: "text/event-stream" },
  });
  requireOk(response);
  if (response.body === null) throw new Error("event stream has no body");
  const reader = response.body.getReader();
  return { reader, close: () => reader.cancel() };
}

async function waitForNoteChange(reader, afterEventVersion, noteId, minimumRevision) {
  let lastEventVersion = afterEventVersion;
  let buffer = "";
  const decoder = new TextDecoder();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("event stream closed before note change");
    buffer += decoder.decode(chunk.value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find((item) => item.startsWith("data: "));
      if (line === undefined) continue;
      const event = JSON.parse(line.slice(6));
      if (event.eventVersion <= lastEventVersion) continue;
      lastEventVersion = event.eventVersion;
      if (
        event.update?.kind === "noteChanged" && event.update.note?.noteId === noteId &&
        event.update.note.revision >= minimumRevision
      ) {
        return event;
      }
    }
  }
}

function requireOk(response) {
  if (!response.ok) throw new Error(`request failed: ${response.status}`);
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

async function productionBundleSizeBytes() {
  const manifestPath = join(REPO_ROOT, "web", "dist", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const javascript = manifest.files.find((file) => file.contentType === "text/javascript; charset=utf-8");
  if (javascript === undefined) throw new Error("production web manifest has no JavaScript bundle");
  return fileSize(join(REPO_ROOT, "web", "dist", javascript.file));
}

function processTreeRssBytes(rootPid) {
  const output = execFileSync("ps", ["-Ao", "pid=,ppid=,rss="], { encoding: "utf8" });
  const parentByPid = new Map();
  const rssByPid = new Map();
  for (const line of output.split("\n")) {
    const [pid, parent, rss] = line.trim().split(/\s+/).map(Number);
    if (Number.isFinite(pid) && Number.isFinite(parent) && Number.isFinite(rss)) {
      parentByPid.set(pid, parent);
      rssByPid.set(pid, rss);
    }
  }
  let total = 0;
  const pending = [rootPid];
  const seen = new Set();
  while (pending.length > 0) {
    const pid = pending.pop();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    total += rssByPid.get(pid) ?? 0;
    for (const [child, parent] of parentByPid) {
      if (parent === pid) pending.push(child);
    }
  }
  if (total === 0) throw new Error(`fixture server process ${rootPid} was not found`);
  return total * 1024;
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
