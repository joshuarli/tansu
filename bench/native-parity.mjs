import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import net from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { chromium, firefox, webkit } from "playwright";
import { NATIVE_PARITY_SCENES } from "../tests/visual-parity/scenes.ts";

const repositoryRoot = resolve(import.meta.dirname, "..");
const corpusRoot = join(repositoryRoot, "tests/visual-parity/native-oracle/v1");
const manifest = JSON.parse(await readFile(join(corpusRoot, "manifest.json"), "utf8"));
const derivatives = JSON.parse(await readFile(join(corpusRoot, "browser-derivatives/manifest.json"), "utf8"));
const runID = process.env.TANSU_VISUAL_PARITY_RUN_ID ?? new Date().toISOString().replaceAll(/[:.]/g, "-");
const runRoot = join(repositoryRoot, ".work/tmp/visual-parity", runID);
const targetRoot = join(repositoryRoot, ".work/tmp/visual-parity-target");
const browserName = process.env.TANSU_VISUAL_PARITY_BROWSER ?? "webkit";
const browserType = { webkit, chromium, firefox }[browserName];
const sceneIDs = process.env.TANSU_VISUAL_PARITY_SCENES?.split(",").filter(Boolean);
const scenes = sceneIDs === undefined
  ? NATIVE_PARITY_SCENES
  : NATIVE_PARITY_SCENES.filter((scene) => sceneIDs.includes(scene.id));
const parityFault = process.env.TANSU_VISUAL_PARITY_FAULT;
const parityFaultScenes = {
  translation: "chrome-900x640",
  "wrong-width": "empty-900x640",
  "font-size": "tabs-markdown-1040x720",
  "modal-offset": "command-palette-panel",
  "altered-image": "search-results-900x640",
  "wrong-note-source": "search-results-900x640",
};

if (browserType === undefined) throw new Error(`Unsupported parity browser: ${browserName}`);
if (scenes.length === 0 || (sceneIDs !== undefined && scenes.length !== new Set(sceneIDs).size)) {
  throw new Error(`Unknown or empty visual parity scene selection: ${sceneIDs?.join(",") ?? ""}`);
}
if (parityFault !== undefined && (parityFaultScenes[parityFault] !== scenes[0]?.id || scenes.length !== 1)) {
  throw new Error(`Parity fault ${parityFault} requires scene ${parityFaultScenes[parityFault]}`);
}
if (manifest.backingScale !== 2 || manifest.appearance !== "Aqua") throw new Error("Native oracle host contract is invalid");
await mkdir(runRoot, { recursive: true });
await writeFile(join(runRoot, "run.json"), JSON.stringify({
  runID,
  browser: browserName,
  oracleCommit: manifest.sourceCommit,
  oracleOS: manifest.operatingSystem,
  startedAt: new Date().toISOString(),
}, null, 2));
execFileSync("deno", ["task", "build"], { cwd: repositoryRoot, env: { ...process.env, TMPDIR: join(repositoryRoot, ".work/tmp") }, stdio: "inherit" });
execFileSync("cargo", ["build", "--quiet", "--bin", "tansu2"], { cwd: repositoryRoot, env: { ...process.env, TMPDIR: join(repositoryRoot, ".work/tmp") }, stdio: "inherit" });
let browser;
let overlayContext;
let overlayPage;
if (parityFault !== "altered-image" && parityFault !== "wrong-note-source") {
  browser = await browserType.launch();
  overlayContext = await browser.newContext({ viewport: { width: 1, height: 1 } });
  overlayPage = await overlayContext.newPage();
  await overlayPage.goto("about:blank");
}
const reports = [];

try {
  for (const scene of scenes) {
    reports.push(await runScene(scene, browser));
  }
} finally {
  await overlayContext?.close();
  await browser?.close();
}

const report = {
  schemaVersion: 1,
  runID,
  browser: browserName,
  oracleCommit: manifest.sourceCommit,
  startedAt: JSON.parse(await readFile(join(runRoot, "run.json"), "utf8")).startedAt,
  completedAt: new Date().toISOString(),
  scenes: reports,
};
await writeFile(join(runRoot, "report.json"), JSON.stringify(report, null, 2));
await writeIndex(runRoot, reports);
process.stdout.write(`Visual parity artifacts: ${runRoot}\n`);
process.stdout.write(`Visual parity report: ${join(runRoot, "report.json")}\n`);
process.exitCode = reports.some((scene) => scene.status !== "pass") ? 1 : 0;

