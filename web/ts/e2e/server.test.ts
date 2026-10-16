import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { join, resolve } from "node:path";

import {
  chromium,
  webkit,
  type Browser,
  type BrowserType,
  type Page,
  type Route,
  type Response as PlaywrightResponse,
} from "playwright";
import { expect, afterAll, beforeEach, describe, beforeAll, it } from "vitest";

import { canonicalSourceHash } from "../source-hash.ts";
import type { V2ServerEvent } from "../types.generated.ts";

let server: ChildProcess | undefined;
let browser: Browser | undefined;
let baseUrl = "";
let vaultOnePath = "";
let fixture: TestFixture | undefined;
let fixtureRoot: string | undefined;
let serverPort = 0;
let serverInstanceId = "";
let vaultOneId = "";
let vaultTwoId = "";
let serverBinaryBuilt = false;
let serverBinaryPath = "";
let serverArtifactHash = "";
let settingsSeeded = false;
const serverOutput: string[] = [];
const e2eBrowser = browserTypeFromEnv();

type TestFixture = {
  configHome: string;
  dataHome: string;
  vaultOne: string;
  vaultTwo: string;
};

type TestNoteMeta = {
  noteId: string;
  path: string;
  title: string;
  revision: number;
  sourceHash: string;
  diskHash: string;
};

type TestNoteDocument = {
  meta: TestNoteMeta;
  content: string;
};

type LogEvent = {
  seq: number;
  ts: number;
  source: string;
  level: string;
  kind: string;
  requestId?: string;
} & Record<string, unknown>;

