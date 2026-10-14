import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { createTestFixture } from "../scripts/test-fixture.mjs";
import { stopProcessGroup } from "./process-group.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const RESULTS_DIR = join(REPO_ROOT, ".work", "tmp", "bench-results");
const ITERATIONS = Number(process.argv[2] ?? 20);
const NOTE_DELAY_MS = 75;
const SEARCH_DELAY_MS = 75;

async function main() {
    execFileSync("deno", ["task", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
  await mkdir(RESULTS_DIR, { recursive: true });
  const root = await mkdtemp(join(tmpdir(), "tansu2-long-session-"));
  let server;
  let browser;
  let context;
  let failure;
  try {
    const fixture = await createTestFixture(root, { copyVaults: true });
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(
      "cargo",
      ["run", "--quiet", "--bin", "tansu2", "--", "--port", String(port)],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          TANSU2_LOGS: "buffer",
          XDG_CONFIG_HOME: fixture.configHome,
          XDG_DATA_HOME: fixture.dataHome,
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );
    await waitForReady(`${baseUrl}/api/v2/health`, server);
    const globalBootstrap = await fetchJson(`${baseUrl}/api/v2/bootstrap`);
    const vault = globalBootstrap.vaults.find((item) => item.name === "One");
    if (vault === undefined) throw new Error("long-session fixture has no vault One");
    const identity = { serverInstanceId: globalBootstrap.serverInstanceId, vaultId: vault.vaultId };
    const vaultBootstrap = await vaultJson(baseUrl, identity, "/bootstrap");
    const noteByPath = new Map(vaultBootstrap.notes.map((note) => [note.path, note]));
    const one = requireNote(noteByPath, "one.md");
    const search = requireNote(noteByPath, "search.md");
    const visual = requireNote(noteByPath, "visual.md");
    const capacities = await readQueueCapacities();
    const activeEvents = new Set();
    const pendingRequests = new Set();
    let delayedNoteRequests = 0;
    let delayedSearchRequests = 0;
    let failedRequests = 0;
    let failNoteOpen = true;
    let failSearch = true;
    let lastRequestAt = Date.now();

    browser = await chromium.launch({ args: ["--enable-precise-memory-info"] });
    context = await browser.newContext({ locale: "en-US", timezoneId: "UTC", viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await page.addInitScript(() => {
      const metrics = { mounted: 0, unmounted: 0 };
      Object.defineProperty(window, "__tansuEditorDomMetrics", { value: metrics });
      const editorNodes = (node) => {
        if (!(node instanceof Element)) return [];
        return [
          ...(node.matches(".cm-editor") ? [node] : []),
          ...node.querySelectorAll(".cm-editor"),
        ];
      };
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) metrics.mounted += editorNodes(node).length;
          for (const node of record.removedNodes) metrics.unmounted += editorNodes(node).length;
        }
      }).observe(document, { childList: true, subtree: true });
    });
    await page.route("**/api/v2/vaults/*/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const noteMatch = url.pathname.match(/\/notes\/([^/]+)$/);
      if (request.method() === "GET" && noteMatch !== null) {
        delayedNoteRequests += 1;
        await delay(NOTE_DELAY_MS);
        if (decodeURIComponent(noteMatch[1]) === search.noteId && failNoteOpen) {
          failNoteOpen = false;
          failedRequests += 1;
          await route.abort("failed");
          return;
        }
      }
      if (request.method() === "POST" && url.pathname.endsWith("/search")) {
        delayedSearchRequests += 1;
        await delay(SEARCH_DELAY_MS);
        if (failSearch) {
          failSearch = false;
          failedRequests += 1;
          await route.abort("failed");
          return;
        }
      }
      await route.continue();
    });
    page.on("request", (request) => {
      lastRequestAt = Date.now();
      if (isEventStream(request)) activeEvents.add(request);
      else pendingRequests.add(request);
    });
    page.on("requestfinished", (request) => {
      activeEvents.delete(request);
      pendingRequests.delete(request);
    });
    page.on("requestfailed", (request) => {
      activeEvents.delete(request);
      pendingRequests.delete(request);
    });

    await page.goto(baseUrl);
    await page.waitForSelector(".main");
    await openNote(page, one);
    const noteOpenFailed = page.waitForEvent("requestfailed", (request) =>
      request.url().includes(`/notes/${encodeURIComponent(search.noteId)}`)
    );
    await noteRow(page, search).click();
    await noteOpenFailed;
    await closeActiveTab(page);
    await openNote(page, search);
    await closeActiveTab(page);

    const searchFailed = page.waitForEvent("requestfailed", (request) =>
      new URL(request.url()).pathname.endsWith("/search")
    );
    await openSearch(page, "GlobalFoundries");
    await searchFailed;
    await page.locator(".search-panel input").fill("GlobalFoundries ");
    await page.waitForSelector(".search-result-row");
    await closeSearch(page);
    await closeActiveTab(page);

    await waitForIdle(lastRequestAt, pendingRequests);
    const baseline = await snapshot(page, cdp, activeEvents, pendingRequests, server.pid);
    const resourceSamples = [{ iteration: 0, ...baseline }];
    await cdp.send("HeapProfiler.startSampling", { samplingInterval: 32768 });

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      await openNote(page, one);
      const beforeEdit = await page.locator(".cm-content").textContent();
      await page.locator(".cm-content").click();
      await page.keyboard.press(endOfDocumentShortcut());
      await page.keyboard.insertText(` soak-${iteration}`);
      await page.keyboard.press(`${shortcutModifier()}+z`);
      await page.waitForFunction((source) => document.querySelector(".cm-content")?.textContent === source, beforeEdit);
      await openNote(page, visual);
      const image = page.locator('.cm-content img[data-image-name="z-images/sample.webp"]');
      await image.waitFor({ state: "attached" });
      await image.evaluate((element) => element.decode());
      await openNote(page, one);
      await closeActiveTab(page);
      await closeActiveTab(page);
      await openSearch(page, "GlobalFoundries");
      await page.waitForSelector(".search-result-row");
      await closeSearch(page);
      if ((iteration + 1) % 5 === 0 && iteration + 1 < ITERATIONS) {
        await waitForIdle(lastRequestAt, pendingRequests);
        resourceSamples.push({
          iteration: iteration + 1,
          ...await snapshot(page, cdp, activeEvents, pendingRequests, server.pid),
        });
      }
    }

    await waitForIdle(lastRequestAt, pendingRequests);
    const after = await snapshot(page, cdp, activeEvents, pendingRequests, server.pid);
    const { profile } = await cdp.send("HeapProfiler.stopSampling");
    await waitForSearchIdle(baseUrl, identity);
    const vaultAfter = await vaultJson(baseUrl, identity, "/bootstrap");
    const logSnapshot = await fetchJson(`${baseUrl}/api/dev/logs`);
    const searchQueueOverflows = logSnapshot.events.filter((event) =>
      event.fields?.system?.action === "search_failure" &&
      String(event.fields.system.operation).includes("queue overflow")
    ).length;
    const report = {
      browser: browser.version(),
      iterations: ITERATIONS,
      simulatedNoteDelayMs: NOTE_DELAY_MS,
      simulatedSearchDelayMs: SEARCH_DELAY_MS,
      delayedNoteRequests,
      delayedSearchRequests,
      failedRequests,
      baseline,
      after,
      resourceSamples: [...resourceSamples, { iteration: ITERATIONS, ...after }],
      sampledHeapAllocations: summarizeSampledAllocations(profile),
      deltas: {
        heapBytes: after.heapBytes - baseline.heapBytes,
        domElements: after.domElements - baseline.domElements,
        editorViews: after.editorViews - baseline.editorViews,
        editorDomLive: after.editorDomLive - baseline.editorDomLive,
        editorDomMounts: after.editorDomMounts - baseline.editorDomMounts,
        editorDomUnmounts: after.editorDomUnmounts - baseline.editorDomUnmounts,
        serverRssBytes: after.serverRssBytes - baseline.serverRssBytes,
      },
      queues: {
        capacities,
        pendingHttpRequests: after.pendingRequests,
        activeEventStreams: after.activeEventStreams,
        searchDirty: vaultAfter.searchStatus.dirty,
        searchDegraded: vaultAfter.searchStatus.degraded,
        searchQueueOverflows,
      },
    };
    if (failedRequests < 2 || delayedNoteRequests === 0 || delayedSearchRequests === 0) {
      throw new Error(`long-session fault injection was incomplete: ${JSON.stringify(report)}`);
    }
    if (
      after.pendingRequests !== 0 || after.activeEventStreams !== 1 ||
      baseline.editorViews !== 1 ||
      after.editorViews !== baseline.editorViews || after.editorDomLive !== baseline.editorDomLive
    ) {
      throw new Error(`long-session resources did not return to idle: ${JSON.stringify(report)}`);
    }
    if (vaultAfter.searchStatus.degraded || searchQueueOverflows !== 0) {
      throw new Error(`long-session search queue degraded: ${JSON.stringify(report)}`);
    }
    const output = join(RESULTS_DIR, `long-session-${Date.now()}.json`);
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ output, ...report }, null, 2)}\n`);
  } catch (error) {
    failure = error;
  } finally {
    for (const cleanup of [
      () => context?.close(),
      () => browser?.close(),
      () => server === undefined ? undefined : stopProcessGroup(server),
      () => rm(root, { recursive: true, force: true }),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        process.stderr.write(`cleanup failed: ${String(error)}\n`);
        failure ??= error;
      }
    }
  }
  if (failure !== undefined) throw failure;
}

function summarizeSampledAllocations(profile) {
  const totals = new Map();
  function visit(node) {
    const frame = node.callFrame;
    if (frame !== undefined && node.selfSize > 0) {
      const location = `${frame.functionName || "anonymous"} (${frame.url || "native"}:${frame.lineNumber})`;
      const total = totals.get(location) ?? { bytes: 0, samples: 0 };
      total.bytes += node.selfSize;
      total.samples += 1;
      totals.set(location, total);
    }
    for (const child of node.children ?? []) visit(child);
  }
  visit(profile.head);
  return [...totals]
    .map(([location, total]) => ({ location, ...total }))
    .toSorted((left, right) => right.bytes - left.bytes)
    .slice(0, 15);
}

async function openNote(page, note) {
  await noteRow(page, note).click();
  await page.waitForFunction(({ title, marker }) =>
    document.querySelector(".tab.active")?.getAttribute("title") === title &&
    document.querySelector(".cm-content")?.textContent?.includes(marker) === true,
  { title: note.title, marker: note.title });
}

function noteRow(page, note) {
  return page.locator(`.note-row[title="${cssEscape(note.path)}"]`).first();
}

async function closeActiveTab(page) {
  const current = await page.locator(".tab.active").getAttribute("title");
  const close = page.locator('.tab.active [title="Close"]');
  if (await close.count() === 0) return;
  await close.click();
  await page.waitForFunction((title) => document.querySelector(".tab.active")?.getAttribute("title") !== title, current);
}

async function openSearch(page, query) {
  if (await page.locator(".search-panel").count() === 0) {
    await page.locator('.sidebar-controls [title="Search notes"]').click();
  }
  await page.locator(".search-panel input").fill(query);
}

async function closeSearch(page) {
  await page.keyboard.press("Escape");
  await page.waitForSelector(".search-panel", { state: "detached" });
}

async function snapshot(page, cdp, activeEvents, pendingRequests, serverPid) {
  const resourceTimingEntries = await page.evaluate(() => {
    const count = performance.getEntriesByType("resource").length;
    performance.clearResourceTimings();
    return count;
  });
  await cdp.send("HeapProfiler.collectGarbage");
  const heap = await cdp.send("Runtime.getHeapUsage");
  const domElements = await page.evaluate(() => document.querySelectorAll("*").length);
  const editorViews = await page.locator(".cm-editor").count();
  const editorDom = await page.evaluate(() => ({ ...window.__tansuEditorDomMetrics }));
  return {
    heapBytes: heap.usedSize,
    domElements,
    editorViews,
    resourceTimingEntries,
    editorDomLive: editorDom.mounted - editorDom.unmounted,
    editorDomMounts: editorDom.mounted,
    editorDomUnmounts: editorDom.unmounted,
    activeEventStreams: activeEvents.size,
    pendingRequests: pendingRequests.size,
    serverRssBytes: processTreeRssBytes(serverPid),
  };
}

async function waitForIdle(lastRequestAt, pendingRequests) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (pendingRequests.size === 0 && Date.now() - lastRequestAt >= 1_500) return;
    await delay(100);
  }
  throw new Error("browser did not reach the controlled idle point");
}

async function waitForSearchIdle(baseUrl, identity) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const bootstrap = await vaultJson(baseUrl, identity, "/bootstrap");
    if (!bootstrap.searchStatus.dirty) return;
    await delay(100);
  }
  throw new Error("search did not reach the idle state");
}

async function readQueueCapacities() {
  const [vault, http] = await Promise.all([
    readFile(join(REPO_ROOT, "src", "vault.rs"), "utf8"),
    readFile(join(REPO_ROOT, "src", "http.rs"), "utf8"),
  ]);
  return {
    searchJobs: readCapacity(vault, "SEARCH_QUEUE_CAPACITY"),
    eventMessagesPerSubscriber: readCapacity(vault, "EVENT_SUBSCRIBER_CAPACITY"),
    eventBodyChunks: readCapacity(http, "SSE_BODY_QUEUE"),
  };
}

function readCapacity(source, name) {
  const match = source.match(new RegExp(`const ${name}: usize = (\\d+);`));
  if (match === null) throw new Error(`missing queue capacity: ${name}`);
  return Number(match[1]);
}

function requireNote(notes, path) {
  const note = notes.get(path);
  if (note === undefined) throw new Error(`long-session fixture is missing ${path}`);
  return note;
}

async function fetchJson(url) {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(`request failed: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function vaultJson(baseUrl, identity, path) {
  const response = await fetch(`${baseUrl}/api/v2/vaults/${encodeURIComponent(identity.vaultId)}${path}`, {
    headers: { "X-Tansu-Server-Instance": identity.serverInstanceId },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`request failed: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function waitForReady(url, server) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`fixture server exited before readiness: ${server.exitCode} ${server.signalCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    await delay(100);
  }
  throw new Error("fixture server did not become ready");
}

function isEventStream(request) {
  return new URL(request.url()).pathname.endsWith("/events");
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

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => address && typeof address === "object" ? resolve(address.port) : reject(new Error("missing port")));
    });
    server.once("error", reject);
  });
}

function shortcutModifier() {
  return process.platform === "darwin" ? "Meta" : "Control";
}

function endOfDocumentShortcut() {
  return process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End";
}

function cssEscape(value) {
  return value.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

await main();