async function runScene(scene, browser) {
  const sceneRoot = join(runRoot, scene.id);
  const fixtureRoot = join(sceneRoot, "fixture");
  const vaultRoot = join(fixtureRoot, "vault");
  const configHome = join(fixtureRoot, "config");
  const dataHome = join(fixtureRoot, "data");
  const actualPath = join(sceneRoot, "actual.png");
  await mkdir(sceneRoot, { recursive: true });
  await mkdir(vaultRoot, { recursive: true });
  await mkdir(join(configHome, "tansu"), { recursive: true });
  await mkdir(dataHome, { recursive: true });
  if (scene.sourceSet !== "empty") {
    await cp(join(corpusRoot, "source-fixtures", scene.sourceSet), vaultRoot, { recursive: true });
  }
  await writeFile(join(configHome, "tansu/config.toml"), `[[vaults]]\nname = "Parity"\npath = ${JSON.stringify(vaultRoot)}\n`, "utf8");

  const port = await freePort();
  const server = spawn(join(repositoryRoot, "target/debug/tansu2"), ["--port", String(port)], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      TMPDIR: join(repositoryRoot, ".work/tmp"),
      TANSU2_LOGS: "buffer",
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverOutput = [];
  server.stdout.on("data", (chunk) => serverOutput.push(chunk.toString()));
  server.stderr.on("data", (chunk) => serverOutput.push(chunk.toString()));
  const baseURL = `http://127.0.0.1:${port}`;
  let context;
  let page;
  let captured;
  let geometryErrors = [];
  let failure = null;
  let sourceEvidence = [];

  try {
    await applyFixtureFault(parityFault, vaultRoot);
    sourceEvidence = await verifySceneSource(scene, vaultRoot);
    await waitForHealth(baseURL, server);
    context = await browser.newContext({
      viewport: { width: scene.pointWidth, height: scene.pointHeight },
      deviceScaleFactor: 2,
      locale: "en-US",
      timezoneId: "UTC",
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    page = await context.newPage();
    const imageMap = Object.fromEntries(derivatives.assets.map((asset, index) => [
      asset.wikiImageName,
      `${baseURL}/__native-parity-image/${index}`,
    ]));
    const encodedImageMap = JSON.stringify(imageMap);
    await page.addInitScript(`(()=>{const apply=()=>{if(!document.documentElement)return false;document.documentElement.dataset.nativeParityImageMap=${JSON.stringify(encodedImageMap)};return true};if(!apply()){const observer=new MutationObserver(()=>{if(apply())observer.disconnect()});observer.observe(document,{childList:true})}})();`);
    await page.route(`${baseURL}/__native-parity-image/**`, async (route) => {
      const index = Number(new URL(route.request().url()).pathname.split("/").at(-1));
      const asset = derivatives.assets[index];
      if (!Number.isInteger(index) || asset === undefined) {
        await route.abort("failed");
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "image/webp",
        body: await readFile(join(corpusRoot, asset.derivativeRelativePath)),
      });
    });
    await page.goto(baseURL, { waitUntil: "domcontentloaded" });
    await page.locator(".main").waitFor({ state: "visible" });
    await page.evaluate(() => document.fonts.ready);
    await runActions(page, scene);
    await applyCaptureFault(parityFault, page);
    await assertSceneState(page, scene);
    await waitForPaint(page);
    await page.mouse.move(0, 0);
    await page.addStyleTag({ content: "*{animation:none!important;transition:none!important;scroll-behavior:auto!important}#editor-mount .cm-cursor,#editor-mount .cm-dropCursor{opacity:0!important}" });
    await waitForPaint(page);
    if (scene.captureType === "panel-only") {
      await isolatePanel(page, scene);
      await waitForPaint(page);
    }
    await applyPanelFault(parityFault, page);
    captured = await page.screenshot({ path: actualPath, animations: "disabled", caret: "hide", omitBackground: scene.captureType === "panel-only" });
    const expectedWidth = scene.pointWidth * 2;
    const expectedHeight = scene.pointHeight * 2;
    const actualSize = pngDimensions(captured);
    if (actualSize.width !== expectedWidth || actualSize.height !== expectedHeight) {
      throw new Error(`Capture dimensions ${actualSize.width}x${actualSize.height} do not match ${expectedWidth}x${expectedHeight}`);
    }
    const geometry = await browserGeometry(page);
    geometryErrors = await checkGeometry(scene, geometry);
    await writeFile(join(sceneRoot, "geometry.json"), JSON.stringify({ ...geometry, errors: geometryErrors }, null, 2));
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    if (page !== undefined) {
      await page.screenshot({ path: join(sceneRoot, "failure.png"), animations: "disabled", caret: "hide" }).catch(() => undefined);
    }
    await writeFile(join(sceneRoot, "server.log"), serverOutput.join(""));
  } finally {
    if (context !== undefined) await context.close();
    server.kill("SIGTERM");
    await waitForExit(server);
  }

  const comparisons = failure === null ? await compareScene(scene, sceneRoot, actualPath) : [];
  const status = failure === null && geometryErrors.length === 0 && comparisons.length > 0 && comparisons.every((comparison) => comparison.status === "pass")
    ? "pass"
    : "fail";
  const actualSHA256 = captured === undefined ? null : createHash("sha256").update(captured).digest("hex");
  const result = {
    sceneID: scene.id,
    oracleKinds: comparisons.map((comparison) => comparison.oracleKind),
    captureType: scene.captureType,
    pointWidth: scene.pointWidth,
    pointHeight: scene.pointHeight,
    backingScale: 2,
    pixelWidth: scene.pointWidth * 2,
    pixelHeight: scene.pointHeight * 2,
    sourceSet: scene.sourceSet,
    sourceHashes: sourceEvidence,
    status,
    failure,
    actual: relative(repositoryRoot, actualPath),
    actualSHA256,
    comparisons,
    geometryErrors,
  };
  await writeFile(join(sceneRoot, "scene.json"), JSON.stringify(result, null, 2));
  process.stdout.write(`${status.toUpperCase()} ${scene.id}${failure === null ? "" : `: ${failure}`}\n`);
  for (const error of geometryErrors) process.stdout.write(`  geometry: ${error}\n`);
  for (const comparison of comparisons) {
    process.stdout.write(`  ${comparison.oracleKind} ${comparison.reference}: ${comparison.aa.fullFrame.changedPixelPercent}% AA, ${comparison.raw.fullFrame.changedPixelPercent}% raw${comparison.status === "pass" ? "" : " (red)"}\n`);
  }
  return result;
}

async function applyFixtureFault(fault, vaultRoot) {
  if (fault === "wrong-note-source") {
    await writeFile(join(vaultRoot, "claude code is the inflection point.md"), "A different note was loaded.\n", "utf8");
  } else if (fault === "altered-image") {
    const imagePath = join(vaultRoot, "images", "claude code is the inflection point 20260728135304.heic");
    const bytes = await readFile(imagePath);
    await writeFile(imagePath, Buffer.concat([bytes, Buffer.from([0])]));
  }
}

async function applyCaptureFault(fault, page) {
  if (fault === "wrong-width") {
    const viewport = page.viewportSize();
    await page.setViewportSize({ width: viewport.width + 1, height: viewport.height });
  } else if (fault === "font-size") {
    await page.addStyleTag({ content: "#editor-mount .cm-content{font-size:48px!important}" });
  } else if (fault === "translation") {
    await page.addStyleTag({ content: ".app-shell{transform:translateX(2px)!important}" });
  }
}

async function applyPanelFault(fault, page) {
  if (fault === "modal-offset") {
    await page.addStyleTag({ content: ".overlay-host > .command-panel{left:18px!important}" });
  }
}

async function runActions(page, scene) {
  if (scene.actions.some((action) => action.kind === "prime-recent")) {
    await page.setViewportSize({ width: Math.max(scene.pointWidth, 900), height: Math.max(scene.pointHeight, 640) });
  }
  for (const action of scene.actions) {
    if (action.kind === "open-notes") {
      for (const name of action.names) await openNote(page, name);
    } else if (action.kind === "select-note") {
      await page.locator(`.tab[title="${escapeSelector(action.name)}"]`).click();
    } else if (action.kind === "pin-note") {
      await openCommand(page);
      await page.locator('.command-panel .command-row[data-command-id="pin"]').click();
    } else if (action.kind === "find") {
      await page.keyboard.press("Meta+f");
      const input = page.locator('[data-key="current-note-find"]');
      await input.waitFor({ state: "visible" });
      await input.fill(action.query);
      await page.waitForFunction((expected) => document.querySelector(".find-count")?.textContent === `1 of ${expected}`, action.expectedCount);
      if (action.close === true) await page.locator('[title="Close find"]').click();
    } else if (action.kind === "search") {
      if (await page.locator(".search-panel").count() === 0) await openSearch(page);
      const input = page.locator('[data-key="search-overlay"]');
      if (action.query !== "") {
        await input.fill(action.query);
        await waitForSearchResults(page, action.query);
        if (action.submit === true) await input.press("Enter");
      }
    } else if (action.kind === "search-history") {
      await openSearch(page);
      const input = page.locator('[data-key="search-overlay"]');
      await input.fill(action.query);
      await waitForSearchResults(page, action.query);
      await input.press("Enter");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.querySelector(".search-panel") === null);
      await openSearch(page);
      await page.waitForFunction((query) => document.querySelector(".search-history-row")?.textContent === query, action.query);
    } else if (action.kind === "open-command") {
      await openCommand(page);
    } else if (action.kind === "open-recent") {
      await page.keyboard.press("Meta+p");
      await page.locator(".quick-open-panel").waitFor({ state: "visible" });
      await page.locator(".quick-open-results .command-row").first().waitFor({ state: "visible" });
    } else if (action.kind === "rename") {
      await openCommand(page);
      await page.locator('.command-panel .command-row[data-command-id="rename"]').click();
      await page.locator(".note-dialog-panel").waitFor({ state: "visible" });
    } else if (action.kind === "prime-recent") {
      for (const name of action.names) {
        await openNote(page, name);
        if (action.pin.includes(name)) {
          await openCommand(page);
          await page.locator('.command-panel .command-row[data-command-id="pin"]').click();
        }
      }
      await page.locator(".tab").filter({ hasText: titleFromFile(action.selected) }).click();
      for (const name of action.names) {
        if (name !== action.selected) {
          await page.locator(".tab").filter({ hasText: titleFromFile(name) }).locator(".tab-close").click({ force: true });
          await page.waitForFunction((title) => ![...document.querySelectorAll(".tab")].some((tab) => tab.textContent?.includes(title)), titleFromFile(name));
        }
      }
    }
  }
  if (scene.actions.some((action) => action.kind === "prime-recent")) {
    await page.setViewportSize({ width: scene.pointWidth, height: scene.pointHeight });
  }
}

async function openNote(page, name) {
  await page.keyboard.press("Meta+p");
  const panel = page.locator(".quick-open-panel");
  await panel.waitFor({ state: "visible" });
  const input = panel.locator(".command-input");
  await input.fill(titleFromFile(name));
  const row = panel.locator(".quick-open-results .command-row").filter({ hasText: titleFromFile(name) }).first();
  await row.waitFor({ state: "visible" });
  await row.click();
  await page.waitForFunction((expected) => document.querySelector(".tab.active span:first-child")?.textContent === expected, titleFromFile(name));
  await page.waitForFunction(() => {
    const content = document.querySelector("#editor-mount .cm-content");
    return content instanceof HTMLElement && content.textContent?.trim() !== "";
  });
  const heading = page.locator("#editor-mount .cm-line.cm-atomic-h1").first();
  if (await heading.count() > 0) {
    const bounds = await heading.boundingBox();
    if (bounds !== null) await heading.click({ position: { x: 2, y: bounds.height / 2 } });
  }
}

async function openCommand(page) {
  await page.keyboard.press("Meta+k");
  await page.locator(".command-panel").waitFor({ state: "visible" });
}

async function openSearch(page) {
  await page.keyboard.press("Meta+Shift+f");
  await page.locator(".search-panel").waitFor({ state: "visible" });
}

async function waitForSearchResults(page, query) {
  await page.waitForFunction((expected) => {
    const input = document.querySelector("[data-key='search-overlay']");
    return input instanceof HTMLInputElement && input.value === expected &&
      (document.querySelectorAll(".search-result-row").length > 0 || document.querySelector(".empty-panel") !== null);
  }, query);
}

async function assertSceneState(page, scene) {
  if (scene.expectedActive !== undefined) {
    const active = await page.locator(".tab.active span:first-child").textContent();
    if (active !== titleFromFile(scene.expectedActive)) throw new Error(`Active tab is ${active}, expected ${scene.expectedActive}`);
  }
  if (scene.expectedOpen !== undefined) {
    const open = await page.locator(".tab span:first-child").allTextContents();
    const expected = scene.expectedOpen.map(titleFromFile);
    if (JSON.stringify(open) !== JSON.stringify(expected)) throw new Error(`Open tabs ${JSON.stringify(open)} do not match ${JSON.stringify(expected)}`);
  }
  if (scene.expectedText !== undefined) {
    const pageText = await page.locator("body").innerText();
    if (!pageText.includes(scene.expectedText)) throw new Error(`Expected visible text is missing: ${scene.expectedText}`);
  }
  if (scene.expectedSearchResultCount !== undefined) {
    const rows = page.locator(".search-result-row");
    await rows.nth(scene.expectedSearchResultCount - 1).waitFor({ state: "visible" });
    const count = await rows.count();
    if (count !== scene.expectedSearchResultCount) throw new Error(`Search returned ${count} rows, expected ${scene.expectedSearchResultCount}`);
  }
}

async function isolatePanel(page, scene) {
  const margin = scene.id === "rename-panel" ? 8 : 16;
  await page.addStyleTag({ content: `html,body,#app{width:${page.viewportSize().width}px;height:${page.viewportSize().height}px;background:transparent!important}#app>*:not(.overlay-host){visibility:hidden!important}.overlay-host{position:fixed!important;inset:0!important;background:transparent!important;pointer-events:none!important}.overlay-backdrop{display:none!important}.command-panel,.modal-panel{top:${margin}px!important;left:${margin}px!important;width:calc(100vw - ${margin * 2}px)!important;height:calc(100vh - ${margin * 2}px)!important;max-height:calc(100vh - ${margin * 2}px)!important;transform:none!important}` });
}

async function browserGeometry(page) {
  return await page.evaluate(() => {
    const frame = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        color: style.color,
        backgroundColor: style.backgroundColor,
      };
    };
    const content = document.querySelector("#editor-mount .cm-content");
    const line = document.querySelector("#editor-mount .cm-line");
    const heading = document.querySelector("#editor-mount .cm-line.cm-atomic-h1");
    const editor = document.querySelector("#editor-mount .cm-editor");
    const backdrop = document.querySelector(".overlay-backdrop");
    const lineRect = line?.getBoundingClientRect();
    const contentRect = content?.getBoundingClientRect();
    const firstTextRect = line instanceof HTMLElement && line.firstChild instanceof Text
      ? (() => {
        const range = document.createRange();
        range.selectNodeContents(line.firstChild);
        const rect = range.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })()
      : null;
    const findControls = Object.fromEntries(
      [".find-icon", ".find-input", ".find-count", ".find-previous", ".find-next", ".find-close"]
        .map((selector) => {
          const element = document.querySelector(selector);
          if (!(element instanceof HTMLElement)) return [selector, null];
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const before = getComputedStyle(element, "::before");
          return [selector, {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            display: style.display,
            before: {
              width: before.width,
              height: before.height,
              top: before.top,
              left: before.left,
              transform: before.transform,
              position: before.position,
            },
          }];
        }),
    );
    const outlineRows = [...document.querySelectorAll(".outline-row")].map((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        text: element.textContent,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        paddingTop: style.paddingTop,
        paddingBottom: style.paddingBottom,
      };
    });
    const searchResultRows = [...document.querySelectorAll(".search-panel .search-result-row")].map((element) => {
      const rect = element.getBoundingClientRect();
      const snippet = element.querySelector(".search-snippet");
      const snippetRect = snippet?.getBoundingClientRect();
      const snippetStyle = snippet === null ? null : getComputedStyle(snippet);
      return {
        title: element.querySelector(".search-result-title")?.textContent ?? null,
        text: element.textContent,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        snippet: snippetRect === undefined ? null : {
          x: snippetRect.x,
          y: snippetRect.y,
          width: snippetRect.width,
          height: snippetRect.height,
          lineHeight: snippetStyle?.lineHeight ?? null,
          whiteSpace: snippetStyle?.whiteSpace ?? null,
          lineClamp: snippetStyle?.webkitLineClamp ?? null,
        },
      };
    });
    const recentRows = [...document.querySelectorAll(".quick-open-results .command-row")].map((element) => {
      const rect = element.getBoundingClientRect();
      const title = element.querySelector(".recent-note-title");
      const detail = element.querySelector(".recent-note-detail");
      const titleRect = title?.getBoundingClientRect();
      const detailRect = detail?.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        text: element.textContent,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        gap: style.gap,
        title: titleRect === undefined ? null : { x: titleRect.x, y: titleRect.y, width: titleRect.width, height: titleRect.height },
        detail: detailRect === undefined ? null : { x: detailRect.x, y: detailRect.y, width: detailRect.width, height: detailRect.height },
      };
    });
    const tabItems = [...document.querySelectorAll(".tabs .tab")].map((element) => {
      const rect = element.getBoundingClientRect();
      const label = element.querySelector("span:first-child");
      const labelRect = label?.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        text: element.textContent,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        gap: style.gap,
        minWidth: style.minWidth,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        label: labelRect === undefined ? null : { x: labelRect.x, y: labelRect.y, width: labelRect.width, height: labelRect.height },
      };
    });
    return {
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      sidebar: frame(".sidebar"),
      sidebarTitle: frame(".outline-document-title"),
      topbar: frame(".topbar"),
      tabs: frame(".tabs"),
      activeTab: frame(".tab.active"),
      findBar: frame(".find-bar"),
      findControls,
      outlineDocumentTitle: frame(".outline-document-title"),
      outlineRows,
      searchResultRows,
      quickOpenResults: frame(".quick-open-results"),
      recentRows,
      tabItems,
      overlayBackdrop: backdrop instanceof HTMLElement ? {
        ...frame(".overlay-backdrop"),
        backdropFilter: getComputedStyle(backdrop).backdropFilter,
        webkitBackdropFilter: getComputedStyle(backdrop).webkitBackdropFilter,
      } : null,
      workspace: frame(".workspace"),
      editorMount: frame("#editor-mount"),
      editorContent: contentRect === undefined ? null : {
        x: contentRect.x,
        y: contentRect.y,
        width: contentRect.width,
        height: contentRect.height,
        paddingTop: getComputedStyle(content).paddingTop,
        paddingLeft: getComputedStyle(content).paddingLeft,
        fontFamily: getComputedStyle(content).fontFamily,
        fontSize: getComputedStyle(content).fontSize,
        lineHeight: getComputedStyle(content).lineHeight,
      },
      firstLine: lineRect === undefined ? null : { x: lineRect.x, y: lineRect.y, width: lineRect.width, height: lineRect.height },
      firstGlyph: firstTextRect,
      editorClassName: editor?.className ?? null,
      firstHeading: heading instanceof HTMLElement ? {
        text: heading.textContent,
        html: heading.innerHTML,
        rect: (() => {
          const rect = heading.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        })(),
      } : null,
      taskCheckboxes: [...document.querySelectorAll("#editor-mount .cm-atomic-task-checkbox")].map((input) => {
        const rect = input.getBoundingClientRect();
        const style = getComputedStyle(input);
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, color: style.color, backgroundColor: style.backgroundColor, border: style.border };
      }),
      table: frame("#editor-mount .cm-atomic-table table"),
      parityImageNames: Object.keys(JSON.parse(document.documentElement.dataset["nativeParityImageMap"] ?? "{}")),
      visibleEditorLines: [...document.querySelectorAll("#editor-mount .cm-line")].map((element) => element.textContent ?? "").slice(0, 24),
      images: [...document.querySelectorAll(".tansu-wiki-image img")].map((image) => ({
        name: image.dataset["imageName"] ?? null,
        src: image.src,
        complete: image.complete,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        width: image.getBoundingClientRect().width,
        height: image.getBoundingClientRect().height,
        x: image.getBoundingClientRect().x,
        y: image.getBoundingClientRect().y,
      })),
      overlay: frame(".overlay-host > .command-panel, .overlay-host > .modal-panel"),
      activeText: content?.textContent?.slice(0, 200) ?? null,
    };
  });
}

