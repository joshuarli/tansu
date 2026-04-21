/// E2E test setup: launches Tansu server + headless Chromium.
/// Shares a single browser instance across all e2e tests.

import { spawn, spawnSync, type ChildProcess } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";

import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let server: ChildProcess;
let notesDir: string;
let baseUrl: string;

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

export async function setup(): Promise<{ page: Page; baseUrl: string; notesDir: string }> {
  const activePort = await getFreePort();
  // Build frontend
  const build = spawnSync(
    "./node_modules/.bin/esbuild",
    ["web/ts/main.ts", "--bundle", "--outfile=web/static/app.js", "--minify", "--format=esm"],
    { stdio: "inherit" },
  );
  if (build.status !== 0) throw new Error("Frontend build failed");

  // Create temp notes dir with test notes
  notesDir = mkdtempSync(join(tmpdir(), "tansu-e2e-"));
  writeFileSync(join(notesDir, "test.md"), "# Hello\n\nThis is a test note.");
  writeFileSync(join(notesDir, "second.md"), "# Second\n\nAnother note.");
  writeFileSync(join(notesDir, "linked.md"), "# Linked\n\nHas a [[test]] link.");

  // Start server
  server = spawn("cargo", ["run", "--bin", "tansu", "--", notesDir, "--port", String(activePort)], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Wait for server to be ready
  await waitForServer(`http://localhost:${activePort}`, 10_000);
  baseUrl = `http://localhost:${activePort}`;

  // Launch browser
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  return { page, baseUrl, notesDir };
}

export async function teardown() {
  if (browser) await browser.close();
  if (server) {
    server.kill();
    // Wait for process to exit
    await new Promise<void>((resolve) => {
      if (!server.pid) return resolve();
      server.on("exit", resolve);
      setTimeout(resolve, 2000);
    });
  }
  if (notesDir) {
    try {
      rmSync(notesDir, { recursive: true });
    } catch {}
  }
}

async function waitForServer(url: string, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server at ${url} did not start within ${timeoutMs}ms`);
}
