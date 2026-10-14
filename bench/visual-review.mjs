import { execFileSync, spawn } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { createTestFixture } from "../scripts/test-fixture.mjs";

const work = resolve(".work/tmp/visual-review");
const fixture = await createTestFixture(join(work, "fixture"), { copyVaults: true });
const target = join(work, "target");
const output = join(work, "screens");
const emptyVault = join(work, "empty-vault");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await mkdir(emptyVault, { recursive: true });
await createReviewAsset(join(fixture.vaultOne, "z-images", "sample.webp"));

const sources = [
  "# Visual Review\n\nA calm paragraph with **bold text**, *emphasis*, and a [link](https://example.com).\n\n## Editing flow\n\nShort notes should be easy to scan at desktop sizes. This paragraph supplies enough text to inspect measure, contrast, and line rhythm.\n\n> [!note] Review note\n> A callout remains part of the authored Markdown source.\n\n## Assets\n\n![[z-images/sample.webp|240]]\n",
  `# Long Text\n\n${"This is a paragraph for visual review with comfortable sentence length and repeated readable content. ".repeat(500)}`,
  `# Image Heavy\n\n${"![[z-images/sample.webp|180]]\n\n".repeat(20)}`,
  `# Wide Table\n\n| ${Array.from({ length: 12 }, (_, index) => `Column ${index + 1}`).join(" | ")} |\n| ${Array.from({ length: 12 }, () => "---").join(" | ")} |\n${Array.from({ length: 24 }, (_, row) => `| ${Array.from({ length: 12 }, (_, column) => `row ${row + 1} value ${column + 1}`).join(" | ")} |`).join("\n")}`,
  `# Long Fence\n\n\`\`\`rust\n${Array.from({ length: 140 }, (_, index) => `fn operation_${index + 1}() -> usize { ${index + 1} }`).join("\n")}\n\`\`\`\n`,
];
const notePaths = ["visual-review.md", "long-text.md", "image-heavy.md", "wide-table.md", "long-fence.md"];
await Promise.all(sources.map((source, index) => writeFile(join(fixture.vaultOne, notePaths[index]), source)));
await writeFile(
  join(fixture.configHome, "tansu", "config.toml"),
  `[[vaults]]\nname = "One"\npath = "${fixture.vaultOne}"\n\n[[vaults]]\nname = "Two"\npath = "${fixture.vaultTwo}"\n\n[[vaults]]\nname = "Empty"\npath = "${emptyVault}"\n`,
);