describe("real server harness", () => {
  beforeAll(async () => {
    const scratchRoot = join(process.cwd(), ".work", "tmp");
    await mkdir(scratchRoot, { recursive: true });
    const root = await mkdtemp(join(scratchRoot, "tansu2-e2e-"));
    fixtureRoot = root;
    fixture = JSON.parse(
      execFileSync(process.execPath, ["scripts/test-fixture.mjs", root, "--copy-vaults"], {
        cwd: process.cwd(),
        encoding: "utf8",
      }),
    ) as TestFixture;
    vaultOnePath = fixture.vaultOne;
    serverPort = await freePort();
    baseUrl = `http://127.0.0.1:${serverPort}`;
    await startFixtureServer();
    const bootstrap = await fetch(`${baseUrl}/api/v2/bootstrap`).then((response) => response.json()) as {
      serverInstanceId: string;
      vaults: { vaultId: string; name: string }[];
    };
    serverInstanceId = bootstrap.serverInstanceId;
    vaultOneId = bootstrap.vaults.find((vault) => vault.name === "One")?.vaultId ?? "";
    vaultTwoId = bootstrap.vaults.find((vault) => vault.name === "Two")?.vaultId ?? "";
    if (vaultOneId === "") throw new Error("missing seeded vault One");
    if (vaultTwoId === "") throw new Error("missing seeded vault Two");
    browser = await e2eBrowser.launch();
  });

  beforeEach((context) => {
    context.onTestFailed(async () => {
      await dumpUnifiedLogs(context.task.name);
    }, 10_000);
  });

  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      try {
        await stopFixtureServer();
        if (serverArtifactHash !== "" && artifactHash(serverBinaryPath) !== serverArtifactHash) {
          throw new Error(`server artifact changed while the suite ran: ${serverBinaryPath}`);
        }
      } finally {
        if (fixtureRoot !== undefined) {
          await rm(fixtureRoot, { recursive: true, force: true });
        }
      }
    }
  });

  it("starts with two seeded vaults and loads the static app", async () => {
    const globalBootstrap = await fetch(`${baseUrl}/api/v2/bootstrap`).then((response) => response.json());
    const bootstrap = await v2Request(vaultTwoId, "/bootstrap").then((response) => response.json());
    expect(globalBootstrap.vaults).toHaveLength(2);
    expect(bootstrap.vault.name).toBe("Two");
    expect(bootstrap.notes[0].title).toBe("Two");
    const vaultOneBootstrap = await v2Request(vaultOneId, "/bootstrap")
      .then((response) => response.json() as Promise<{ notes: TestNoteMeta[] }>);
    const notesByPath = new Map(vaultOneBootstrap.notes.map((note) => [note.path, note]));
    expect([...notesByPath.keys()]).toStrictEqual(
      expect.arrayContaining(["one.md", "search.md", "visual.md"]),
    );
    const seededDocuments = new Map<string, string>();
    for (const path of ["one.md", "search.md", "visual.md"]) {
      const note = notesByPath.get(path);
      if (note === undefined) {
        throw new Error(`missing seeded note: ${path}`);
      }
      const document = await v2Request(vaultOneId, `/notes/${encodeURIComponent(note.noteId)}`)
        .then((response) => response.json() as Promise<TestNoteDocument>);
      seededDocuments.set(note.path, document.content);
    }
    expect(new Set(seededDocuments.values()).size).toBe(3);
    expect(seededDocuments.get("one.md")).toContain("# One");
    expect(seededDocuments.get("search.md")).toContain("# Search Fixture");
    expect(seededDocuments.get("visual.md")).toContain("![[z-images/sample.webp|132]]");
    const sample = await v2Request(vaultOneId, `/assets?name=${encodeURIComponent("z-images/sample.webp")}`);
    expect(sample.ok).toBeTruthy();
    expect((await sample.arrayBuffer()).byteLength).toBeGreaterThan(0);

    const page = await newLoggedPage();
    const startupRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/v2/")) {
        startupRequests.push(`${request.method()} ${url.pathname}${url.search}`);
      }
    });
    const bootstrapRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return request.method() === "GET" && url.pathname === "/api/v2/bootstrap";
    });
    await page.goto(baseUrl);
    await page.waitForSelector(".main");
    await expect.poll(() => page.locator(".vault-label").isVisible()).toBe(true);
    await page.keyboard.press("Control+/");
    await expect.poll(() => page.locator(".recent-search-result").first().isVisible()).toBe(true);
    await bootstrapRequest;
    expect(startupRequests[0]).toBe("GET /api/v2/bootstrap");
    expect(startupRequests.some((request) => request.includes(`/vaults/${vaultOneId}/events?after=`))).toBeTruthy();
    expect(
      startupRequests.filter((request) => request.startsWith(`GET /api/v2/vaults/${vaultOneId}/notes/`)).length,
    ).toBeLessThanOrEqual(3);
    await page.locator('.recent-search-result[title="one.md"]').click();
    await expect.poll(() => page.locator("#editor-mount .cm-content").textContent()).not.toBe("");
    await openSearchNote(page, "visual");
    await page.waitForSelector('.cm-content .cm-atomic-image[data-image-name="z-images/sample.webp"] img');
    await page.waitForFunction(() => {
      const image = document.querySelector<HTMLImageElement>("#editor-mount .cm-atomic-image img");
      return image?.complete === true && image.naturalWidth > 0;
    });
    await page.close();
  });

  it("shows a clickable pill when hovering a rendered link in live mode", async () => {
    const page = await newLoggedPage();
    await page.setViewportSize({ width: 600, height: 900 });
    await page.addInitScript(() => {
      if (window.sessionStorage.getItem("tansu2-e2e-theme-reset") !== "done") {
        window.localStorage.removeItem("tansu2.theme.v1");
        window.sessionStorage.setItem("tansu2-e2e-theme-reset", "done");
      }
      window.open = (url) => {
        document.documentElement.dataset["openedLink"] = String(url);
        return null;
      };
    });
    await page.goto(baseUrl);
    await page.waitForSelector(".main");
    await createCodeMirrorNote(page, "Link Hover");
    const saved = page.waitForResponse((response) =>
      response.request().method() === "PUT" && response.status() === 200
    );
    await page.locator("#editor-mount .cm-content").fill(
      "# Link Hover\n\nOpen [the destination label wraps across several visible line fragments in this narrow article column](https://example.test/article).",
    );
    await page.keyboard.press(`${shortcutModifier()}+s`);
    await saved;

    const link = page.locator("#editor-mount .cm-atomic-link");
    await expect.poll(() => link.isVisible()).toBeTruthy();
    const fragments = await link.evaluate((element) =>
      Array.from(element.getClientRects(), ({ x, y, width, height }) => ({ x, y, width, height }))
    );
    expect(fragments.length).toBeGreaterThan(1);
    const hoverFragment = fragments[fragments.length - 1]!;
    const hoverX = hoverFragment.x + Math.min(4, hoverFragment.width / 2);
    const hoverY = hoverFragment.y + hoverFragment.height / 2;
    await page.mouse.move(hoverX, hoverY);
    const pill = page.locator(".article-link-pill");
    await expect.poll(() => pill.isVisible()).toBeTruthy();
    const pillBox = await pill.boundingBox();
    if (pillBox === null) throw new Error("link pill has no visible bounds");
    const expectedLeft = await page.evaluate(({ x, width }) =>
      Math.max(8, Math.min(x, window.innerWidth - width - 8)),
    { x: hoverFragment.x, width: pillBox.width });
    expect(pillBox.x).toBeCloseTo(expectedLeft, 0);
    expect(pillBox.y).toBeCloseTo(hoverFragment.y + hoverFragment.height + 6, 0);
    await pill.hover();
    await expect.poll(() => pill.isVisible()).toBeTruthy();
    await page.mouse.move(10, 10);
    await expect.poll(() => pill.count()).toBe(0);
    await page.mouse.move(hoverX, hoverY);
    await expect.poll(() => pill.isVisible()).toBeTruthy();
    await pill.hover();
    await pill.click();
    await expect.poll(() => page.locator("html").getAttribute("data-opened-link"))
      .toBe("https://example.test/article");

    await runPaletteCommand(page, "reading");
    const readOnlyFragment = await link.evaluate((element) => {
      const rect = element.getClientRects()[0];
      return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    if (readOnlyFragment === null) throw new Error("read-only link has no visible bounds");
    await page.mouse.move(readOnlyFragment.x + 3, readOnlyFragment.y + readOnlyFragment.height / 2);
    await expect.poll(() => pill.count()).toBe(0);
    await page.locator("html").evaluate((element) => element.removeAttribute("data-opened-link"));
    await page.mouse.click(readOnlyFragment.x + 3, readOnlyFragment.y + readOnlyFragment.height / 2);
    await expect.poll(() => page.locator("html").getAttribute("data-opened-link"))
      .toBe("https://example.test/article");

    const readingToggle = page.locator(".reading-mode-toggle");
    await readingToggle.click();
    await expect.poll(() => page.locator(".main").getAttribute("class"))
      .not.toContain("reading-mode");
    await readingToggle.click();
    await expect.poll(() => page.locator(".main").getAttribute("class"))
      .toContain("reading-mode");

    const themeToggle = page.locator(".theme-toggle");
    await themeToggle.click();
    await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("dark");
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor))
      .toBe("rgb(25, 26, 28)");
    await page.reload();
    await page.waitForSelector(".main");
    await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("dark");
    await page.locator(".theme-toggle").click();
    await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("light");
    await page.close();
  });

  it("highlights the active outline heading as the reader scrolls", async () => {
    const page = await newLoggedPage();
    await page.goto(baseUrl);
    await page.waitForSelector(".main");
    await openSearchNote(page, "Visual Check");

    const firstHeading = page.locator(".outline-row").filter({ hasText: "Visual Check" });
    const secondHeading = page.locator(".outline-row").filter({ hasText: "Second Section" });
    await expect.poll(() => firstHeading.getAttribute("aria-current")).toBe("location");
    const outlineBox = await page.locator(".note-outline").boundingBox();
    const workspaceBox = await page.locator(".workspace").boundingBox();
    if (outlineBox === null || workspaceBox === null) throw new Error("outline layout is not visible");
    expect(outlineBox.x + outlineBox.width).toBeLessThan(workspaceBox.x);

    await page.locator("#editor-mount .cm-scroller").evaluate((scroller) => {
      scroller.scrollTop = scroller.scrollHeight;
    });
    await expect.poll(() => secondHeading.getAttribute("aria-current")).toBe("location");
    await page.close();
  });

  it("keeps modal and article rail geometry stable", async () => {
    const page = await newLoggedPage();
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(baseUrl);
    await page.waitForSelector(".main");

    await page.keyboard.press("Control+/");
    const searchPanel = page.locator(".search-panel");
    await searchPanel.waitFor({ state: "visible" });
    const modalStyle = (panel: typeof searchPanel) =>
      panel.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          backdropFilter: style.backdropFilter,
          backgroundColor: style.backgroundColor,
          borderRadius: style.borderRadius,
          boxShadow: style.boxShadow,
          display: style.display,
          flexDirection: style.flexDirection,
          left: style.left,
          maxHeight: style.maxHeight,
          overflow: style.overflow,
          padding: style.padding,
          top: style.top,
          transform: style.transform,
          width: style.width,
        };
      });
    const searchStyle = await modalStyle(searchPanel);
    await page.keyboard.press("Escape");
    await searchPanel.waitFor({ state: "detached" });

    await runPaletteCommand(page, "create");
    const createPanel = page.locator(".note-dialog-panel.is-create");
    await createPanel.waitFor({ state: "visible" });
    await expect(modalStyle(createPanel)).resolves.toStrictEqual(searchStyle);
    await page.keyboard.press("Escape");
    await createPanel.waitFor({ state: "detached" });

    await createCodeMirrorNote(page, "Plain Article");
    const plainSave = page.waitForResponse((response) =>
      response.request().method() === "PUT" && response.status() === 200
    );
    await page.locator("#editor-mount .cm-content").fill("# Plain Article\n\nA body without a margin note.");
    await page.keyboard.press(`${shortcutModifier()}+s`);
    await plainSave;
    const article = page.locator(".editor-mount .cm-content");
    await expect.poll(() => article.isVisible()).toBe(true);
    const articleWidthWithoutNotes = (await article.boundingBox())?.width;
    if (articleWidthWithoutNotes === undefined) throw new Error("article body is not visible");

    await createCodeMirrorNote(page, "Article with Margin Note");
    const sidenoteSave = page.waitForResponse((response) =>
      response.request().method() === "PUT" && response.status() === 200
    );
    await page.locator("#editor-mount .cm-content").fill(
      "# Article with Margin Note\n\nA sentence with a margin note.[^margin]\n\n[^margin]: A note kept in the right margin.",
    );
    await page.keyboard.press(`${shortcutModifier()}+s`);
    await sidenoteSave;
    const marginNote = page.locator(".tansu-sidenote-card");
    await expect.poll(() => marginNote.isVisible()).toBe(true);
    const containingEditorClass = await marginNote.evaluate((note) => note.closest(".cm-editor")?.className);
    expect(containingEditorClass).toContain("tansu-has-sidenotes");
    const railGeometry = await page.evaluate(() => {
      const outline = document.querySelector<HTMLElement>(".note-outline");
      const workspace = document.querySelector<HTMLElement>(".workspace");
      const articleBody = document.querySelector<HTMLElement>(".editor-mount .cm-content");
      const sidenote = document.querySelector<HTMLElement>(".tansu-sidenote-card");
      if (outline === null || workspace === null || articleBody === null || sidenote === null) return null;
      const outlineBox = outline.getBoundingClientRect();
      const workspaceBox = workspace.getBoundingClientRect();
      const articleBox = articleBody.getBoundingClientRect();
      const sidenoteBox = sidenote.getBoundingClientRect();
      return {
        articleRight: articleBox.right,
        articleWidth: articleBox.width,
        outlineRight: outlineBox.right,
        outlineTransform: getComputedStyle(outline).transform,
        sidenoteLeft: sidenoteBox.left,
        sidenotePosition: getComputedStyle(sidenote).position,
        sidenoteRight: sidenoteBox.right,
        workspaceLeft: workspaceBox.left,
        workspaceRight: workspaceBox.right,
        workspaceTransform: getComputedStyle(workspace).transform,
      };
    });
    expect(railGeometry).not.toBeNull();
    if (railGeometry === null) throw new Error("article rails are not visible");
    expect(railGeometry.outlineTransform).toBe("matrix(1, 0, 0, 1, -100, 0)");
    expect(railGeometry.workspaceTransform).toBe("matrix(1, 0, 0, 1, -50, 50)");
    expect(railGeometry.outlineRight).toBeLessThan(railGeometry.workspaceLeft);
    expect(railGeometry.sidenotePosition).toBe("absolute");
    expect(railGeometry.sidenoteLeft).toBeGreaterThan(railGeometry.articleRight);
    expect(railGeometry.articleWidth).toBe(articleWidthWithoutNotes);
    expect(railGeometry.sidenoteRight).toBeLessThan(railGeometry.workspaceRight);

    for (const width of [1280, 1366]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => marginNote.evaluate((element) => getComputedStyle(element).position)).toBe("absolute");
      const narrow = await page.evaluate(() => {
        const box = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
        return { outline: box(".note-outline"), article: box(".editor-mount .cm-content"), note: box(".tansu-sidenote-card"), workspace: box(".workspace") };
      });
      expect(narrow.outline.left).toBeGreaterThanOrEqual(0);
      expect(narrow.outline.right).toBeLessThan(narrow.article.left);
      expect(narrow.note.left).toBeGreaterThan(narrow.article.right);
      expect(narrow.note.right).toBeLessThan(narrow.workspace.right);
      expect(narrow.note.right).toBeLessThanOrEqual(width);
    }
    await page.setViewportSize({ width: 1100, height: 900 });
    await expect.poll(() => marginNote.evaluate((element) => getComputedStyle(element).position))
      .toBe("static");
    await page.close();
  });

  it("folds frontmatter until revealed and places clicks on the selected line", async () => {
    const page = await newLoggedPage();
    await page.goto(baseUrl);
    await page.waitForSelector(".main");
    await createCodeMirrorNote(page, "Frontmatter Layout");
    const source = ["---", "tags:", "  - alpha", "---", "", "# Body", ""].join("\n");
    const save = page.waitForResponse((response) =>
      response.request().method() === "PUT" && response.url().includes("/notes/") && response.status() === 200
    );
    await page.locator("#editor-mount .cm-content").fill(source);
    await page.keyboard.press(`${shortcutModifier()}+s`);
    await save;

    const content = page.locator("#editor-mount .cm-content");
    const disclosure = page.locator("#editor-mount .tag-frontmatter-toggle");
    await expect.poll(() =>
      page.locator("#editor-mount .cm-scroller").evaluate((scroller) => getComputedStyle(scroller).scrollbarWidth)
    ).toBe("none");
    await expect.poll(() => disclosure.isVisible()).toBe(true);
    await expect.poll(() => disclosure.getAttribute("aria-expanded")).toBe("true");
    await disclosure.click();
    await expect.poll(() => content.textContent()).not.toContain("tags:");
    await expect.poll(() => disclosure.getAttribute("aria-expanded")).toBe("false");
    await disclosure.click();
    await expect.poll(() => content.textContent()).toContain("tags:");
    const metadataLine = page.locator("#editor-mount .cm-line.cm-frontmatter-line").filter({ hasText: "tags:" });
    const lineBox = await metadataLine.boundingBox();
    if (lineBox === null) throw new Error("frontmatter line is not visible after reveal");
    await page.mouse.click(lineBox.x + 24, lineBox.y + lineBox.height / 2);
    await expect.poll(() => page.locator("#editor-mount .cm-line.cm-activeLine").textContent()).toContain("tags:");
    await expect.poll(async () => {
      const caret = await page.locator("#editor-mount .cm-cursor").first().boundingBox();
      return caret !== null && caret.y >= lineBox.y && caret.y + caret.height <= lineBox.y + lineBox.height;
    }).toBe(true);
    const caretBox = await page.locator("#editor-mount .cm-cursor").first().boundingBox();
    if (caretBox === null) throw new Error("editor caret is not visible after click");
    expect(caretBox.y).toBeGreaterThanOrEqual(lineBox.y);
    expect(caretBox.y + caretBox.height).toBeLessThanOrEqual(lineBox.y + lineBox.height);
    await page.close();
  });

  it("locks in command, search, and note management UX", async () => {
    const page = await newLoggedPage();
    page.on("dialog", (dialog) => {
      throw new Error(`unexpected native dialog: ${dialog.type()} ${dialog.message()}`);
    });
    await page.goto(baseUrl);
    await page.waitForSelector(".main");
    await page.keyboard.press("Control+/");
    await page.waitForSelector(".search-panel .command-input");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".search-panel", { state: "detached" });
    await page.keyboard.press(`${shortcutModifier()}+k`);
    await page.waitForSelector(".command-panel .command-input");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".command-panel", { state: "detached" });
    await openSearchNote(page, "One");
    await expect(page.locator(".workspace > .toolbar").count()).resolves.toBe(0);
    await expect(page.locator(".selection-toolbar").count()).resolves.toBe(1);
    await expect(page.locator(".selection-toolbar").isVisible()).resolves.toBeTruthy();
    await expect(page.locator(".section-title", { hasText: "Notes" }).count()).resolves.toBe(0);
    await expect(page.locator(".sidebar").count()).resolves.toBe(0);
    await expect(
      page.evaluate(() => getComputedStyle(document.querySelector(".tabs")!).scrollbarWidth),
    ).resolves.toBe("none");

    await runPaletteCommand(page, "create");
    await page.waitForSelector(".note-dialog-panel");
    await page.locator(".overlay-backdrop").click({ position: { x: 4, y: 4 } });
    await page.waitForSelector(".note-dialog-panel", { state: "detached" });

    await runPaletteCommand(page, "create");
    await page.locator(".note-dialog-panel input").fill("Meeting Notes");
    await page.locator(".note-dialog-panel input").press("Enter");
    await page.waitForFunction(() =>
      document.querySelector(".tab.active")?.textContent?.includes("Meeting Notes"),
    );

    await page.locator(".tab.active").click({ button: "right" });
    await page.waitForSelector(".context-menu");
    const menuText = await page.locator(".context-menu").textContent();
    expect(menuText).toContain("Rename");
    expect(menuText).toContain("Pin");
    expect(menuText).toContain("Delete");

    await page.locator(".context-menu", { hasText: "Pin" }).getByText("Pin").click();
    await page.waitForSelector(".context-menu", { state: "detached" });
    await expect.poll(() => page.locator(".tab.active .tab-pinned").count()).toBe(1);

    await page.locator(".tab.active").click({ button: "right" });
    await page.locator(".context-menu", { hasText: "Rename" }).getByText("Rename").click();
    await page.locator(".note-dialog-panel input").fill("Renamed Note");
    const renameResponse = page.waitForResponse(
      (response) => response.url().includes("/rename") && response.status() === 200,
    );
    await page.locator(".note-dialog-panel .primary-button").click();
    await renameResponse;
    await page.waitForSelector(".note-dialog-panel", { state: "detached" });

    await page.locator(".tab.active").click({ button: "right" });
    await page.locator(".context-menu", { hasText: "Delete" }).getByText("Delete").click();
    await page.waitForFunction(() =>
      document.querySelector(".note-dialog-panel")?.textContent?.includes("renamed-note.md"),
    );
    await page.locator(".note-dialog-panel .danger-button").click();
    await page.waitForSelector(".note-dialog-panel", { state: "detached", timeout: 5_000 });
    const afterDelete = await v2Request(vaultOneId, "/bootstrap").then((response) => response.json());
    expect(
      afterDelete.notes.some((note: { path: string }) => note.path === "renamed-note.md"),
    ).toBeFalsy();
    await page.close();
  });

  it("keeps note bodies isolated when switching notes before saving", async () => {
    const page = await newLoggedPage();
    await page.goto(baseUrl);
    await page.waitForSelector(".main");
    const searchBefore = await openSeededDocument("search.md");

    await openSearchNote(page, "One");
    await page.waitForFunction(() =>
      document.querySelector(".cm-content")?.textContent?.includes("alpha") === true,
    );
    await page.locator(".cm-content").fill("# One\n\nalpha edited in One\n");

    await openSearchNote(page, "Search Fixture");
    await page.waitForFunction(() =>
      document.querySelector(".cm-content")?.textContent?.includes("Search Fixture") === true,
    );
    await page.keyboard.press(`${shortcutModifier()}+s`);

    const searchAfter = await openSeededDocument("search.md");
    expect(searchAfter.content).toBe(searchBefore.content);
    expect(searchAfter.content).toContain("# Search Fixture");
    expect(searchAfter.content).not.toContain("alpha edited in One");
    await expectSavedContent("one.md", "# One\n\nalpha edited in One\n");
    await page.close();
  });

  it("keeps large-note keyboard edits and V2 saves intact", async () => {
    const page = await newLoggedPage();
    await page.goto(baseUrl);
    await page.waitForSelector(".main");
    await createCodeMirrorNote(page, "Large Note Editing");

    const source = `# Large Note Editing\n\n${Array.from(
      { length: 500 },
      (_, index) => `paragraph ${index} with enough text to exercise a large document`,
    ).join("\n")}`;
    const initialSave = page.waitForResponse((response) =>
      response.request().method() === "PUT" && response.status() === 200
    );
    await page.locator(".cm-content").fill(source);
    await page.keyboard.press(`${shortcutModifier()}+s`);
    await initialSave;

    const edit = " latency-free-editing-regression-check";
    const editedSave = page.waitForResponse((response) =>
      response.request().method() === "PUT" && response.status() === 200
    );
    await page.keyboard.type(edit);
    await expect.poll(() => page.locator(".cm-content").textContent()).toContain(
      `paragraph 499 with enough text to exercise a large document${edit}`,
    );
    await page.keyboard.press(`${shortcutModifier()}+s`);
    await editedSave;
    await expectSavedContent("large-note-editing.md", `${source}${edit}`);
    await page.close();
  });

  it("streams vault-scoped note changes over SSE", async () => {
    const page = await newLoggedPage();
    await page.goto(baseUrl);
    const title = `SSE ${randomUUID()}`;
    const pathMarker = title.slice(4).toLowerCase();
    await page.evaluate(async (args) => {
      const eventPromise = (async () => {
        let cursor = 0;
        while (true) {
          const response = await fetch(`/api/v2/vaults/${args.vaultId}/events?after=${cursor}`, {
            headers: { "X-Tansu-Server-Instance": args.serverInstanceId },
          });
          if (!response.ok || response.body === null) throw new Error(`event stream failed: ${response.status}`);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let resync = false;
          while (true) {
            const result = await reader.read();
            if (result.done) {
              if (resync) break;
              throw new Error("event stream closed before note change");
            }
            buffer += decoder.decode(result.value, { stream: true });
            const frames = buffer.split("\n\n");
            buffer = frames.pop() ?? "";
            for (const frame of frames) {
              const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
              if (!data) continue;
              const event = JSON.parse(data) as {
                eventVersion: number;
                resyncRequired: boolean;
                update: { kind: string; note?: { path: string } };
              };
              if (event.resyncRequired) {
                cursor = event.eventVersion;
                resync = true;
                await reader.cancel();
                break;
              }
              if (event.update.kind === "noteChanged" && event.update.note?.path.includes(args.pathMarker)) {
                await reader.cancel();
                return event.update.kind;
              }
              cursor = event.eventVersion;
            }
            if (resync) break;
          }
        }
      })();
      (window as unknown as { __tansuEventPromise?: Promise<string> }).__tansuEventPromise =
        eventPromise;
    }, {
      vaultId: vaultOneId,
      serverInstanceId,
      pathMarker,
    });
    await createCodeMirrorNote(page, title);
    await expect(
      page.evaluate(() =>
        (window as unknown as { __tansuEventPromise: Promise<string> }).__tansuEventPromise
      ),
    ).resolves.toBe("noteChanged");
    await page.close();
  });

  it("shows tag pills in the note header, search rows, and recent list and ranks tag matches first", async () => {
    const tagsDir = join(vaultOnePath, "tags");
    await cp(resolve("tests", "fixtures", "demo-vault", "tags"), tagsDir, { recursive: true });
    try {
      for (const name of ["pantry-inventory.md", "storm-log.md", "field-journal.md"]) {
        await waitForNoteByPath(`tags/${name}`);
      }
      const page = await newLoggedPage();
      await page.goto(baseUrl);
      await page.waitForSelector(".main");
      await page.keyboard.press("Control+/");
      const panel = page.locator(".search-panel");
      await panel.waitFor({ state: "visible" });

      const recentRow = panel.locator('.recent-search-result[title="tags/pantry-inventory.md"]');
      await recentRow.waitFor({ state: "visible" });
      await expect(recentRow.locator(".tag-pill-label").allTextContents()).resolves.toEqual([
        "#baking",
        "#Recipes",
        "#pantry",
      ]);
      await expect(recentRow.locator(".search-result-tags-overflow").textContent()).resolves.toBe("+3");
      const recentBoxes = await panel.locator(".recent-search-result").evaluateAll((nodes) =>
        nodes.map((node) => {
          const row = node.getBoundingClientRect();
          const content = [...node.children].map((child) => child.getBoundingClientRect());
          return { top: row.top, bottom: row.bottom, contentBottom: Math.max(...content.map((box) => box.bottom)) };
        })
      );
      expect(recentBoxes.length).toBeGreaterThan(5);
      for (const [index, box] of recentBoxes.entries()) {
        expect(box.contentBottom, `recent row ${index} content stays inside its row`).toBeLessThanOrEqual(box.bottom + 0.5);
        if (index > 0) {
          expect(box.top, `recent row ${index} starts below the previous row`).toBeGreaterThanOrEqual(recentBoxes[index - 1]!.bottom - 0.5);
        }
      }

      await panel.locator(".command-input").fill("zephyr");
      const rows = panel.locator(".search-result-row");
      await expect.poll(() => rows.count()).toBe(2);
      await expect(rows.first().locator(".tag-pill-label").allTextContents()).resolves.toEqual(["#zephyr"]);
      await expect(rows.first().textContent()).resolves.toContain("Storm log");
      await expect(rows.nth(1).textContent()).resolves.toContain("Field journal");
      await expect(rows.nth(1).locator(".tag-pill").count()).resolves.toBe(0);

      await rows.first().click();
      await panel.waitFor({ state: "detached" });
      await expect.poll(() => page.locator("#editor-mount .tag-row .tag-pill-label").allTextContents())
        .toEqual(["#zephyr"]);
      await page.close();
    } finally {
      await rm(tagsDir, { recursive: true, force: true });
    }
  });

  it("reconciles external filesystem edits for the active vault", async () => {
    const page = await newLoggedPage();
    await page.goto(baseUrl);
    let signalSubscribed: () => void = () => {};
    const subscribed = new Promise<void>((resolve) => {
      signalSubscribed = resolve;
    });
    await page.exposeFunction("tansuStreamSubscribed", () => signalSubscribed());
    const eventPromise = page.evaluate(async (args) => {
      let cursor = 0;
      while (true) {
        const response = await fetch(`/api/v2/vaults/${args.vaultId}/events?after=${cursor}`, {
          headers: { "X-Tansu-Server-Instance": args.serverInstanceId },
        });
        if (!response.ok || response.body === null) throw new Error(`event stream failed: ${response.status}`);
        (window as unknown as { tansuStreamSubscribed: () => void }).tansuStreamSubscribed();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let resync = false;
        while (true) {
          const result = await reader.read();
          if (result.done) {
            if (resync) break;
            throw new Error("event stream closed before vault change");
          }
          buffer += decoder.decode(result.value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
            if (!data) continue;
            const event = JSON.parse(data) as {
              eventVersion: number;
              resyncRequired: boolean;
              update: { kind: string; notes?: { path: string }[] };
            };
            if (event.resyncRequired) {
              cursor = event.eventVersion;
              resync = true;
              await reader.cancel();
              break;
            }
            if (event.update.kind === "vaultChanged" && event.update.notes?.some((note) => note.path.endsWith("outside.md"))) {
              await reader.cancel();
              return "vaultChanged";
            }
            cursor = event.eventVersion;
          }
          if (resync) break;
        }
      }
    }, { vaultId: vaultOneId, serverInstanceId });
    await Promise.race([subscribed, eventPromise]);
    await writeFile(join(vaultOnePath, "outside.md"), "# Outside\n\nedit\n", "utf8");
    await expect(eventPromise).resolves.toBe("vaultChanged");
    await page.close();
  });

  it("restores revisions and serves vault-scoped image assets", async () => {
    const page = await newLoggedPage();
    await page.goto(baseUrl);
    await createCodeMirrorNote(page, "Recover");
    const originalContent = "# Recover\n\nold\n";
    const originalSave = page.waitForResponse((response) =>
      response.request().method() === "PUT" && response.status() === 200
    );
    await page.locator(".cm-content").fill(originalContent);
    await page.keyboard.press(`${shortcutModifier()}+s`);
    await originalSave;
    const original = await loadNoteByPath(vaultOneId, "recover.md");
    const changedContent = "# Recover\n\nnew\n";
    const changedSave = page.waitForResponse((response) =>
      response.request().method() === "PUT" && response.status() === 200
    );
    await page.locator(".cm-content").fill(changedContent);
    await page.keyboard.press(`${shortcutModifier()}+s`);
    await changedSave;
    const current = await loadNoteByPath(vaultOneId, "recover.md");
    const revisions = await v2Request(vaultOneId, `/notes/${original.meta.noteId}/revisions`)
      .then((response) => response.json()) as { revision: number; sourceHash: string | null }[];
    const originalRevision = revisions.find((revision) =>
      revision.sourceHash === original.meta.sourceHash
    );
    if (originalRevision === undefined) throw new Error("missing initial recovery revision");
    const restored = await v2Request(
      vaultOneId,
      `/notes/${original.meta.noteId}/revisions/${originalRevision.revision}/restore`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mutationId: randomUUID(),
          precondition: {
            baseRevision: current.meta.revision,
            baseSourceHash: current.meta.sourceHash,
            baseDiskHash: current.meta.diskHash,
          },
        }),
      },
    ).then((response) => response.json()) as { outcome: { state: string } };
    expect(restored.outcome.state).toBe("accepted");
    const recovered = await v2Request(vaultOneId, `/notes/${original.meta.noteId}`)
      .then((response) => response.json()) as TestNoteDocument;
    expect(recovered.content).toContain("old");

    const uploaded = await v2Request(vaultOneId, "/images", {
      method: "POST",
      headers: {
        "Content-Type": "image/webp",
        "X-Tansu-Mutation-Id": randomUUID(),
      },
      body: new Uint8Array([1, 2, 3]),
    }).then((response) => response.json()) as { name: string };
    const asset = await v2Request(vaultOneId, `/assets?name=${encodeURIComponent(uploaded.name)}`);
    expect(asset.ok).toBeTruthy();
    await expect(asset.arrayBuffer()).resolves.toHaveProperty("byteLength", 3);
    await expect.poll(() => page.locator(".cm-content").textContent()).toContain("old");
    await page.keyboard.press("Control+End");
    let pastedUploadResponse: PlaywrightResponse | undefined;
    page.on("response", (response) => {
      if (new URL(response.url()).pathname.endsWith("/images") && response.status() === 201) {
        pastedUploadResponse = response;
      }
    });
    const pastedNoteSave = page.waitForResponse((response) =>
      response.request().method() === "PUT" && response.status() === 200
    );
    let releasePastedImageUpload!: () => void;
    const pastedImageUploadGate = new Promise<void>((resolve) => {
      releasePastedImageUpload = resolve;
    });
    let markPastedImageUploadStarted!: () => void;
    const pastedImageUploadStarted = new Promise<void>((resolve) => {
      markPastedImageUploadStarted = resolve;
    });
    const pastedImageUploadPath = `**/api/v2/vaults/${encodeURIComponent(vaultOneId)}/images`;
    await page.route(pastedImageUploadPath, async (route) => {
      markPastedImageUploadStarted();
      await pastedImageUploadGate;
      await route.continue();
    });
    try {
      await page.locator(".cm-content").evaluate(async (content) => {
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext("2d");
        if (context === null) throw new Error("2D canvas is unavailable");
        context.fillRect(0, 0, 1, 1);
        const blob = await new Promise<Blob>((resolveBlob, rejectBlob) => {
          canvas.toBlob((result) => result === null ? rejectBlob(new Error("Could not create PNG fixture")) : resolveBlob(result));
        });
        const clipboard = new DataTransfer();
        clipboard.items.add(new File([blob], "pasted.png", { type: "image/png" }));
        const paste = new Event("paste", {
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(paste, "clipboardData", { value: clipboard });
        content.dispatchEvent(paste);
      });
      const pastedPreview = page.locator(".tansu-pasted-image-preview img");
      await expect(pastedPreview.count()).resolves.toBe(1);
      await expect(pastedPreview.getAttribute("src")).resolves.toMatch(/^blob:/u);
      await pastedImageUploadStarted;
      await expect.poll(async () => {
        if (await pastedPreview.count() !== 1) return false;
        return pastedPreview.evaluate((image) => {
          const style = getComputedStyle(image);
          const bounds = image.getBoundingClientRect();
          return style.visibility === "visible" && style.display !== "none" && bounds.width > 0 && bounds.height > 0;
        });
      }).toBe(true);
      await expect.poll(() => pastedPreview.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(1);
      const pastedPreviewBox = await pastedPreview.boundingBox();
      expect(pastedPreviewBox?.width).toBeGreaterThan(0);
      expect(pastedPreviewBox?.height).toBeGreaterThan(0);
    } finally {
      releasePastedImageUpload();
    }
    await expect.poll(() => page.locator(".tansu-pasted-image-preview").count()).toBe(0);
    await expect.poll(() => pastedUploadResponse !== undefined).toBe(true);
    await pastedNoteSave;
    const pastedNote = await loadNoteByPath(vaultOneId, "recover.md");
    expect(pastedNote.content).toContain("![[z-images/");
  });

  it("applies V2 delta edits against the requested source revision", async () => {
    const page = await newLoggedPage();
    await page.goto(baseUrl);
    await page.waitForSelector(".main");
    await createCodeMirrorNote(page, "Delta Body");

    const baseContent = `# Delta Body\n${Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n")}`;
    const initialSave = page.waitForResponse((response) =>
      response.request().method() === "PUT" && response.status() === 200
    );
    await page.locator(".cm-content").fill(baseContent);
    await page.keyboard.press(`${shortcutModifier()}+s`);
    await initialSave;
    const base = await loadNoteByPath(vaultOneId, "delta-body.md");
    const insertionPoint = baseContent.indexOf("line 1") + "line 1".length;
    const expected = `${baseContent.slice(0, insertionPoint)} edited${baseContent.slice(insertionPoint)}`;
    await createCodeMirrorNote(page, "Delta Hash Reference");
    const referenceSave = page.waitForResponse((response) =>
      response.request().method() === "PUT" && response.status() === 200
    );
    await page.locator(".cm-content").fill(expected);
    await page.keyboard.press(`${shortcutModifier()}+s`);
    await referenceSave;
    const reference = await loadNoteByPath(vaultOneId, "delta-hash-reference.md");
    const request = {
      mutationId: randomUUID(),
      precondition: {
        baseRevision: base.meta.revision,
        baseSourceHash: base.meta.sourceHash,
        baseDiskHash: base.meta.diskHash,
      },
      sourceHash: reference.meta.sourceHash,
      edits: [{
        start: { line: 1, character: "line 1".length },
        end: { line: 1, character: "line 1".length },
        text: " edited",
      }],
    };
    const response = await v2Request(vaultOneId, `/notes/${encodeURIComponent(base.meta.noteId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(200);
    const mutation = await response.json() as { outcome: { state: string } };
    expect(mutation.outcome.state).toBe("accepted");
    expect(request).not.toHaveProperty("content");
    await expectSavedContent("delta-body.md", expected);
    await page.close();
  });

  it("preserves the V2 note lifecycle through restart and conflict recovery", async () => {
    const page = await newLoggedPage();
    await page.goto(baseUrl);
    await page.waitForSelector(".main");
    await createCodeMirrorNote(page, "Cross Engine Lifecycle");

    const edited = "# Cross Engine Lifecycle\n\n\nsearchable lifecycle baseline\n";
    const uiSave = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        new URL(response.url()).pathname.startsWith(`/api/v2/vaults/${vaultOneId}/notes/`) &&
        response.status() === 200,
    );
    await page.locator(".cm-content").click();
    await page.keyboard.type("# Cross Engine Lifecycle");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("searchable lifecycle baseline\n");
    await page.keyboard.press(`${shortcutModifier()}+s`);
    await uiSave;
    await expectSavedContent("cross-engine-lifecycle.md", edited);

    await page.keyboard.press(`${shortcutModifier()}+Shift+f`);
    await page.locator(".search-panel input").fill("searchable lifecycle");
    await page.waitForSelector(".search-snippet mark");
    await expect
      .poll(() => page.locator(".search-snippet").first().textContent())
      .toContain("searchable lifecycle");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".search-panel", { state: "detached" });

    await page.locator(".tab.active").click({ button: "right" });
    await page.locator(".context-menu", { hasText: "Rename" }).getByText("Rename").click();
    await page.locator(".note-dialog-panel input").fill("Cross Engine Renamed");
    const renamed = page.waitForResponse(
      (response) => response.url().includes("/rename") && response.status() === 200,
    );
    await page.locator(".note-dialog-panel .primary-button").click();
    await renamed;
    await page.waitForSelector(".note-dialog-panel", { state: "detached" });

    const note = await loadNoteByPath(vaultOneId, "cross-engine-renamed.md");
    const winningContent = "# Cross Engine Renamed\n\ncanonical after restart\n";
    const draftContent = "# Cross Engine Renamed\n\nconflict draft for recovery\n";
    const precondition = {
      baseRevision: note.meta.revision,
      baseSourceHash: note.meta.sourceHash,
      baseDiskHash: note.meta.diskHash,
    };
    const winningSave = page.waitForResponse((response) =>
      response.request().method() === "PUT" && response.status() === 200
    );
    await page.locator(".cm-content").fill(winningContent);
    await page.keyboard.press(`${shortcutModifier()}+s`);
    await winningSave;
    const winningNote = await loadNoteByPath(vaultOneId, "cross-engine-renamed.md");

    await createCodeMirrorNote(page, "Conflict Draft Source");
    const draftSave = page.waitForResponse((response) =>
      response.request().method() === "PUT" && response.status() === 200
    );
    await page.locator(".cm-content").fill(draftContent);
    await page.keyboard.press(`${shortcutModifier()}+s`);
    await draftSave;
    const draftSource = await loadNoteByPath(vaultOneId, "conflict-draft-source.md");
    await page.close();

    const save = (content: string, contentHash: string) =>
      v2Request(vaultOneId, `/notes/${note.meta.noteId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mutationId: randomUUID(),
          precondition,
          content,
          sourceHash: contentHash,
        }),
      });
    const conflictingSave = await save(draftContent, draftSource.meta.sourceHash).then((response) => response.json()) as {
      outcome: { state: string; draft?: { draftId: number } };
    };
    expect(conflictingSave.outcome.state).toBe("conflict");
    const draftId = conflictingSave.outcome.draft?.draftId;
    if (draftId === undefined) throw new Error("conflict response did not preserve its draft");
    const preservedDraft = await v2Request(
      vaultOneId,
      `/notes/${note.meta.noteId}/conflicts/${draftId}`,
    ).then((response) => response.json()) as { content: string };
    expect(preservedDraft.content).toBe(draftContent);

    const originalServerInstanceId = serverInstanceId;
    await stopFixtureServer();
    await startFixtureServer();
    const bootstrap = await fetch(`${baseUrl}/api/v2/bootstrap`).then((response) => response.json()) as {
      serverInstanceId: string;
    };
    expect(bootstrap.serverInstanceId).toBe(originalServerInstanceId);

    const afterRestart = await v2Request(vaultOneId, `/notes/${note.meta.noteId}`)
      .then((response) => response.json()) as TestNoteDocument;
    expect(afterRestart.meta.path).toBe("cross-engine-renamed.md");
    expect(afterRestart.content).toBe(winningContent);
    const restoreConflict = await v2Request(
      vaultOneId,
      `/notes/${note.meta.noteId}/conflicts/${draftId}/restore`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mutationId: randomUUID(),
          precondition: {
            baseRevision: afterRestart.meta.revision,
            baseSourceHash: afterRestart.meta.sourceHash,
            baseDiskHash: afterRestart.meta.diskHash,
          },
        }),
      },
    ).then((response) => response.json()) as { outcome: { state: string } };
    expect(restoreConflict.outcome.state).toBe("accepted");
    const recoveredDraft = await v2Request(vaultOneId, `/notes/${note.meta.noteId}`)
      .then((response) => response.json()) as TestNoteDocument;
    expect(recoveredDraft.content).toBe(draftContent);

    const revisions = await v2Request(vaultOneId, `/notes/${note.meta.noteId}/revisions`)
      .then((response) => response.json()) as { revision: number; sourceHash: string | null }[];
    const winningRevision = revisions.find((revision) => revision.sourceHash === winningNote.meta.sourceHash);
    if (winningRevision === undefined) throw new Error("winning content revision was not retained");
    const restoreRevision = await v2Request(
      vaultOneId,
      `/notes/${note.meta.noteId}/revisions/${winningRevision.revision}/restore`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mutationId: randomUUID(),
          precondition: {
            baseRevision: recoveredDraft.meta.revision,
            baseSourceHash: recoveredDraft.meta.sourceHash,
            baseDiskHash: recoveredDraft.meta.diskHash,
          },
        }),
      },
    ).then((response) => response.json()) as { outcome: { state: string } };
    expect(restoreRevision.outcome.state).toBe("accepted");
    await expect.poll(async () => (
      await v2Request(vaultOneId, `/notes/${note.meta.noteId}`).then((response) => response.json()) as TestNoteDocument
    ).content).toBe(winningContent);
  }, 120_000);

  it("acceptance: an edit closed immediately is on disk and visible from a second browser context", async () => {
    const page = await newLoggedPage();
    await page.goto(baseUrl);
    await page.waitForSelector(".main");
    await createCodeMirrorNote(page, "Acceptance Close Tab");
    const content = "# Acceptance Close Tab\n\nwritten just before the tab closed\n";

    await page.locator("#editor-mount .cm-content").fill(content);
    await page.locator(".tab.active .tab-close").click();
    await page.waitForSelector(".tab", { state: "detached" });

    await expect.poll(() => readVaultFile("acceptance-close-tab.md")).toBe(content);
    const otherContext = await newLoggedPage();
    await otherContext.goto(baseUrl);
    await otherContext.waitForSelector(".main");
    await openSearchNote(otherContext, "Acceptance Close Tab");
    await expect.poll(() => otherContext.locator("#editor-mount .cm-content").textContent()).toContain(
      "written just before the tab closed",
    );
    expect(await readVaultFile("acceptance-close-tab.md")).toBe(content);
    await otherContext.close();
    await page.close();
  });

  it("acceptance: a save held in flight across a server restart lands on disk", async () => {
    const page = await newLoggedPage();
    await page.goto(baseUrl);
    await page.waitForSelector(".main");
    await createCodeMirrorNote(page, "Acceptance Restart");
    const content = "# Acceptance Restart\n\nsaved while the server restarted\n";
    const heldSave = holdNextNoteSave(page);

    await page.locator("#editor-mount .cm-content").fill(content);
    const route = await heldSave;
    expect(await readVaultFile("acceptance-restart.md")).not.toBe(content);
    await stopFixtureServer();
    await startFixtureServer();
    const saved = page.waitForResponse((response) =>
      response.request().method() === "PUT" && response.status() === 200
    );
    await route.continue();
    await saved;

    await expect.poll(() => readVaultFile("acceptance-restart.md")).toBe(content);
    await page.close();
  }, 120_000);

  it("acceptance: a stale save creates a conflict draft that restores against the canonical revision", async () => {
    const page = await newLoggedPage();
    await page.route((url) => url.pathname.endsWith("/events"), (route) => route.abort());
    await page.goto(baseUrl);
    await page.waitForSelector(".main");
    await createCodeMirrorNote(page, "Acceptance Conflict");
    const draftContent = "# Acceptance Conflict\n\nthe stale tab's draft\n";
    const winningContent = "# Acceptance Conflict\n\nthe other writer's canonical text\n";
    const base = await waitForNoteByPath("acceptance-conflict.md");
    const heldSave = holdNextNoteSave(page);

    await page.locator("#editor-mount .cm-content").fill(draftContent);
    const route = await heldSave;
    const winning = await v2Request(vaultOneId, `/notes/${base.meta.noteId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mutationId: randomUUID(),
        precondition: {
          baseRevision: base.meta.revision,
          baseSourceHash: base.meta.sourceHash,
          baseDiskHash: base.meta.diskHash,
        },
        content: winningContent,
        sourceHash: await canonicalSourceHash(winningContent),
      }),
    }).then((response) => response.json()) as { outcome: { state: string } };
    expect(winning.outcome.state).toBe("accepted");
    const rejected = page.waitForResponse((response) =>
      response.request().method() === "PUT" && response.status() === 200
    );
    await route.continue();
    const rejection = await (await rejected).json() as { outcome: { state: string; draft?: { draftId: number } } };
    expect(rejection.outcome.state).toBe("conflict");
    expect(rejection.outcome.draft?.draftId).toBeDefined();
    await page.waitForSelector(".conflict-banner");
    expect(await readVaultFile("acceptance-conflict.md")).toBe(winningContent);

    await page.locator('.conflict-banner [title="View conflict draft"]').click();
    await expect.poll(() => page.locator(".revisions-panel .diff-preview").textContent()).toBe(draftContent);
    await page.locator('.revisions-panel [title="Restore conflict draft"]').click();
    await page.waitForSelector(".conflict-banner", { state: "detached" });

    await expect.poll(() => readVaultFile("acceptance-conflict.md")).toBe(draftContent);
    await page.close();
  });

  it("acceptance: a save that hits network failures is retried under one mutation id and lands once", async () => {
    const page = await newLoggedPage();
    await page.goto(baseUrl);
    await page.waitForSelector(".main");
    await createCodeMirrorNote(page, "Acceptance Retry");
    const base = await waitForNoteByPath("acceptance-retry.md");
    const content = "# Acceptance Retry\n\nsent after two dropped connections\n";
    const mutationIds: string[] = [];
    await page.route(noteMutationUrl, (route) => {
      const request = route.request();
      if (request.method() === "GET") return route.fallback();
      mutationIds.push((JSON.parse(request.postData() ?? "{}") as { mutationId?: string }).mutationId ?? "");
      return mutationIds.length <= 2 ? route.abort("connectionfailed") : route.fallback();
    });

    await page.locator("#editor-mount .cm-content").fill(content);

    await expect.poll(() => readVaultFile("acceptance-retry.md"), { timeout: 15_000 }).toBe(content);
    expect(mutationIds).toHaveLength(3);
    expect(new Set(mutationIds).size).toBe(1);
    expect(mutationIds[0]).not.toBe("");
    const revisions = await v2Request(vaultOneId, `/notes/${base.meta.noteId}/revisions`)
      .then((response) => response.json()) as { sourceHash: string | null }[];
    expect(revisions.filter((revision) => revision.sourceHash === base.meta.sourceHash)).toHaveLength(1);
    expect((await loadNoteByPath(vaultOneId, "acceptance-retry.md")).meta.revision).toBe(base.meta.revision + 1);
    await page.close();
  });

  it("acceptance: a long session of opening, closing, and pasting leaks no workers, blob URLs, or editors", async () => {
    const page = await newLoggedPage();
    await page.addInitScript(() => {
      const liveBlobUrls = new Set<string>();
      const createObjectURL = URL.createObjectURL.bind(URL);
      const revokeObjectURL = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (object) => {
        const url = createObjectURL(object);
        liveBlobUrls.add(url);
        return url;
      };
      URL.revokeObjectURL = (url) => {
        liveBlobUrls.delete(url);
        revokeObjectURL(url);
      };
      let liveWorkers = 0;
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        private terminated = false;
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          liveWorkers += 1;
        }
        override terminate(): void {
          if (!this.terminated) {
            this.terminated = true;
            liveWorkers -= 1;
          }
          super.terminate();
        }
      };
      Object.defineProperty(window, "__tansuLeaks", {
        value: () => ({
          blobUrls: liveBlobUrls.size,
          workers: liveWorkers,
          editors: document.querySelectorAll(".cm-editor").length,
        }),
      });
    });
    await page.goto(baseUrl);
    await page.waitForSelector(".main");
    const leaks = () => page.evaluate(() =>
      (window as unknown as { __tansuLeaks: () => { blobUrls: number; workers: number; editors: number } })
        .__tansuLeaks()
    );
    const cycle = async () => {
      await openSearchNote(page, "visual");
      await page.waitForSelector('.cm-content .cm-atomic-image[data-image-name="z-images/sample.webp"] img');
      await page.waitForFunction(() => {
        const image = document.querySelector<HTMLImageElement>("#editor-mount .cm-atomic-image img");
        return image?.complete === true && image.naturalWidth > 0;
      });
      await openSearchNote(page, "search");
      for (const _tab of [0, 1]) await page.locator(".tab.active .tab-close").click();
      await page.waitForSelector(".tab", { state: "detached" });
    };

    await cycle();
    await cycle();
    await createCodeMirrorNote(page, "Acceptance Leak Paste");
    await page.locator("#editor-mount .cm-content").fill("# Acceptance Leak Paste\n\n");
    for (let pasted = 0; pasted < 3; pasted += 1) {
      await page.keyboard.press("Control+End");
      const uploaded = page.waitForResponse((response) =>
        new URL(response.url()).pathname.endsWith("/images") && response.status() === 201
      );
      await pasteImage(page);
      await uploaded;
      await expect.poll(() => page.locator(".tansu-pasted-image-preview").count()).toBe(0);
    }
    await page.locator(".tab.active .tab-close").click();
    await page.waitForSelector(".tab", { state: "detached" });
    const warm = await leaks();
    expect(warm.editors).toBeLessThanOrEqual(1);
    expect(warm.workers).toBe(0);

    for (let round = 0; round < 20; round += 1) await cycle();

    const after = await leaks();
    expect(after.editors).toBeLessThanOrEqual(warm.editors);
    expect(after.workers).toBe(0);
    expect(after.blobUrls).toBeLessThanOrEqual(warm.blobUrls);
    await page.close();
  }, 180_000);

  it("acceptance: auth expiring while an image upload is in flight locks the app without losing the note", async () => {
    const page = await newLoggedPage();
    await page.goto(baseUrl);
    await page.waitForSelector(".main");
    await createCodeMirrorNote(page, "Acceptance Auth Upload");
    await waitForNoteByPath("acceptance-auth-upload.md");
    const content = "# Acceptance Auth Upload\n\ntyped before the session expired\n";
    await page.locator("#editor-mount .cm-content").fill(content);
    await expect.poll(() => readVaultFile("acceptance-auth-upload.md"), { timeout: 15_000 }).toBe(content);
    let expired = false;
    await page.route("**/api/v2/**", (route) => expired ? route.fulfill(authRequiredResponse()) : route.fallback());
    let uploadStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      uploadStarted = resolve;
    });
    let expireNow!: () => void;
    const expiry = new Promise<void>((resolve) => {
      expireNow = resolve;
    });
    await page.route(`**/api/v2/vaults/${encodeURIComponent(vaultOneId)}/images`, async (route) => {
      uploadStarted();
      await expiry;
      expired = true;
      await route.fulfill(authRequiredResponse());
    });

    await page.keyboard.press("Control+End");
    await pasteImage(page);
    await started;
    await page.locator("#editor-mount .cm-content").pressSequentially("typed during the upload\n");
    expireNow();

    await page.waitForSelector(".auth-gate");
    expect(await readVaultFile("acceptance-auth-upload.md")).not.toContain("![[");
    expired = false;
    await page.reload();
    await page.waitForSelector(".main");
    await expect.poll(() => page.locator("#editor-mount .cm-content").textContent()).toContain(
      "typed during the upload",
    );
    expect(await page.locator("#editor-mount .cm-content").textContent()).not.toContain("![[");
    expect(await readVaultFile("acceptance-auth-upload.md")).not.toContain("![[");
    await page.close();
  }, 120_000);

  it("acceptance: a replayed stale event after a duplicated stream leaves the note list at the latest rename and the cursor advances", async () => {
    const page = await newLoggedPage();
    const streamRequests: string[] = [];
    let releaseFirstStream!: () => void;
    const firstStreamGate = new Promise<void>((resolve) => {
      releaseFirstStream = resolve;
    });
    let replayFrames: string[] = [];
    let staleFrame = "";
    await page.route((url) => url.pathname.endsWith("/events"), async (route) => {
      streamRequests.push(new URL(route.request().url()).search);
      if (streamRequests.length > 1) return route.fallback();
      await firstStreamGate;
      return route.fulfill({
        status: 200,
        headers: { ...v2ResponseHeaders(), "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
        body: [...replayFrames, ...replayFrames, staleFrame].map((frame) => `${frame}\n\n`).join(""),
      });
    });
    await page.goto(baseUrl);
    await page.waitForSelector(".main");
    await expect.poll(() => streamRequests.length).toBe(1);
    const after = Number(new URLSearchParams(streamRequests[0]).get("after"));

    const original = "acceptance-replay-before.md";
    const renamed = "acceptance-replay-after.md";
    const content = "# Acceptance Replay\n\nreplayed\n";
    const created = await v2Request(vaultOneId, "/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mutationId: randomUUID(),
        path: original,
        content,
        sourceHash: await canonicalSourceHash(content),
      }),
    }).then((response) => response.json()) as { outcome: { state: string; result: TestNoteMeta } };
    expect(created.outcome.state).toBe("accepted");
    const meta = created.outcome.result;
    const rename = await v2Request(vaultOneId, `/notes/${meta.noteId}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mutationId: randomUUID(),
        precondition: { baseRevision: meta.revision, baseSourceHash: meta.sourceHash, baseDiskHash: meta.diskHash },
        path: renamed,
      }),
    }).then((response) => response.json()) as { outcome: { state: string } };
    expect(rename.outcome.state).toBe("accepted");
    replayFrames = await readEventFramesUntil(after, (event) =>
      event.update.kind === "noteChanged" && event.update.note.noteId === meta.noteId &&
      event.update.note.path === renamed);
    staleFrame = replayFrames.find((frame) => frame.includes(`"path":"${original}"`)) ?? "";
    expect(staleFrame).not.toBe("");
    releaseFirstStream();

    await page.keyboard.press("Control+/");
    await page.locator(`.recent-search-result[title="${renamed}"]`).waitFor();
    await expect(page.locator(`.recent-search-result[title="${original}"]`).count()).resolves.toBe(0);
    await expect(page.locator(`.recent-search-result[title="${renamed}"]`).count()).resolves.toBe(1);

    await expect.poll(() => streamRequests.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    const lastVersion = Number(JSON.parse(replayFrames.at(-1)!.split("\n").find((line) => line.startsWith("data: "))!.slice(6)).eventVersion);
    expect(Number(new URLSearchParams(streamRequests[1]).get("after"))).toBe(lastVersion);

    const later = "acceptance-replay-later.md";
    const renamedAgain = await v2Request(vaultOneId, `/notes/${meta.noteId}`)
      .then((response) => response.json()) as TestNoteDocument;
    await v2Request(vaultOneId, `/notes/${meta.noteId}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mutationId: randomUUID(),
        precondition: {
          baseRevision: renamedAgain.meta.revision,
          baseSourceHash: renamedAgain.meta.sourceHash,
          baseDiskHash: renamedAgain.meta.diskHash,
        },
        path: later,
      }),
    });
    await page.locator(`.recent-search-result[title="${later}"]`).waitFor();
    await expect(page.locator(`.recent-search-result[title="${renamed}"]`).count()).resolves.toBe(0);
    await page.close();
  }, 120_000);
});

function browserTypeFromEnv(): BrowserType {
  switch (process.env["TANSU2_E2E_BROWSER"] ?? "chromium") {
    case "chromium": {
      return chromium;
    }
    case "webkit": {
      return webkit;
    }
    default: {
      throw new Error(`Unsupported E2E browser: ${process.env["TANSU2_E2E_BROWSER"]}`);
    }
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      listener.close(() => {
        if (address !== null && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("no free port"));
        }
      });
    });
  });
}

async function startFixtureServer(): Promise<void> {
  if (fixture === undefined) throw new Error("test fixture is not initialized");
  const environment = {
    ...process.env,
    TANSU2_LOGS: "buffer",
    XDG_CONFIG_HOME: fixture.configHome,
    XDG_DATA_HOME: fixture.dataHome,
  };
  if (!serverBinaryBuilt) {
    const supplied = process.env["TANSU2_E2E_SERVER_BINARY"];
    if (supplied === undefined || supplied === "") {
      execFileSync("cargo", ["build", "--quiet", "--bin", "tansu2"], {
        cwd: process.cwd(),
        env: environment,
        stdio: "pipe",
      });
      const targetDirectory = resolve(process.env["CARGO_TARGET_DIR"] ?? "target");
      serverBinaryPath = join(targetDirectory, "debug", process.platform === "win32" ? "tansu2.exe" : "tansu2");
    } else {
      serverBinaryPath = resolve(supplied);
    }
    serverArtifactHash = artifactHash(serverBinaryPath);
    const record = process.env["TANSU2_ACCEPTANCE_RECORD"];
    if (record !== undefined && record !== "") {
      await writeFile(record, `${serverArtifactHash} ${serverBinaryPath}\n`);
    }
    serverBinaryBuilt = true;
  }
  const serverBinary = serverBinaryPath;
  if (!settingsSeeded) {
    execFileSync(serverBinary, [
      "config", "init", "--vault", "One", fixture.vaultOne,
      "--vault", "Two", fixture.vaultTwo,
    ], { cwd: process.cwd(), env: environment, stdio: "pipe" });
    settingsSeeded = true;
  }
  server = spawn(serverBinary, ["--port", String(serverPort)], {
    cwd: process.cwd(),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (chunk: Buffer) => serverOutput.push(chunk.toString("utf8")));
  server.stderr?.on("data", (chunk: Buffer) => serverOutput.push(chunk.toString("utf8")));
  await waitForReady(`${baseUrl}/api/v2/health`);
}

function artifactHash(path: string): string {
  const line = execFileSync(process.execPath, ["scripts/artifact-hash.mjs", path], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  const hash = /^sha256:[0-9a-f]{64}/u.exec(line)?.[0];
  if (hash === undefined) throw new Error(`unexpected artifact hash output: ${line}`);
  return hash;
}

async function stopFixtureServer(): Promise<void> {
  const current = server;
  if (current === undefined) return;
  server = undefined;
  let didExit = false;
  const exited = once(current, "exit").then(() => {
    didExit = true;
  }).catch(() => undefined);
  if (current.pid !== undefined) {
    try {
      current.kill("SIGTERM");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
    }
  }
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (!didExit && current.exitCode === null && current.signalCode === null && current.pid !== undefined) {
    try {
      current.kill("SIGKILL");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
    }
    await exited;
  }
}

async function v2Request(vaultId: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("X-Tansu-Server-Instance", serverInstanceId);
  return fetch(`${baseUrl}/api/v2/vaults/${encodeURIComponent(vaultId)}${path}`, {
    ...init,
    headers,
  });
}

async function waitForReady(url: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not become ready: ${url}\n${serverOutput.join("")}`);
}

