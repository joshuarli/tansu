import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { chromium, type Browser } from "playwright";

function getFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close((err) => (err ? rej(err) : res(port)));
    });
  });
}

async function waitForServer(url: string, ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server at ${url} did not start within ${ms}ms`);
}

describe("e2e: SSE connection stability", () => {
  let browser: Browser;
  let server: ChildProcess;
  let baseUrl: string;
  let notesDir: string;
  let configDir: string;

  beforeAll(async () => {
    const port = await getFreePort();
    baseUrl = `http://localhost:${port}`;
    notesDir = mkdtempSync(join(tmpdir(), "tansu-sse-"));
    writeFileSync(join(notesDir, "test.md"), "# Hello");
    configDir = mkdtempSync(join(tmpdir(), "tansu-sse-config-"));
    mkdirSync(join(configDir, "tansu"), { recursive: true });
    writeFileSync(
      join(configDir, "tansu", "config.toml"),
      `[vault.test]\ndir = ${JSON.stringify(notesDir)}\n`,
    );

    const binary = resolve("target/debug/tansu");
    server = spawn(binary, ["--port", String(port)], {
      env: { ...process.env, XDG_CONFIG_HOME: configDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stderr?.on("data", () => {});

    await waitForServer(baseUrl, 10_000);
    browser = await chromium.launch({ headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    server?.kill();
    await new Promise<void>((r) => {
      if (!server?.pid) return r();
      server.on("exit", r);
      setTimeout(r, 2000);
    });
    try {
      rmSync(notesDir, { recursive: true });
    } catch {
      /* ignore */
    }
    try {
      rmSync(configDir, { recursive: true });
    } catch {
      /* ignore */
    }
  });

  it("no reconnect loop on normal load", async () => {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      (window as any).__sseConnects = 0;
      const Orig = window.EventSource;
      window.EventSource = class extends Orig {
        constructor(url: string | URL, opts?: EventSourceInit) {
          super(url, opts);
          if (String(url).includes("/events")) (window as any).__sseConnects++;
        }
      };
    });

    await page.goto(baseUrl);
    await page.waitForSelector("#tab-bar", { timeout: 5000 });
    await page.waitForTimeout(3000);

    const count = await page.evaluate(() => (window as any).__sseConnects);
    expect(count).toBeLessThanOrEqual(2);
    await page.close();
  }, 30_000);

  it("no reconnect loop when focus fires during openStore (the race)", async () => {
    const page = await browser.newPage();

    // This test reproduces the infinite reconnect loop that occurs when:
    //   1. A focus event fires while startApp() is suspended at `await openStore()`,
    //      causing connectSSE() to create es_A.
    //   2. openStore() resolves and startApp calls connectSSE() again (unfixed:
    //      unconditional), closing es_A and creating es_B.
    //   3. es_A's stale onerror handler fires and sets module-level `sse = null`,
    //      even though sse now points to es_B.
    //   4. A reconnect timer fires, creating es_C — whose connection causes the server
    //      to drop es_B, triggering es_B's onerror, which sets sse = null again → loop.
    //
    // To make this deterministic in headless mode:
    //   - indexedDB.open onsuccess is delayed 400ms via a Proxy so openStore() is slow.
    //   - A synthetic focus event fires at 50ms, well before openStore resolves.
    //   - When a new EventSource is created while a previous one exists, an artificial
    //     'error' is dispatched on the previous instance after 100ms, directly simulating
    //     the server dropping the old SSE clone when a new connection arrives.
    await page.addInitScript(() => {
      (window as any).__sseConnects = 0;

      // Delay indexedDB.open onsuccess so openStore() takes ~400ms.
      // The Proxy intercepts onsuccess assignment without setting it on the real
      // IDBOpenDBRequest, preventing the native callback from firing immediately.
      // Our success event listener then calls the handler 400ms later.
      const origOpen = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function mockIDBOpen(name: string, version?: number) {
        const realReq = origOpen.call(this, name, version);
        let successHandler: ((ev: Event) => void) | null = null;

        realReq.addEventListener("success", () => {
          setTimeout(() => successHandler?.call(realReq, new Event("success")), 400);
        });

        return new Proxy(realReq, {
          set(target: any, prop: string, value: any) {
            if (prop === "onsuccess") {
              successHandler = value;
              return true; // intentionally NOT forwarded to target
            }
            target[prop] = value;
            return true;
          },
          get(target: any, prop: string) {
            if (prop === "onsuccess") return successHandler;
            const val = target[prop];
            return typeof val === "function" ? val.bind(target) : val;
          },
        });
      };

      // Track EventSource instances and simulate server behavior: when a new
      // connection is created, the server drops the previous SSE clone, which
      // causes that EventSource's onerror to fire.
      let prevInstance: EventSource | null = null;
      const Orig = window.EventSource;
      window.EventSource = class extends Orig {
        constructor(url: string | URL, opts?: EventSourceInit) {
          super(url, opts);
          if (!String(url).includes("/events")) return;
          (window as any).__sseConnects++;
          const prev = prevInstance;
          prevInstance = this;
          if (prev) {
            // Dispatch 'error' on the previous instance as if the server dropped it.
            // In buggy code, that instance's onerror nulls `sse` (now pointing to
            // this new instance), triggering another reconnect and a loop.
            setTimeout(() => prev.dispatchEvent(new Event("error")), 100);
          }
        }
      };

      // Synthetic focus fires at 50ms — before openStore resolves (~400ms).
      setTimeout(() => window.dispatchEvent(new FocusEvent("focus")), 50);
    });

    await page.goto(baseUrl);
    await page.waitForSelector("#tab-bar", { timeout: 15_000 });
    // 4 seconds is enough to observe a loop: 250ms reconnect × 16 iterations.
    await page.waitForTimeout(4000);

    const count = await page.evaluate(() => (window as any).__sseConnects);
    // A loop produces dozens of connections; healthy startup produces at most 2.
    expect(count).toBeLessThanOrEqual(2);

    const notifClass = await page.getAttribute(".notification", "class");
    expect(notifClass).not.toContain("error");
    const serverStatusClass = await page.getAttribute(".server-status", "class");
    expect(serverStatusClass).toContain("hidden");
    await page.close();
  }, 40_000);
});