async function checkGeometry(scene, geometry) {
  const errors = [];
  if (scene.captureType === "panel-only") {
    if (geometry.overlay === null) return ["panel missing"];
    const margin = scene.id === "rename-panel" ? 8 : 16;
    const expectedWidth = scene.pointWidth - margin * 2;
    const expectedHeight = scene.pointHeight - margin * 2;
    if (Math.abs(geometry.overlay.x - margin) > 1) errors.push(`panel x ${geometry.overlay.x}pt differs from ${margin}pt`);
    if (Math.abs(geometry.overlay.y - margin) > 1) errors.push(`panel y ${geometry.overlay.y}pt differs from ${margin}pt`);
    if (Math.abs(geometry.overlay.width - expectedWidth) > 1) errors.push(`panel width ${geometry.overlay.width}pt differs from ${expectedWidth}pt`);
    if (Math.abs(geometry.overlay.height - expectedHeight) > 1) errors.push(`panel height ${geometry.overlay.height}pt differs from ${expectedHeight}pt`);
    return errors;
  }
  const sidebarWidth = scene.pointWidth < 540 ? 0 : 220;
  const expectedFrames = [
    ["topbar", { x: sidebarWidth, y: 0, width: scene.pointWidth - sidebarWidth, height: 62 }],
  ];
  if (scene.id !== "empty-900x640") {
      const findStripHeight = scene.actions.some((action) => action.kind === "find" && action.close !== true) ? 36 : 0;
      const editorTop = 62 + findStripHeight;
      expectedFrames.push(["editorMount", { x: sidebarWidth, y: editorTop, width: scene.pointWidth - sidebarWidth, height: scene.pointHeight - editorTop }]);
  }
  if (sidebarWidth > 0) expectedFrames.unshift(["sidebar", { x: 0, y: 0, width: sidebarWidth, height: scene.pointHeight }]);
  for (const [name, expected] of expectedFrames) {
    const actual = geometry[name];
    if (actual === null) {
      errors.push(`${name} missing`);
      continue;
    }
    for (const [field, value] of Object.entries(expected)) {
      const delta = Math.abs(actual[field] - value);
      if (delta > 1) errors.push(`${name}.${field} ${actual[field]} differs from ${value} by ${delta}pt`);
    }
  }
  if (scene.id !== "empty-900x640" && geometry.editorContent !== null) {
    const paddingLeft = Number.parseFloat(geometry.editorContent.paddingLeft);
    const paddingTop = Number.parseFloat(geometry.editorContent.paddingTop);
    if (Math.abs(paddingLeft - 39) > 1) errors.push(`text inset x ${paddingLeft}pt differs from 39pt`);
    if (Math.abs(paddingTop - 44) > 1) errors.push(`text inset y ${paddingTop}pt differs from 44pt`);
  }
  if (geometry.document.width > scene.pointWidth) errors.push(`document horizontal overflow ${geometry.document.width - scene.pointWidth}pt`);
  return errors;
}