execFileSync("deno", ["task", "build"], { env: { ...process.env, TMPDIR: resolve(".work/tmp") } });
const port = await freePort();
const env = {
  ...process.env,
  CARGO_TARGET_DIR: target,
  TMPDIR: resolve(".work/tmp"),
  TANSU2_LOGS: "buffer",
  XDG_CONFIG_HOME: fixture.configHome,
  XDG_DATA_HOME: fixture.dataHome,
};
execFileSync("cargo", ["build", "--quiet", "--bin", "tansu2"], { env });
const bundledWebAssets = join(work, "web-dist");
await rm(bundledWebAssets, { recursive: true, force: true });
await rename(resolve("web/dist"), bundledWebAssets);
const server = spawn(join(target, "debug", "tansu2"), ["--port", String(port)], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
const serverLog = [];
server.stdout.on("data", (chunk) => serverLog.push(chunk.toString()));
server.stderr.on("data", (chunk) => serverLog.push(chunk.toString()));
const baseUrl = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();

try {
  await waitForServer(`${baseUrl}/api/v2/health`);
  for (const viewport of viewportMatrix()) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor,
      locale: "en-US",
      timezoneId: "UTC",
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await page.clock.install({ time: new Date("2026-10-14T19:00:00Z") });
    await openVisualNote(page);
    const directory = join(output, viewport.label);
    await mkdir(directory, { recursive: true });
    const metrics = await page.evaluate(() => {
      const editor = document.querySelector(".cm-content");
      const tab = document.querySelector(".tab.active");
      const title = tab?.querySelector("span:first-child");
      if (editor === null) throw new Error("The ready editor is missing");
      if (tab === null || title === null) throw new Error("The ready tab title is missing");
      const style = getComputedStyle(editor);
      const tabBounds = tab.getBoundingClientRect();
      const titleBounds = title.getBoundingClientRect();
      return {
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
        editor: { width: editor.getBoundingClientRect().width, font: style.fontFamily, size: style.fontSize, lineHeight: style.lineHeight, color: style.color },
        tabTitle: { top: titleBounds.top, bottom: titleBounds.bottom, tabTop: tabBounds.top, tabBottom: tabBounds.bottom },
        reducedMotion: getComputedStyle(document.querySelector(".sidebar")).transitionDuration,
      };
    });
    const reducedMotionSeconds = Number.parseFloat(metrics.reducedMotion);
    if (metrics.document.width > metrics.viewport.width || metrics.editor.size !== "17px" || metrics.editor.lineHeight !== "27.2px" ||
      metrics.tabTitle.top < metrics.tabTitle.tabTop || metrics.tabTitle.bottom > metrics.tabTitle.tabBottom ||
      !Number.isFinite(reducedMotionSeconds) || !metrics.reducedMotion.endsWith("s") || reducedMotionSeconds > 0.00001) {
      throw new Error(`Visual layout metrics are outside the review target: ${JSON.stringify(metrics)}`);
    }
    await writeFile(join(directory, "main.json"), JSON.stringify(metrics, null, 2));
    await capture(page, directory, "main");
    await page.keyboard.press("Tab");
    await page.waitForFunction(() => document.activeElement instanceof HTMLElement && document.activeElement.matches(":focus-visible"));
    await capture(page, directory, "focus-visible");
    await page.locator(".cm-content").click({ position: { x: 6, y: 6 } });
    await captureContentVariants(page, directory);
    await captureOverlay(page, directory, "quick-open", async () => {
      await page.keyboard.press("Control+p");
      await page.locator(".quick-open-panel").waitFor();
      await page.locator(".quick-open-panel .command-input").fill("Visual Review");
      await page.locator(".quick-open-results .command-row").first().waitFor();
    });
    await captureOverlay(page, directory, "vault-search", async () => {
      await page.keyboard.press("Control+Shift+f");
      await page.locator(".search-panel").waitFor();
      await page.locator(".search-panel .command-input").fill("comfortable");
      await page.locator(".search-panel .search-result-row").first().waitFor();
    });
    await captureOverlay(page, directory, "note-find", async () => {
      await page.keyboard.press("Control+f");
      await page.locator(".find-panel").waitFor();
      await page.locator(".find-panel .command-input").fill("paragraph");
      await page.locator(".find-panel .command-row").first().waitFor();
    });
    await captureOverlay(page, directory, "command-palette", async () => {
      await page.keyboard.press("Control+k");
      await page.locator(".command-panel").waitFor();
    });
    await captureOverlay(page, directory, "rename", async () => {
      await openCommand(page, "Rename note");
      await page.locator(".note-dialog-panel").waitFor();
    });
    await captureOverlay(page, directory, "revisions", async () => {
      await openCommand(page, "Revisions");
      await page.locator(".revisions-panel").waitFor();
    });
    await captureOverlay(page, directory, "settings", async () => {
      await openCommand(page, "Settings");
      await page.locator(".settings-panel").waitFor();
    });
    await page.keyboard.press("Escape");
    await page.locator(".overlay-host .settings-panel").waitFor({ state: "detached" });
    await page.locator('.note-row[title="visual-review.md"]').click({ button: "right" });
    await page.locator(".context-menu").waitFor();
    await capture(page, directory, "context-menu");
    await page.keyboard.press("Escape");
    await switchVault(page, "Empty");
    await page.locator(".empty-state").waitFor();
    await capture(page, directory, "empty-vault");
    await switchVault(page, "One");
    await page.locator('[title="New note"]').click();
    await page.locator(".note-dialog-panel").waitFor();
    await capture(page, directory, "unnamed-draft");
    await page.keyboard.press("Escape");
    await page.locator(".note-dialog-panel").waitFor({ state: "detached" });
    await capture(page, directory, "local-draft");
    await page.close();
    await context.close();
  }
  for (const viewport of viewportMatrix()) {
    await captureLoadingState(browser, baseUrl, viewport, output);
    await captureFailureState(browser, baseUrl, viewport, output, "unavailable", "failed");
    await captureFailureState(browser, baseUrl, viewport, output, "unresolved", "unresolved");
    await captureSaveState(browser, baseUrl, viewport, output, "failed");
    await captureSaveState(browser, baseUrl, viewport, output, "conflict");
    await captureAuthGate(browser, baseUrl, viewport, output);
    await captureAuthLock(browser, baseUrl, viewport, output);
  }
  process.stdout.write(`Visual review screenshots: ${output}\n`);
} finally {
  await browser.close();
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise((resolveExit) => server.once("exit", resolveExit));
  }
}

