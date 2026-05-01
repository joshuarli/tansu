import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { BrowserContext, Page } from "playwright";

import { setup, teardown } from "./setup.ts";

const ACTIVE_TAB = '[data-ui="tab"][data-active="true"]';
const VAULT_SELECT = '[data-ui="vault-select"]';

type SessionState = {
  tabs: string[];
  active: number;
  closed: string[];
  cursors: Record<string, number>;
};

function writeVaultState(vaultDir: string, state: SessionState): void {
  const tansuDir = join(vaultDir, ".tansu");
  mkdirSync(tansuDir, { recursive: true });
  writeFileSync(join(tansuDir, "state.json"), JSON.stringify(state));
}

async function editorText(page: Page): Promise<string> {
  return page.$eval(".editor-content", (el) => el.textContent ?? "");
}

async function instrumentSse(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const urls: string[] = [];
    (window as unknown as { __tansuSseUrls: string[] }).__tansuSseUrls = urls;
    const Orig = window.EventSource;
    window.EventSource = class extends Orig {
      constructor(url: string | URL, opts?: EventSourceInit) {
        super(url, opts);
        urls.push(String(url));
      }
    };
  });
}

async function waitForSseUrl(page: Page, suffix: string): Promise<void> {
  await page.waitForFunction(
    (expectedSuffix) => {
      const urls = (window as unknown as { __tansuSseUrls?: string[] }).__tansuSseUrls;
      return Array.isArray(urls) && urls.some((url) => url.endsWith(expectedSuffix as string));
    },
    suffix,
    { timeout: 10_000 },
  );
}

async function readSseUrls(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __tansuSseUrls?: string[] }).__tansuSseUrls ?? [],
  );
}

async function readLatestSseUrl(page: Page): Promise<string | null> {
  const urls = await readSseUrls(page);
  return urls.at(-1) ?? null;
}

async function loadApp(page: Page, baseUrl: string): Promise<void> {
  await page.goto(baseUrl);
  await page.waitForSelector("#tab-bar", { timeout: 5_000 });
}

async function switchVault(page: Page, vaultIndex: number): Promise<void> {
  const select = page.locator(VAULT_SELECT);
  await select.waitFor({ timeout: 5_000 });
  const current = await select.inputValue();
  if (current === String(vaultIndex)) {
    return;
  }
  await select.selectOption(String(vaultIndex));
  await expect(select.inputValue()).resolves.toBe(String(vaultIndex));
}

describe("e2e: multi-tab vault isolation", () => {
  let page: Page;
  let context: BrowserContext;
  let baseUrl: string;
  let activeSlot: number;
  let vaultDirs: string[];

  beforeEach(async () => {
    const ctx = await setup();
    ({ page, context, baseUrl, activeSlot, vaultDirs } = ctx);
  }, 30_000);

  afterEach(async () => {
    await teardown();
  });

  it("keeps two tabs isolated across vault-specific navigation and SSE connections", async () => {
    const otherSlot = activeSlot === 0 ? 1 : 0;
    const activePath = `slot-${activeSlot}-only.md`;
    const otherPath = `slot-${otherSlot}-only.md`;
    const activeInitial = `# Vault ${activeSlot}\n\nactive original`;
    const otherInitial = `# Vault ${otherSlot}\n\nother original`;

    writeFileSync(join(vaultDirs[activeSlot]!, activePath), activeInitial);
    writeFileSync(join(vaultDirs[otherSlot]!, otherPath), otherInitial);
    writeVaultState(vaultDirs[activeSlot]!, {
      tabs: [activePath],
      active: 0,
      closed: [],
      cursors: {},
    });
    writeVaultState(vaultDirs[otherSlot]!, {
      tabs: [otherPath],
      active: 0,
      closed: [],
      cursors: {},
    });

    const secondPage = await context.newPage();
    await Promise.all([instrumentSse(page), instrumentSse(secondPage)]);
    await Promise.all([loadApp(page, baseUrl), loadApp(secondPage, baseUrl)]);
    await Promise.all([switchVault(page, activeSlot), switchVault(secondPage, otherSlot)]);
    await Promise.all([
      page.waitForSelector(".editor-content", { timeout: 10_000 }),
      secondPage.waitForSelector(".editor-content", { timeout: 10_000 }),
    ]);

    await expect(editorText(page)).resolves.toContain("active original");
    await expect(editorText(secondPage)).resolves.toContain("other original");
    await expect(page.$eval(ACTIVE_TAB, (el) => el.textContent ?? "")).resolves.toContain(
      `Vault ${activeSlot}`,
    );
    await expect(secondPage.$eval(ACTIVE_TAB, (el) => el.textContent ?? "")).resolves.toContain(
      `Vault ${otherSlot}`,
    );
    await Promise.all([
      waitForSseUrl(page, `/events?vault=${activeSlot}`),
      waitForSseUrl(secondPage, `/events?vault=${otherSlot}`),
    ]);
    await expect(readLatestSseUrl(page)).resolves.toBe(`/events?vault=${activeSlot}`);
    await expect(readLatestSseUrl(secondPage)).resolves.toBe(`/events?vault=${otherSlot}`);

    await secondPage.close();
  }, 30_000);
});