async function compareScene(scene, sceneRoot, actualPath) {
  const pairs = [];
  const references = [];
  if (scene.nativeCurrent !== undefined) references.push({ oracleKind: "native-current", reference: join(corpusRoot, scene.nativeCurrent), referenceName: scene.nativeCurrent });
  if (scene.designTarget !== undefined) references.push({ oracleKind: "design-target", reference: join(corpusRoot, scene.designTarget), referenceName: scene.designTarget });
  if (scene.designPreview !== undefined) references.push({ oracleKind: "design-preview", reference: join(corpusRoot, scene.designPreview), referenceName: scene.designPreview });
  for (const pair of references) {
    const outputRoot = join(sceneRoot, "comparisons", pair.oracleKind);
    await mkdir(outputRoot, { recursive: true });
    const refDimensions = pngDimensions(await readFile(pair.reference));
    const actualDimensions = pngDimensions(await readFile(actualPath));
    const threshold = pair.oracleKind === "native-current" ? nativeGate(scene.id) : 1;
    const comparison = {
      oracleKind: pair.oracleKind,
      reference: relative(repositoryRoot, pair.reference),
      thresholdChangedPixelPercent: threshold,
      status: "fail",
      aa: { fullFrame: await runOdiff(pair.reference, actualPath, join(outputRoot, "diff-aa.png"), true) },
      raw: { fullFrame: await runOdiff(pair.reference, actualPath, join(outputRoot, "diff-raw.png"), false) },
      focusRegions: [],
    };
    if (refDimensions.width !== actualDimensions.width || refDimensions.height !== actualDimensions.height) {
      comparison.aa.fullFrame.error = `dimensions ${refDimensions.width}x${refDimensions.height} != ${actualDimensions.width}x${actualDimensions.height}`;
      comparison.raw.fullFrame.error = comparison.aa.fullFrame.error;
      comparison.status = "fail";
    } else {
      const regions = pair.oracleKind === "design-target" && scene.targetFocusRegionPx !== undefined
        ? [{ name: "design-focus", rectPx: scene.targetFocusRegionPx }]
        : pair.oracleKind === "native-current" && scene.captureType === "window-content"
        ? nativeRegions(scene)
        : [];
      for (const region of regions) {
        const result = await compareRegion(pair.reference, actualPath, outputRoot, region);
        comparison.focusRegions.push(result);
      }
      comparison.status = comparison.aa.fullFrame.error === null && comparison.aa.fullFrame.changedPixelPercent <= threshold &&
        comparison.focusRegions.every((region) => region.aa.changedPixelPercent <= (pair.oracleKind === "native-current" ? 10 : 1))
        ? "pass"
        : "fail";
      await makeOverlay(pair.reference, actualPath, join(outputRoot, "overlay.png"));
    }
    await writeFile(join(outputRoot, "score.json"), JSON.stringify(comparison, null, 2));
    pairs.push(comparison);
  }
  return pairs;
}