async function openVisualNote(page) {
  await page.goto(baseUrl);
  await page.locator(".main").waitFor();
  await page.locator('.note-row[title="visual-review.md"]').click();
  await waitForEditor(page);
  try {
    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll(".cm-content img[data-image-name]")];
      return images.length > 0 && images.every((image) => image.src !== "" && image.complete && image.naturalWidth > 0);
    }, undefined, { timeout: 5_000 });
  } catch (error) {
    const images = await page.locator(".cm-content img[data-image-name]").evaluateAll((items) => items.map((image) => ({ outerHTML: image.outerHTML, src: image.src, complete: image.complete, width: image.naturalWidth })));
    throw new Error(`Visual image readiness failed: ${JSON.stringify(images)}; server: ${serverLog.join("")}`, { cause: error });
  }
  await page.locator(".cm-content img[data-image-name]").evaluateAll(async (images) => {
    await Promise.all(images.map(async (image) => {
      try {
        await image.decode();
      } catch (error) {
        throw new Error(`Image decode failed for ${image.currentSrc}: ${image.naturalWidth}x${image.naturalHeight}`, { cause: error });
      }
    }));
  });
  await page.evaluate(() => {
    document.querySelector(".workspace")?.scrollTo(0, 0);
    document.querySelector(".cm-scroller")?.scrollTo(0, 0);
    window.scrollTo(0, 0);
  });
}

async function waitForEditor(page, heading = "Visual Review") {
  await page.locator("#editor-mount .cm-editor .cm-content").waitFor({ state: "visible" });
  await page.waitForFunction((expected) => document.querySelector("#editor-mount .cm-content")?.textContent?.includes(expected), heading);
}

async function captureContentVariants(page, directory) {
  for (const [name, path, title] of [["long-text", "long-text.md", "Long Text"], ["image-heavy", "image-heavy.md", "Image Heavy"], ["wide-table", "wide-table.md", "Wide Table"], ["long-fence", "long-fence.md", "Long Fence"]]) {
    await page.locator(`.note-row[title="${path}"]`).click();
    await waitForEditor(page, title);
    await page.locator(".workspace").evaluate((element) => element.scrollTo(0, 0));
    if (name === "wide-table") {
      const overflow = await page.locator(".cm-content table").evaluate((table) => ({
        clientWidth: table.clientWidth,
        scrollWidth: table.scrollWidth,
        overflowX: getComputedStyle(table).overflowX,
      }));
      if (overflow.overflowX !== "auto" || overflow.scrollWidth <= overflow.clientWidth) {
        throw new Error(`Wide table has no local horizontal scroll: ${JSON.stringify(overflow)}`);
      }
      await capture(page, directory, "wide-table-left");
      await page.locator(".cm-content table").evaluate((table) => table.scrollTo(table.scrollWidth, 0));
      await capture(page, directory, "wide-table-right");
      continue;
    }
    await capture(page, directory, name);
  }
  await page.locator('.note-row[title="visual-review.md"]').click();
  await waitForEditor(page);
}

async function captureOverlay(page, directory, name, open) {
  await page.evaluate(() => {
    window.__visualEditor = document.querySelector(".cm-editor");
  });
  await open();
  await capture(page, directory, name);
  await page.keyboard.press("Escape");
  await page.locator(".overlay-host").waitFor();
  await page.locator(`.overlay-host .${name === "note-find" ? "find-panel" : name === "vault-search" ? "search-panel" : name === "quick-open" ? "quick-open-panel" : name === "command-palette" ? "command-panel" : name === "rename" ? "note-dialog-panel" : name === "revisions" ? "revisions-panel" : "settings-panel"}`).waitFor({ state: "detached" });
  const mountedEditorRemained = await page.evaluate(() => window.__visualEditor === document.querySelector(".cm-editor"));
  if (!mountedEditorRemained) throw new Error(`${name} remounted the editor`);
}

async function openCommand(page, label) {
  await page.keyboard.press("Control+k");
  await page.locator(".command-panel").waitFor();
  await page.locator(".command-panel .command-row").filter({ hasText: label }).click();
}

