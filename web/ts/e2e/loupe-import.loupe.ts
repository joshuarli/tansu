import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import net from "node:net";
import { join, resolve } from "node:path";

import { chromium, type BrowserContext, type Page, type Worker } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type ChromeApi = {
  storage: {
    local: {
      set(values: Record<string, unknown>): Promise<void>;
    };
  };
  tabs: {
    query(query: Record<string, unknown>): Promise<{ id: number; active: boolean }[]>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
    onActivated: { addListener(listener: (info: { tabId: number }) => void): void };
  };
};

type NoteMeta = { noteId: string; path: string; title: string };
type NoteDocument = { meta: NoteMeta; content: string };

const extensionsDirectory = process.env["LOUPE_EXTENSIONS_DIR"] ?? "";
const articleTitle = "Loupe Import Fixture Article";
const articlePath = "/article";
const importedPathPrefix = "loupe-import-fixture-article";
const oversizeImageBytes = 11 * 1024 * 1024;

let fixtureRoot = "";
let tansuServer: ChildProcess | undefined;
let tansuUrl = "";
let serverInstanceId = "";
let vaultId = "";
let articleServer: Server | undefined;
let articleUrl = "";
let imageBase = "";
let context: BrowserContext | undefined;
let worker: Worker;
const tansuOutput: string[] = [];