async function compareRegion(referencePath, actualPath, outputRoot, region) {
  const regionRoot = join(outputRoot, `roi-${region.name}`);
  await mkdir(regionRoot, { recursive: true });
  const referenceCrop = join(regionRoot, "reference.png");
  const actualCrop = join(regionRoot, "actual.png");
  cropPng(referencePath, referenceCrop, region.rectPx);
  cropPng(actualPath, actualCrop, region.rectPx);
  const aa = await runOdiff(referenceCrop, actualCrop, join(regionRoot, "diff-aa.png"), true);
  const raw = await runOdiff(referenceCrop, actualCrop, join(regionRoot, "diff-raw.png"), false);
  await makeOverlay(referenceCrop, actualCrop, join(regionRoot, "overlay.png"));
  return { name: region.name, rectPx: region.rectPx, aa, raw };
}

async function runOdiff(reference, actual, output, antialiasing) {
  const args = [reference, actual, output, "--threshold", "0.1", "--parsable-stdout"];
  if (antialiasing) args.push("--antialiasing");
  args.push("--fail-on-layout");
  const result = spawnSync("odiff", args, { encoding: "utf8" });
  const line = result.stdout.trim().split(/\r?\n/).at(-1) ?? "";
  const parsed = /^(\d+);([\d.]+)$/.exec(line);
  const changedPixelPercent = parsed === null ? result.status === 0 ? 0 : null : Number(parsed[2]);
  const changedPixels = parsed === null ? result.status === 0 ? 0 : null : Number(parsed[1]);
  return {
    changedPixels,
    changedPixelPercent,
    exitCode: result.status,
    error: result.status === 0 || result.status === 22 ? null : (result.stderr.trim() || result.stdout.trim() || `odiff exited ${result.status}`),
  };
}