async function switchVault(page, name) {
  const control = page.locator(".vault-control");
  await control.click();
  await control.locator(".vault-option").filter({ hasText: name }).click();
  await page.waitForFunction((vaultName) => document.querySelector(".vault-label")?.textContent === vaultName, name);
  await page.waitForTimeout(100);
}

async function captureFailureState(browser, baseUrl, viewport, output, name, failure) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor,
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.clock.install({ time: new Date("2026-10-14T19:00:00Z") });
  const noteRequest = /\/api\/v2\/vaults\/[^/]+\/notes\/[^/]+$/;
  await page.route(noteRequest, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    if (failure === "failed") return route.abort("failed");
    return route.fulfill({
      status: 409,
      contentType: "application/json",
      headers: { "X-Tansu-Api-Version": "2", "X-Tansu-Build-Id": "visual-review" },
      body: JSON.stringify({ error: { code: "unresolved_note", noteId: "visual-review", reason: "corrupt_snapshot" } }),
    });
  });
  await page.goto(baseUrl);
  await page.locator(".main").waitFor();
  await page.locator('.note-row[title="visual-review.md"]').click();
  await page.locator(".unavailable-state").waitFor();
  const directory = join(output, viewport.label);
  await mkdir(directory, { recursive: true });
  await capture(page, directory, name);
  await context.close();
}

async function captureLoadingState(browser, baseUrl, viewport, output) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor,
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.clock.install({ time: new Date("2026-10-14T19:00:00Z") });
  const noteRequest = /\/api\/v2\/vaults\/[^/]+\/notes\/[^/]+$/;
  let releaseRequest;
  let requestStarted;
  const pending = new Promise((resolvePending) => {
    requestStarted = resolvePending;
  });
  const release = new Promise((resolveRelease) => {
    releaseRequest = resolveRelease;
  });
  await page.route(noteRequest, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    requestStarted();
    await release;
    return route.continue();
  });
  await page.goto(baseUrl);
  await page.locator(".main").waitFor();
  await page.locator('.note-row[title="visual-review.md"]').click();
  await pending;
  await page.locator(".workspace .loading").waitFor();
  const directory = join(output, viewport.label);
  await mkdir(directory, { recursive: true });
  await capture(page, directory, "loading");
  releaseRequest();
  await context.close();
}

async function captureSaveState(browser, baseUrl, viewport, output, kind) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor,
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.clock.install({ time: new Date("2026-10-14T19:00:00Z") });
  const noteRequest = /\/api\/v2\/vaults\/[^/]+\/notes\/[^/]+$/;
  let currentDocument;
  let conflictDraft;
  await page.route(noteRequest, async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      const response = await route.fetch();
      currentDocument = await response.json();
      return route.fulfill({ response });
    }
    if (!["PATCH", "PUT"].includes(request.method())) return route.continue();
    if (currentDocument === undefined) throw new Error("Save request arrived before the note document loaded");
    const meta = currentDocument.meta;
    conflictDraft = {
      draftId: 9,
      noteId: meta.noteId,
      baseRevision: meta.revision,
      baseSourceHash: meta.sourceHash,
      sourceHash: `sha256-v2:${"b".repeat(64)}`,
      createdAtMs: 1792004400000,
    };
    const error = kind === "conflict"
      ? { code: "save_conflict", current: currentDocument, draft: conflictDraft }
      : { code: "internal", requestId: "visual-save-failure" };
    return route.fulfill({
      status: kind === "conflict" ? 409 : 500,
      contentType: "application/json",
      headers: { "X-Tansu-Api-Version": "2", "X-Tansu-Build-Id": "visual-review" },
      body: JSON.stringify({ error }),
    });
  });
  await page.route(/\/api\/v2\/vaults\/[^/]+\/notes\/[^/]+\/conflicts\/\d+$/, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "X-Tansu-Api-Version": "2", "X-Tansu-Build-Id": "visual-review" },
    body: JSON.stringify({ draft: conflictDraft, content: "# Rejected local draft\n" }),
  }));
  await page.goto(baseUrl);
  await page.locator(".main").waitFor();
  await page.locator('.note-row[title="visual-review.md"]').click();
  await waitForEditor(page);
  await page.locator(".cm-content").press("Control+End");
  await page.keyboard.insertText("\n\nVisual edit");
  await page.keyboard.press("Control+s");
  await page.waitForResponse((response) => noteRequest.test(response.url()) &&
    ["PATCH", "PUT"].includes(response.request().method()) && response.status() >= 400);
  const directory = join(output, viewport.label);
  await mkdir(directory, { recursive: true });
  if (kind === "conflict") {
    await page.locator(".conflict-banner").waitFor();
    await page.locator('[title="View conflict draft"]').click();
    await page.locator(".overlay-host .revisions-panel").waitFor();
    await capture(page, directory, "conflict-recovery");
  } else {
    await page.locator(".toast").waitFor();
    await capture(page, directory, "save-failed");
  }
  await context.close();
}

