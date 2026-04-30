import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { chromium, firefox, type Browser, type BrowserContext, type Page } from "playwright";

type BrowserName = "chromium" | "firefox";

type SetupContext = {
  page: Page;
  baseUrl: string;
  notesDir: string;
};

type ActiveRun = {
  context: BrowserContext;
  page: Page;
  notesDir: string;
  browserName: BrowserName;
};

type SharedState = {
  baseUrl: string;
  configDir: string;
  rootDir: string;
  server: ChildProcess;
  browsers: Partial<Record<BrowserName, Browser>>;
  slotDirs: string[];
  activeSlot: number;
  nextSlot: number;
  firstSetup: boolean;
  activeRun: ActiveRun | null;
};

const STATE_KEY = "__tansuE2eSharedState";
const DEFAULT_NOTES = [
  ["test.md", "# Hello\n\nThis is a test note."],
  ["second.md", "# Second\n\nAnother note."],
  ["linked.md", "# Linked\n\nHas a [[test]] link."],
] as const;

function getSharedState(): SharedState | null {
  return (globalThis as Record<string, unknown>)[STATE_KEY] as SharedState | null;
}

function setSharedState(state: SharedState | null): void {
  (globalThis as Record<string, unknown>)[STATE_KEY] = state;
}

function seedVault(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of DEFAULT_NOTES) {
    writeFileSync(join(dir, name), content);
  }
}

function resetVaultContents(targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(targetDir)) {
    if (entry === ".tansu") {
      const tansuDir = join(targetDir, entry);
      mkdirSync(tansuDir, { recursive: true });
      for (const tansuEntry of readdirSync(tansuDir)) {
        if (tansuEntry === "index") {
          continue;
        }
        rmSync(join(tansuDir, tansuEntry), { recursive: true, force: true });
      }
      continue;
    }
    rmSync(join(targetDir, entry), { recursive: true, force: true });
  }
  seedVault(targetDir);
}

function getFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close((err) => {
        if (err) {
          rej(err);
        } else {
          res(port);
        }
      });
    });
  });
}

async function waitForServer(url: string, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 200) {
        return;
      }
    } catch {
      /* server not ready yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server at ${url} did not start within ${timeoutMs}ms`);
}

async function waitForVaultReady(baseUrl: string, timeoutMs: number): Promise<void> {
  const expected = new Set(DEFAULT_NOTES.map(([name]) => name));
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/api/notes`);
      if (res.ok) {
        const notes = (await res.json()) as Array<{ path: string }>;
        const notePaths = new Set(notes.map((note) => note.path));
        if ([...expected].every((path) => notePaths.has(path))) {
          return;
        }
      }
    } catch {
      /* ignore while vault activates */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Vault at ${baseUrl} did not finish indexing within ${timeoutMs}ms`);
}

async function activateVault(baseUrl: string, index: number): Promise<void> {
  const res = await fetch(`${baseUrl}/api/vaults/${index}/activate`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`Activating vault ${index} failed with ${res.status}`);
  }
}

async function ensureBrowser(state: SharedState, browserName: BrowserName): Promise<Browser> {
  const existing = state.browsers[browserName];
  if (existing) {
    return existing;
  }
  const browser =
    browserName === "firefox"
      ? await firefox.launch({ headless: true })
      : await chromium.launch({ headless: true });
  state.browsers[browserName] = browser;
  return browser;
}

async function ensureSharedState(): Promise<SharedState> {
  const existing = getSharedState();
  if (existing) {
    return existing;
  }

  const port = await getFreePort();
  const rootDir = mkdtempSync(join(tmpdir(), "tansu-e2e-shared-"));
  const configDir = join(rootDir, "config");
  const slotDirs = [join(rootDir, "vault-a"), join(rootDir, "vault-b")];
  for (const slotDir of slotDirs) {
    seedVault(slotDir);
  }

  mkdirSync(join(configDir, "tansu"), { recursive: true });
  writeFileSync(
    join(configDir, "tansu", "config.toml"),
    `[vault.a]\ndir = ${JSON.stringify(slotDirs[0])}\n[vault.b]\ndir = ${JSON.stringify(slotDirs[1])}\n`,
  );

  const server = spawn(resolve("target/debug/tansu"), ["--port", String(port)], {
    env: { ...process.env, XDG_CONFIG_HOME: configDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", () => {});

  const baseUrl = `http://localhost:${port}`;
  await waitForServer(baseUrl, 10_000);
  await waitForVaultReady(baseUrl, 10_000);

  const state: SharedState = {
    baseUrl,
    configDir,
    rootDir,
    server,
    browsers: {},
    slotDirs,
    activeSlot: 0,
    nextSlot: 1,
    firstSetup: true,
    activeRun: null,
  };
  setSharedState(state);
  return state;
}

async function prepareVaultForNextRun(state: SharedState): Promise<string> {
  if (state.firstSetup) {
    state.firstSetup = false;
    return state.slotDirs[state.activeSlot]!;
  }

  const targetSlot = state.nextSlot;
  const targetDir = state.slotDirs[targetSlot]!;
  resetVaultContents(targetDir);
  await activateVault(state.baseUrl, targetSlot);
  await waitForVaultReady(state.baseUrl, 10_000);
  state.activeSlot = targetSlot;
  state.nextSlot = (targetSlot + 1) % state.slotDirs.length;
  return targetDir;
}

export async function setup(opts?: { browserName?: BrowserName }): Promise<SetupContext> {
  const state = await ensureSharedState();
  if (state.activeRun) {
    throw new Error("e2e setup called while a previous run is still active");
  }

  const browserName = opts?.browserName ?? "chromium";
  const notesDir = await prepareVaultForNextRun(state);
  const browser = await ensureBrowser(state, browserName);
  const context = await browser.newContext();
  const page = await context.newPage();

  state.activeRun = {
    context,
    page,
    notesDir,
    browserName,
  };

  return {
    page,
    baseUrl: state.baseUrl,
    notesDir,
  };
}

export async function teardown(): Promise<void> {
  const state = getSharedState();
  const run = state?.activeRun;
  if (!run) {
    return;
  }
  state!.activeRun = null;
  await run.context.close();
}

export async function shutdownSharedState(): Promise<void> {
  const state = getSharedState();
  if (!state) {
    return;
  }

  await teardown();

  for (const browser of Object.values(state.browsers)) {
    await browser?.close();
  }

  state.server.kill();
  await new Promise<void>((done) => {
    if (!state.server.pid) {
      return done();
    }
    state.server.on("exit", done);
    setTimeout(done, 2000);
  });

  try {
    rmSync(state.rootDir, { recursive: true, force: true });
  } catch {
    /* ignore cleanup errors */
  }

  setSharedState(null);
}