async function makeOverlay(referencePath, actualPath, outputPath) {
  const reference = (await readFile(referencePath)).toString("base64");
  const actual = (await readFile(actualPath)).toString("base64");
  const page = await overlayPage;
  const dataURL = await page.evaluate(async ({ reference, actual }) => {
    const load = (source) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = source;
    });
    const [base, candidate] = await Promise.all([
      load(`data:image/png;base64,${reference}`),
      load(`data:image/png;base64,${actual}`),
    ]);
    if (base.width !== candidate.width || base.height !== candidate.height) return null;
    const canvas = document.createElement("canvas");
    canvas.width = base.width;
    canvas.height = base.height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas 2D context is unavailable");
    context.drawImage(base, 0, 0);
    context.globalAlpha = 0.5;
    context.drawImage(candidate, 0, 0);
    return canvas.toDataURL("image/png");
  }, { reference, actual });
  if (dataURL !== null) await writeFile(outputPath, Buffer.from(dataURL.slice("data:image/png;base64,".length), "base64"));
}

function nativeRegions(scene) {
  const width = scene.pointWidth * 2;
  const height = scene.pointHeight * 2;
  const sidebarWidth = scene.pointWidth < 540 ? 0 : 220 * 2;
  const topbarHeight = Math.min(62, scene.pointHeight) * 2;
  const editorX = scene.pointWidth < 540 ? 0 : 220 * 2;
  return [
    ...(sidebarWidth === 0 ? [] : [{ name: "sidebar", rectPx: [0, 96 * 2, sidebarWidth, Math.max(1, height - 96 * 2)] }]),
    { name: "tab-strip", rectPx: [editorX, 0, Math.max(1, width - editorX), topbarHeight] },
    { name: "editor-content", rectPx: [editorX, topbarHeight, Math.max(1, width - editorX), Math.max(1, height - topbarHeight)] },
  ].filter((region) => region.rectPx[0] + region.rectPx[2] <= width && region.rectPx[1] + region.rectPx[3] <= height);
}