async function captureAuthGate(browser, baseUrl, viewport, output) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor,
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.clock.install({ time: new Date("2026-10-14T19:00:00Z") });
  await page.route("**/api/v2/bootstrap", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    headers: { "X-Tansu-Api-Version": "2", "X-Tansu-Build-Id": "visual-review" },
    body: JSON.stringify({ error: { code: "auth_required" } }),
  }));
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto(baseUrl);
  try {
    await page.locator(".auth-gate").waitFor({ timeout: 5_000 });
  } catch (error) {
    throw new Error(`Authentication screen did not render: ${JSON.stringify({ requests, body: await page.locator("body").innerText() })}`, { cause: error });
  }
  const directory = join(output, viewport.label);
  await mkdir(directory, { recursive: true });
  await capture(page, directory, "auth-gate-enrollment");
  await context.close();
}

async function captureAuthLock(browser, baseUrl, viewport, output) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor,
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.clock.install({ time: new Date("2026-10-14T19:00:00Z") });
  const noteRequest = /\/api\/v2\/vaults\/[^/]+\/notes\/[^/]+$/;
  await page.route(noteRequest, (route) => route.request().method() === "GET"
    ? route.fulfill({
      status: 401,
      contentType: "application/json",
      headers: { "X-Tansu-Api-Version": "2", "X-Tansu-Build-Id": "visual-review" },
      body: JSON.stringify({ error: { code: "auth_required" } }),
    })
    : route.continue());
  await page.goto(baseUrl);
  await page.locator(".main").waitFor();
  await page.locator('.note-row[title="visual-review.md"]').click();
  await page.locator(".auth-gate").waitFor();
  const directory = join(output, viewport.label);
  await mkdir(directory, { recursive: true });
  await capture(page, directory, "auth-gate-locked");
  await context.close();
}

async function capture(page, directory, name) {
  await page.screenshot({ path: join(directory, `${name}.png`), fullPage: false });
}

function viewportMatrix() {
  return [1024, 1280, 1440, 1920].flatMap((width) => [
    { label: `${width}`, width, height: 900, deviceScaleFactor: 1 },
    { label: `${width}-200pct`, width: width / 2, height: 450, deviceScaleFactor: 2 },
  ]);
}

async function createReviewAsset(path) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const dataUrl = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 480;
      canvas.height = 320;
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("Canvas 2D context is unavailable");
      const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
      gradient.addColorStop(0, "#d8ded8");
      gradient.addColorStop(0.52, "#93a79a");
      gradient.addColorStop(1, "#486052");
      context.fillStyle = gradient;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "rgba(255, 255, 255, 0.68)";
      for (let column = 0; column < 8; column += 1) {
        context.beginPath();
        context.arc(38 + column * 58, 62 + (column % 2) * 18, 19 + (column % 3) * 7, 0, Math.PI * 2);
        context.fill();
      }
      context.fillStyle = "rgba(24, 44, 34, 0.58)";
      context.fillRect(0, 230, canvas.width, 90);
      context.fillStyle = "#fff";
      context.font = "600 28px system-ui";
      context.fillText("Local asset preview", 24, 282);
      return canvas.toDataURL("image/webp", 0.88);
    });
    if (!dataUrl.startsWith("data:image/webp;base64,")) {
      throw new Error("Chromium did not encode the visual fixture as WebP");
    }
    await writeFile(path, Buffer.from(dataUrl.slice("data:image/webp;base64,".length), "base64"));
  } finally {
    await browser.close();
  }
}

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      listener.close(() => {
        if (address && typeof address === "object") resolvePort(address.port);
        else reject(new Error("no free port"));
      });
    });
  });
}

async function waitForServer(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited: ${serverLog.join("")}`);
    const response = await fetch(url).catch(() => null);
    if (response?.ok) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`server readiness timed out: ${serverLog.join("")}`);
}