async function dumpUnifiedLogs(testName: string): Promise<void> {
  const lines: string[] = [`\n--- tansu2 unified logs for failed test: ${testName} ---`];
  if (baseUrl !== "") {
    try {
      const snapshot = await fetch(`${baseUrl}/api/dev/logs`).then(
        (response) => response.json() as Promise<{ events: LogEvent[] }>,
      );
      for (const event of snapshot.events) {
        lines.push(JSON.stringify(event));
      }
    } catch (error) {
      lines.push(`unable to fetch unified logs: ${error instanceof Error ? error.message : error}`);
    }
  }
  if (serverOutput.length > 0) {
    lines.push("--- server stdout/stderr fallback ---");
    lines.push(serverOutput.join(""));
  }
  lines.push("--- end tansu2 unified logs ---");
  console.error(lines.join("\n"));
}

async function newLoggedPage(): Promise<Page> {
  const page = await browser!.newPage();
  page.on("pageerror", (error) => {
    void postHarnessLog("error", "client.error", {
      page: { url: page.url() },
      error: { name: error.name, message: error.message, stack: error.stack },
    });
  });
  page.on("requestfailed", (request) => {
    void postHarnessLog("warn", "http.request_failed", {
      http: {
        method: request.method(),
        url: request.url(),
        failure: request.failure()?.errorText,
      },
    });
  });
  return page;
}