describe.skipIf(extensionsDirectory === "")("loupe import into tansu", () => {
  beforeAll(async () => {
    const extensionPath = join(resolve(extensionsDirectory), "build", "extension-loupe");
    if (!existsSync(join(extensionPath, "manifest.json"))) {
      throw new Error(
        `Loupe is not built: ${extensionPath}/manifest.json is missing. Run "pnpm run build" in ${extensionsDirectory}.`,
      );
    }
    if (!existsSync(chromium.executablePath())) {
      throw new Error(`Chromium is not installed: run "deno task playwright:install".`);
    }

    const scratchRoot = join(process.cwd(), ".work", "tmp");
    await mkdir(scratchRoot, { recursive: true });
    fixtureRoot = await mkdtemp(join(scratchRoot, "tansu2-loupe-"));
    const fixture = JSON.parse(
      execFileSync(process.execPath, ["scripts/test-fixture.mjs", fixtureRoot, "--copy-vaults"], {
        cwd: process.cwd(),
        encoding: "utf8",
      }),
    ) as { configHome: string; dataHome: string; vaultOne: string; vaultTwo: string };
    await startTansu(fixture);
    const bootstrap = (await fetch(`${tansuUrl}/api/v2/bootstrap`).then((response) => response.json())) as {
      serverInstanceId: string;
      vaults: { vaultId: string; name: string }[];
    };
    serverInstanceId = bootstrap.serverInstanceId;
    vaultId = bootstrap.vaults.find((vault) => vault.name === "One")?.vaultId ?? "";
    if (vaultId === "") throw new Error("missing seeded vault One");

    context = await chromium.launchPersistentContext(join(fixtureRoot, "chromium-profile"), {
      headless: false,
      args: [
        "--headless=new",
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    const images = await encodeSampleImages(await context.newPage());
    await startArticleServer(images);
    worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 20_000 }));
    await worker.evaluate(async (origin) => {
      const chromeApi = (globalThis as unknown as { chrome: ChromeApi }).chrome;
      await chromeApi.storage.local.set({ tansuOrigin: origin });
    }, tansuUrl);
    await worker.evaluate(() => {
      const scope = globalThis as unknown as { chrome: ChromeApi; activatedTabIds: number[] };
      scope.activatedTabIds = [];
      scope.chrome.tabs.onActivated.addListener(({ tabId }) => scope.activatedTabIds.push(tabId));
    });
  });

  afterAll(async () => {
    await context?.close();
    await new Promise<void>((done) => (articleServer ? articleServer.close(() => done()) : done()));
    await stopTansu();
    if (fixtureRoot !== "") await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("imports through the reader menu without activating the Tansu tab", async () => {
    const article = await openArticle();
    await injectContentScript(article, { action: "toggle" });
    const reader = article.locator('[id^="loupe-reader-host"]');
    await reader.locator(".loupe-reader-menu-toggle").click();
    await reader.locator('[data-action="tansu"]').click();
    await expect
      .poll(() => reader.locator(".loupe-reader-status").textContent(), { timeout: 60_000 })
      .toBe("Imported to Tansu · 2 images · 3 stayed remote");

    const note = await waitForImportedNote();
    expect(note.content).toMatch(/^---\ntitle: "Loupe Import Fixture Article"\n/);
    expect(note.content).toContain(`author: "Ada Lovelace"`);
    expect(note.content).toContain(`url: "${articleUrl}"`);
    expect(note.content).toContain(`domain: "localhost"`);
    expect(note.content).toContain("First paragraph of the fixture article.");
    expect(note.content).toContain("Third paragraph closes the fixture article with");

    const embeds = [...note.content.matchAll(/!\[\[(z-images\/[^\]|]+)(?:\|\d+)?\]\]/gu)].map((match) => match[1]!);
    expect(embeds).toHaveLength(2);
    for (const name of embeds) {
      const asset = await vaultRequest(`/assets?name=${encodeURIComponent(name)}`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toBe("image/webp");
    }
    for (const remote of ["missing.png", "not-an-image.png", "oversize.png"]) {
      expect(note.content).toContain(`](${imageBase}/${remote})`);
    }
    expect(note.content).not.toContain("tansu-import-image:");
    expect(note.content).not.toContain(`${imageBase}/photo.png`);
    expect(note.content).not.toContain(`${imageBase}/photo.jpg`);

    await expectTansuTabInBackground();
    await article.close();
  });

  it("imports through the keyboard command message", async () => {
    const article = await openArticle();
    await injectContentScript(article, { action: "sendPageToTansu" });
    await expect
      .poll(async () => (await listNotes()).filter((note) => note.path.startsWith(importedPathPrefix)).length, {
        timeout: 60_000,
      })
      .toBe(2);
    await expectTansuTabInBackground();
    await article.close();
  });
});

async function openArticle(): Promise<Page> {
  const page = await context!.newPage();
  await page.goto(articleUrl);
  await page.waitForSelector("article");
  await worker.evaluate(() => {
    (globalThis as unknown as { activatedTabIds: number[] }).activatedTabIds = [];
  });
  return page;
}

async function injectContentScript(article: Page, message: { action: string }): Promise<void> {
  await worker.evaluate(
    async ({ url, message }) => {
      const chromeApi = (globalThis as unknown as { chrome: ChromeApi }).chrome;
      const [tab] = await chromeApi.tabs.query({ url });
      if (tab === undefined) throw new Error(`no tab for ${url}`);
      await chromeApi.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      await chromeApi.tabs.sendMessage(tab.id, message);
    },
    { url: article.url(), message },
  );
}

async function expectTansuTabInBackground(): Promise<void> {
  const state = await worker.evaluate(async (origin) => {
    const scope = globalThis as unknown as { chrome: ChromeApi; activatedTabIds: number[] };
    const tabs = await scope.chrome.tabs.query({ url: `${origin}/*` });
    return { tabs, activated: scope.activatedTabIds };
  }, tansuUrl);
  expect(state.tabs).toHaveLength(1);
  expect(state.tabs[0]!.active).toBeFalsy();
  expect(state.activated).not.toContain(state.tabs[0]!.id);
}

async function startTansu(fixture: { configHome: string; dataHome: string; vaultOne: string; vaultTwo: string }) {
  const environment = {
    ...process.env,
    TANSU2_LOGS: "buffer",
    XDG_CONFIG_HOME: fixture.configHome,
    XDG_DATA_HOME: fixture.dataHome,
  };
  const supplied = process.env["TANSU2_E2E_SERVER_BINARY"];
  let binary: string;
  if (supplied === undefined || supplied === "") {
    execFileSync("cargo", ["build", "--quiet", "--bin", "tansu2"], {
      cwd: process.cwd(),
      env: environment,
      stdio: "pipe",
    });
    binary = join(resolve(process.env["CARGO_TARGET_DIR"] ?? "target"), "debug", "tansu2");
  } else {
    binary = resolve(supplied);
  }
  execFileSync(
    binary,
    ["config", "init", "--vault", "One", fixture.vaultOne, "--vault", "Two", fixture.vaultTwo],
    { cwd: process.cwd(), env: environment, stdio: "pipe" },
  );
  const port = await freePort();
  tansuUrl = `http://127.0.0.1:${port}`;
  tansuServer = spawn(binary, ["--port", String(port)], {
    cwd: process.cwd(),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  tansuServer.stdout?.on("data", (chunk: Buffer) => tansuOutput.push(chunk.toString("utf8")));
  tansuServer.stderr?.on("data", (chunk: Buffer) => tansuOutput.push(chunk.toString("utf8")));
  const deadline = Date.now() + 20_000;
  while (!(await fetch(`${tansuUrl}/api/v2/health`).then((response) => response.ok, () => false))) {
    if (Date.now() > deadline) throw new Error(`tansu2 did not become ready\n${tansuOutput.join("")}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

async function stopTansu(): Promise<void> {
  const current = tansuServer;
  if (current === undefined) return;
  tansuServer = undefined;
  const exited = once(current, "exit");
  current.kill("SIGTERM");
  await Promise.race([exited, new Promise((done) => setTimeout(done, 5_000))]);
  if (current.exitCode === null && current.signalCode === null) {
    current.kill("SIGKILL");
    await exited;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      listener.close(() => {
        if (address !== null && typeof address === "object") resolvePort(address.port);
        else reject(new Error("no free port"));
      });
    });
  });
}

async function encodeSampleImages(page: Page): Promise<{ png: Buffer; jpeg: Buffer }> {
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 48;
    const drawing = canvas.getContext("2d")!;
    const gradient = drawing.createLinearGradient(0, 0, 64, 48);
    gradient.addColorStop(0, "#d33");
    gradient.addColorStop(1, "#33d");
    drawing.fillStyle = gradient;
    drawing.fillRect(0, 0, 64, 48);
    const payload = (type: string) => canvas.toDataURL(type).split(",")[1]!;
    return { png: payload("image/png"), jpeg: payload("image/jpeg") };
  });
  await page.close();
  return { png: Buffer.from(encoded.png, "base64"), jpeg: Buffer.from(encoded.jpeg, "base64") };
}

async function startArticleServer(images: { png: Buffer; jpeg: Buffer }): Promise<void> {
  articleServer = createServer((request, response) => {
    const path = request.url ?? "/";
    if (path === articlePath) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(articleHtml());
    } else if (path === "/photo.png") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(images.png);
    } else if (path === "/photo.jpg") {
      response.writeHead(200, { "content-type": "image/jpeg" });
      response.end(images.jpeg);
    } else if (path === "/not-an-image.png") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<p>not an image</p>");
    } else if (path === "/oversize.png") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.alloc(oversizeImageBytes));
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  articleServer.listen(0);
  await once(articleServer, "listening");
  const address = articleServer.address();
  if (address === null || typeof address === "string") throw new Error("article server has no port");
  imageBase = `http://localhost:${address.port}`;
  articleUrl = `${imageBase}${articlePath}`;
}

function articleHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${articleTitle}</title>
<meta name="author" content="Ada Lovelace">
<meta name="description" content="A fixture article for the Loupe import test.">
</head><body><main><article>
<h1>${articleTitle}</h1>
<p>First paragraph of the fixture article. It carries enough prose for the extractor to treat this page as the main article rather than navigation or boilerplate around it.</p>
<p><img src="${imageBase}/photo.png" alt="valid png"></p>
<p>Second paragraph of the fixture article. It sits between the images and says a few more things about nothing in particular so the content stays substantial.</p>
<p><img src="${imageBase}/photo.jpg" alt="valid jpeg"></p>
<p><img src="${imageBase}/missing.png" alt="missing image"></p>
<p><img src="${imageBase}/not-an-image.png" alt="wrong content type"></p>
<p><img src="${imageBase}/oversize.png" alt="oversize image"></p>
<p>Third paragraph closes the fixture article with one last run of ordinary sentences, enough to keep the extractor confident about where the article ends.</p>
</article></main></body></html>`;
}

function vaultRequest(path: string): Promise<Response> {
  return fetch(`${tansuUrl}/api/v2/vaults/${encodeURIComponent(vaultId)}${path}`, {
    headers: { "X-Tansu-Server-Instance": serverInstanceId },
  });
}

async function listNotes(): Promise<NoteMeta[]> {
  const bootstrap = (await vaultRequest("/bootstrap").then((response) => response.json())) as { notes: NoteMeta[] };
  return bootstrap.notes;
}

async function waitForImportedNote(): Promise<NoteDocument> {
  let found: NoteMeta | undefined;
  await expect
    .poll(async () => {
      found = (await listNotes()).find((note) => note.path.startsWith(importedPathPrefix));
      return found !== undefined;
    }, { timeout: 30_000 })
    .toBe(true);
  return vaultRequest(`/notes/${encodeURIComponent(found!.noteId)}`).then(
    (response) => response.json() as Promise<NoteDocument>,
  );
}