function nativeGate(sceneID) {
  if (sceneID === "empty-900x640") return 3;
  if (sceneID.startsWith("chrome-")) return 6;
  return 6;
}

function cropPng(input, output, [x, y, width, height]) {
  const result = spawnSync("sips", ["-c", String(height), String(width), "--cropOffset", String(y), String(x), input, "--out", output], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`sips crop failed: ${result.stderr || result.stdout}`);
}

async function verifySceneSource(scene, vaultRoot) {
  const expected = manifest.sourceFiles.filter((file) => file.relativePath.startsWith(`${scene.sourceSet}/`));
  const sourceRoot = join(corpusRoot, "source-fixtures", scene.sourceSet);
  const copied = await fileList(vaultRoot);
  const sourceEvidence = [];
  for (const file of expected) {
    const localPath = file.relativePath.slice(scene.sourceSet.length + 1);
    if (!copied.includes(localPath)) continue;
    const bytes = await readFile(join(vaultRoot, localPath));
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== file.sha256) throw new Error(`Fixture source hash changed for ${file.relativePath}`);
    sourceEvidence.push({ relativePath: file.relativePath, sha256: actual, bytes: bytes.byteLength });
  }
  if (scene.sourceSet !== "empty" && sourceEvidence.length === 0) throw new Error(`No fixture files were copied for ${scene.id}`);
  return sourceEvidence;
}

