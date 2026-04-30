import type { Page } from "playwright";

import { setup, teardown } from "./setup.ts";

describe("e2e: SSE connection stability", () => {
  let page: Page;
  let baseUrl: string;

  beforeEach(async () => {
    const ctx = await setup();
    ({ page, baseUrl } = ctx);
  }, 30_000);

  afterEach(async () => {
    await teardown();
  });

  it("no reconnect loop on normal load", async () => {
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
  }, 30_000);

  it("no reconnect loop when focus fires during openStore (the race)", async () => {
    await page.addInitScript(() => {
      (window as any).__sseConnects = 0;

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
              return true;
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
            setTimeout(() => prev.dispatchEvent(new Event("error")), 100);
          }
        }
      };

      setTimeout(() => window.dispatchEvent(new FocusEvent("focus")), 50);
    });

    await page.goto(baseUrl);
    await page.waitForSelector("#tab-bar", { timeout: 15_000 });
    await page.waitForTimeout(4000);

    const count = await page.evaluate(() => (window as any).__sseConnects);
    expect(count).toBeLessThanOrEqual(2);

    const notifClass = await page.getAttribute(".notification", "class");
    expect(notifClass).not.toContain("error");
    const serverStatusClass = await page.getAttribute(".server-status", "class");
    expect(serverStatusClass).toContain("hidden");
  }, 40_000);
});