async function postHarnessLog(
  level: "debug" | "info" | "warn" | "error",
  kind: string,
  fields: Record<string, unknown>,
): Promise<void> {
  if (baseUrl === "") {
    return;
  }
  await fetch(`${baseUrl}/api/dev/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      events: [{ source: "harness", level, kind, ...fields }],
    }),
  }).catch(() => {});
}

async function openSeededDocument(path: string): Promise<TestNoteDocument> {
  return loadNoteByPath(vaultOneId, path);
}

async function loadNoteByPath(vaultId: string, path: string): Promise<TestNoteDocument> {
  const bootstrap = await v2Request(vaultId, "/bootstrap")
    .then((response) => response.json() as Promise<{ notes: TestNoteMeta[] }>);
  const note = bootstrap.notes.find((item) => item.path === path);
  if (note === undefined) {
    throw new Error(`missing seeded note: ${path}`);
  }
  return v2Request(vaultId, `/notes/${encodeURIComponent(note.noteId)}`)
    .then((response) => response.json() as Promise<TestNoteDocument>);
}

async function createCodeMirrorNote(page: Page, title: string): Promise<void> {
  await runPaletteCommand(page, "create");
  await page.locator(".note-dialog-panel input").fill(title);
  await page.locator(".note-dialog-panel input").press("Enter");
  await page.waitForFunction(
    (expected) => document.querySelector(".tab.active")?.textContent?.includes(expected),
    title,
  );
  await expect.poll(() => page.locator("#editor-mount .cm-editor .cm-content").isVisible())
    .toBe(true);
}

async function runPaletteCommand(page: Page, commandID: string): Promise<void> {
  await page.waitForSelector(".main");
  await page.keyboard.press(`${shortcutModifier()}+k`);
  const input = page.locator(".command-panel .command-input");
  await input.waitFor({ state: "visible" });
  await input.fill(commandID);
  await page.locator(`.command-panel .command-row[data-command-id="${commandID}"]`).click();
}

async function openSearchNote(page: Page, query: string): Promise<void> {
  await page.keyboard.press("Control+/");
  const panel = page.locator(".search-panel");
  await panel.waitFor({ state: "visible" });
  await panel.locator(".command-input").fill(query);
  await panel.locator(".search-result-row").first().click();
  await panel.waitFor({ state: "detached" });
  await expect.poll(() => page.locator("#editor-mount .cm-content").textContent()).not.toBe("");
}

async function expectSavedContent(path: string, content: string): Promise<void> {
  await expect.poll(async () => (await openSeededDocument(path)).content).toBe(content);
}

function shortcutModifier(): "Control" | "Meta" {
  return process.platform === "darwin" ? "Meta" : "Control";
}

function readVaultFile(path: string): Promise<string | null> {
  return readFile(join(vaultOnePath, path), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

function holdNextNoteSave(page: Page): Promise<Route> {
  return new Promise((resolve) => {
    let held = false;
    void page.route(
      (url) => /\/api\/v2\/vaults\/[^/]+\/notes\/[^/]+$/.test(url.pathname),
      (route) => {
        if (!held && route.request().method() === "PUT") {
          held = true;
          resolve(route);
        } else {
          void route.fallback();
        }
      },
    );
  });
}

async function waitForNoteByPath(path: string): Promise<TestNoteDocument> {
  let note: TestNoteDocument | undefined;
  await expect.poll(async () => {
    note = await loadNoteByPath(vaultOneId, path).catch(() => undefined);
    return note !== undefined;
  }).toBe(true);
  return note!;
}

const noteMutationUrl = (url: URL): boolean => /\/api\/v2\/vaults\/[^/]+\/notes\/[^/]+$/.test(url.pathname);

function v2ResponseHeaders(): Record<string, string> {
  return { "X-Tansu-Api-Version": "2", "X-Tansu-Build-Id": "e2e" };
}

function authRequiredResponse() {
  return {
    status: 401,
    headers: { ...v2ResponseHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ error: { code: "auth_required" } }),
  };
}

async function readEventFramesUntil(
  after: number,
  done: (event: V2ServerEvent) => boolean,
): Promise<string[]> {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/v2/vaults/${encodeURIComponent(vaultOneId)}/events?after=${after}`, {
    headers: { "X-Tansu-Server-Instance": serverInstanceId },
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("event stream ended before the awaited event");
      buffer += decoder.decode(chunk.value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        if (data === undefined) continue;
        frames.push(block);
        if (done(JSON.parse(data.slice(6)))) return frames;
      }
    }
  } finally {
    controller.abort();
  }
}

async function pasteImage(page: Page): Promise<void> {
  await page.locator("#editor-mount .cm-content").evaluate(async (content) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("2D canvas is unavailable");
    context.fillRect(0, 0, 1, 1);
    const blob = await new Promise<Blob>((resolveBlob, rejectBlob) => {
      canvas.toBlob((result) => result === null ? rejectBlob(new Error("Could not create PNG fixture")) : resolveBlob(result));
    });
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([blob], "pasted.png", { type: "image/png" }));
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: clipboard });
    content.dispatchEvent(paste);
  });
}