async function fileList(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Fixture tree contains a symlink: ${path}`);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(relative(root, path).replaceAll("\\", "/"));
      else throw new Error(`Fixture tree contains a special file: ${path}`);
    }
  }
  return files.sort();
}

async function waitForHealth(baseURL, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited before health check with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseURL}/api/v2/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
    }
  }
  throw new Error("Timed out waiting for isolated Tansu2 server health");
}

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolveListen, reject) => socket.listen(0, "127.0.0.1", resolveListen).once("error", reject));
  const port = socket.address().port;
  await new Promise((resolveClose) => socket.close(resolveClose));
  return port;
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!await waitForExitEvent(child, 2_000)) {
    child.kill("SIGKILL");
    if (child.exitCode === null && child.signalCode === null && !await waitForExitEvent(child, 2_000)) {
      throw new Error(`Isolated server process ${child.pid} did not exit after SIGKILL`);
    }
  }
}

function waitForExitEvent(child, timeoutMs) {
  return new Promise((resolveExit) => {
    const timeout = setTimeout(() => resolveExit(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveExit(true);
    });
  });
}

async function waitForPaint(page) {
  await page.evaluate(() => new Promise((resolvePaint) => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))));
}

function pngDimensions(bytes) {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47) throw new Error("Screenshot is not a PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function titleFromFile(name) {
  return name.replace(/\.md$/i, "");
}

function escapeSelector(value) {
  return value.replaceAll('"', '\\"');
}

async function writeIndex(root, scenes) {
  const rows = scenes.map((scene) => {
    const comparisons = scene.comparisons.map((comparison) => {
      const reference = relative(root, join(repositoryRoot, comparison.reference));
      const overlay = relative(root, join(root, scene.sceneID, "comparisons", comparison.oracleKind, "overlay.png"));
      const diff = relative(root, join(root, scene.sceneID, "comparisons", comparison.oracleKind, "diff-aa.png"));
      return `<section><h3>${escapeHTML(comparison.oracleKind)} — ${escapeHTML(comparison.reference)}</h3><p>${escapeHTML(comparison.status)} · AA ${escapeHTML(String(comparison.aa.fullFrame.changedPixelPercent))}% · raw ${escapeHTML(String(comparison.raw.fullFrame.changedPixelPercent))}%</p><a href="${escapeHTML(reference)}"><img src="${escapeHTML(reference)}"></a><a href="${escapeHTML(overlay)}"><img src="${escapeHTML(overlay)}"></a><a href="${escapeHTML(diff)}"><img src="${escapeHTML(diff)}"></a></section>`;
    }).join("");
    const actual = relative(root, join(root, scene.sceneID, "actual.png"));
    return `<article><h2>${escapeHTML(scene.sceneID)} · ${escapeHTML(scene.status)}</h2><p>${scene.pixelWidth}×${scene.pixelHeight} px · ${escapeHTML(scene.captureType)}</p><img src="${escapeHTML(actual)}">${comparisons}</article>`;
  }).join("");
  await writeFile(join(root, "index.html"), `<!doctype html><html><meta charset="utf-8"><title>Tansu2 native visual parity ${escapeHTML(runID)}</title><style>body{font:14px system-ui;margin:24px;background:#eee}article{background:white;margin:24px 0;padding:20px}img{max-width:44vw;vertical-align:top;margin:4px}section{display:inline-block;max-width:48%;vertical-align:top}h2{margin:0}</style><h1>Native visual parity ${escapeHTML(runID)}</h1>${rows}</html>`, "utf8");
}

function escapeHTML(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
