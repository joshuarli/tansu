import type {
  DownloadReaderFixturesResponse,
  ListExtractorsResponse,
  LoupeParsedPage,
  ContentScriptMessage,
  ParsePageResponse,
} from "./extension-messages.ts";
import type { SendToTansuResponse } from "./tansu-schemas.ts";
import { describeTansuResponse, type TansuStatus } from "./tansu-status.ts";
import { createPageToast } from "./page-toast.ts";
import { getErrorMessage, logLoupeError } from "./error-logging.ts";
import { sanitizeDownloadFilename } from "./download-filename.ts";
import { assertPageSnapshotWithinLimit } from "./page-snapshot.ts";
import { serializeReaderUi } from "./reader-fixture.ts";
import { createReaderMarkdownFromPage } from "./reader-markdown.ts";
import { formatPublishedDate } from "./published-date.ts";
import readerOverlayStyles from "./reader-overlay.css?raw";
import readerOverlayMarkup from "./reader-overlay.html?raw";
import {
  createObsidianImportUri,
  createObsidianLoupeImportUri,
  sha256HexOfText,
} from "./obsidian-uri.ts";

const READER_HOST_ELEMENT_ID_PREFIX = "loupe-reader-host",
  READER_HOST_ELEMENT_ID = `${READER_HOST_ELEMENT_ID_PREFIX}-${crypto.randomUUID()}`,
  READER_PARSE_TIMEOUT_MS = 30_000;

let cachedPageUrl: string | undefined,
  cachedParsedPage: LoupeParsedPage | undefined,
  pageScrollOverflowStyles: { documentElement: string; body: string } | undefined,
  readerArticleElement: HTMLElement | undefined,
  readerContainerElement: HTMLDivElement | undefined,
  readerContentLoadInProgress = false,
  readerHeadingVisibilityObserver: IntersectionObserver | undefined,
  readerHostElement: HTMLDivElement | undefined,
  readerMenuElement: HTMLDivElement | undefined,
  readerMenuToggleElement: HTMLButtonElement | undefined,
  readerOutlineNavigationElement: HTMLElement | undefined,
  readerErrorPageUrl: string | undefined,
  readerStatusElement: HTMLElement | undefined,
  selectedExtractorName = "";
const copyFeedbackTimeouts = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>();
let activeReaderHeadingId: string | undefined,
  readerStatusClearTimeout: ReturnType<typeof setTimeout> | undefined;
const intersectingReaderHeadingIds = new Set<string>();

chrome.runtime.onMessage.addListener((message: ContentScriptMessage) => {
  if (message.action === "toggle") {
    void toggleReaderVisibility();
  } else if (message.action === "sendPageToTansu") {
    const toast = createPageToast();
    void sendPageToTansu(
      (status) => toast.show(status.text, toastAction(status), status.action ? 10_000 : 4_000),
      true,
    );
  }
});

window.addEventListener("popstate", invalidateCachedReaderPage);
window.addEventListener("hashchange", invalidateCachedReaderPage);

async function toggleReaderVisibility(): Promise<void> {
  if (readerContentLoadInProgress) {
    return;
  }
  if (cachedPageUrl !== undefined && cachedPageUrl !== document.URL) {
    invalidateCachedReaderPage();
  }
  if (readerHostElement && cachedParsedPage) {
    readerHostElement.hidden = !readerHostElement.hidden;
    setPageScrollLock(!readerHostElement.hidden);
    return;
  }
  if (
    readerHostElement &&
    !readerHostElement.hidden &&
    readerErrorPageUrl === document.URL
  ) {
    readerHostElement.hidden = true;
    setPageScrollLock(false);
    return;
  }
  await loadReaderContent();
}

async function loadReaderContent(): Promise<void> {
  if (readerContentLoadInProgress) {
    return;
  }
  readerContentLoadInProgress = true;
  ensureReaderOverlay();
  readerContainerElement!.classList.add("loupe-reader-busy");
  readerHostElement!.hidden = false;
  setPageScrollLock(true);

  try {
    const requestedExtractorName = selectedExtractorName;
    cachedParsedPage = await requestValidatedParsedPage();
    cachedPageUrl = document.URL;
    readerErrorPageUrl = undefined;
    if (!requestedExtractorName) {
      selectedExtractorName = cachedParsedPage.extractor_type ?? "";
      syncSelectedExtractorName();
    }
    renderParsedReaderContent(cachedParsedPage);
  } catch (error) {
    cachedParsedPage = undefined;
    cachedPageUrl = undefined;
    readerErrorPageUrl = document.URL;
    setPageScrollLock(false);
    logLoupeError("Loupe could not load the page", error, { pageUrl: document.URL });
    renderReaderError(getErrorMessage(error));
  } finally {
    readerContentLoadInProgress = false;
    readerContainerElement!.classList.remove("loupe-reader-busy");
  }
}

async function requestValidatedParsedPage(): Promise<LoupeParsedPage> {
  const requestedPageUrl = document.URL,
    parsePageResponse = await requestParsedPage();
  if (document.URL !== requestedPageUrl) {
    throw new Error("The page changed while Loupe was reading it. Try again.");
  }
  if (!parsePageResponse.ok || !parsePageResponse.parsedPage) {
    throw new Error(parsePageResponse.error || "Loupe could not extract readable content.");
  }
  if (!parsePageResponse.parsedPage.content.trim()) {
    throw new Error("Loupe could not find readable content on this page.");
  }
  return parsePageResponse.parsedPage;
}

async function ensureParsedPage(): Promise<LoupeParsedPage> {
  if (cachedParsedPage && cachedPageUrl === document.URL) {
    return cachedParsedPage;
  }
  const parsedPage = await requestValidatedParsedPage();
  cachedParsedPage = parsedPage;
  cachedPageUrl = document.URL;
  return parsedPage;
}

function invalidateCachedReaderPage(): void {
  if (cachedPageUrl === undefined || cachedPageUrl === document.URL) {
    return;
  }
  cachedParsedPage = undefined;
  cachedPageUrl = undefined;
  selectedExtractorName = "";
  readerHeadingVisibilityObserver?.disconnect();
  readerHeadingVisibilityObserver = undefined;
  activeReaderHeadingId = undefined;
  intersectingReaderHeadingIds.clear();
}

function syncSelectedExtractorName(): void {
  const extractorSelectElement = readerHostElement?.shadowRoot?.querySelector<HTMLSelectElement>(
    '[data-action="extractor"]',
  );
  if (extractorSelectElement) {
    extractorSelectElement.value = selectedExtractorName;
  }
}

async function requestParsedPage(): Promise<ParsePageResponse> {
  const parsePageRequest = chrome.runtime.sendMessage({
    action: "parsePage",
    pageHtml: snapshotCurrentPageHtml(),
    pageUrl: document.URL,
    extractorName: selectedExtractorName,
  }) as Promise<ParsePageResponse>;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error("Loupe took too long to read this page."));
    }, READER_PARSE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([parsePageRequest, timeout]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

function ensureReaderOverlay(): void {
  if (readerHostElement) {
    return;
  }

  readerHostElement = document.createElement("div");
  readerHostElement.id = READER_HOST_ELEMENT_ID;
  readerHostElement.setAttribute("role", "dialog");
  readerHostElement.setAttribute("aria-modal", "true");
  readerHostElement.setAttribute("aria-label", "Loupe reader");
  readerHostElement.style.cssText = "position:fixed;inset:0;z-index:2147483647";
  const readerShadowRoot = readerHostElement.attachShadow({ mode: "open" });
  readerShadowRoot.innerHTML = `<style>${readerOverlayStyles}</style>${readerOverlayMarkup}`;

  readerArticleElement = readerShadowRoot.querySelector("article")!;
  readerOutlineNavigationElement = readerShadowRoot.querySelector(".loupe-reader-outline")!;
  readerMenuToggleElement = readerShadowRoot.querySelector<HTMLButtonElement>(
    '[data-action="menu-toggle"]',
  )!;
  readerMenuElement = readerShadowRoot.querySelector<HTMLDivElement>(".loupe-reader-menu")!;
  readerStatusElement = readerShadowRoot.querySelector(".loupe-reader-status")!;
  readerContainerElement = readerShadowRoot.querySelector<HTMLDivElement>(".loupe-reader")!;
  readerMenuToggleElement.addEventListener("click", () => {
    setReaderMenuOpen(Boolean(readerMenuElement!.hidden));
  });
  readerShadowRoot
    .querySelector<HTMLButtonElement>('[data-action="tansu"]')!
    .addEventListener("click", () => {
      void sendPageToTansu(showReaderTansuStatus, false);
    });
  readerShadowRoot
    .querySelector<HTMLButtonElement>('[data-action="obsidian"]')!
    .addEventListener("click", () => {
      void openReaderMarkdownInObsidian(
        getReaderMarkdown(),
        cachedParsedPage?.title || document.title || document.URL,
      );
    });
  const markdownCopyButton = readerShadowRoot.querySelector<HTMLButtonElement>(
    '[data-action="markdown"]',
  )!;
  markdownCopyButton.addEventListener("click", () => {
    void copyReaderTextToClipboard(getReaderMarkdown(), "Markdown").then((copied) => {
      if (copied) {
        showReaderCopySuccess(markdownCopyButton);
        setReaderStatusMessage("Markdown copied.");
      } else {
        setReaderStatusMessage("Could not copy Markdown.");
      }
    });
  });
  const htmlCopyButton = readerShadowRoot.querySelector<HTMLButtonElement>('[data-action="html"]')!;
  htmlCopyButton.addEventListener("click", () => {
    void copyReaderTextToClipboard(cachedParsedPage?.content || "", "HTML").then((copied) => {
      if (copied) {
        showReaderCopySuccess(htmlCopyButton);
        setReaderStatusMessage("HTML copied.");
      } else {
        setReaderStatusMessage("Could not copy HTML.");
      }
    });
  });
  readerShadowRoot
    .querySelector<HTMLButtonElement>('[data-action="download-fixtures"]')!
    .addEventListener("click", () => {
      void downloadReaderFixtureBundle();
    });
  readerShadowRoot
    .querySelector<HTMLSelectElement>('[data-action="extractor"]')!
    .addEventListener("change", (event) => {
      selectedExtractorName = (event.target as HTMLSelectElement).value;
      void loadReaderContent();
    });
  document.documentElement.append(readerHostElement);
  document.addEventListener("pointerdown", handleReaderMenuOutsidePointerDown);
  document.addEventListener("keydown", handleReaderMenuEscapeKeyDown);
  void populateExtractorSelect(
    readerShadowRoot.querySelector<HTMLSelectElement>('[data-action="extractor"]')!,
  );
}

function setReaderMenuOpen(open: boolean): void {
  if (!readerMenuElement || !readerMenuToggleElement) return;
  readerMenuElement.hidden = !open;
  readerMenuToggleElement.setAttribute("aria-expanded", String(open));
  if (open) {
    readerMenuElement.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  } else {
    readerMenuToggleElement.focus();
  }
}

function handleReaderMenuOutsidePointerDown(event: PointerEvent): void {
  if (!readerMenuElement || readerMenuElement.hidden) return;
  const eventPath = event.composedPath();
  if (eventPath.includes(readerMenuElement) || eventPath.includes(readerMenuToggleElement!)) {
    return;
  }
  setReaderMenuOpen(false);
}

function handleReaderMenuEscapeKeyDown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || !readerMenuElement || readerMenuElement.hidden) return;
  event.preventDefault();
  setReaderMenuOpen(false);
}

function setPageScrollLock(locked: boolean): void {
  if (locked) {
    if (pageScrollOverflowStyles) {
      return;
    }
    pageScrollOverflowStyles = {
      documentElement: document.documentElement.style.overflow,
      body: document.body?.style.overflow || "",
    };
    document.documentElement.style.overflow = "hidden";
    if (document.body) {
      document.body.style.overflow = "hidden";
    }
    return;
  }

  if (!pageScrollOverflowStyles) {
    return;
  }
  document.documentElement.style.overflow = pageScrollOverflowStyles.documentElement;
  if (document.body) {
    document.body.style.overflow = pageScrollOverflowStyles.body;
  }
  pageScrollOverflowStyles = undefined;
}

async function populateExtractorSelect(extractorSelectElement: HTMLSelectElement): Promise<void> {
  try {
    const extractorListResponse = (await chrome.runtime.sendMessage({
      action: "listExtractors",
    })) as ListExtractorsResponse;
    if (!extractorListResponse.extractorNames) return;

    for (const extractorName of extractorListResponse.extractorNames) {
      const option = document.createElement("option");
      option.value = extractorName;
      option.textContent = getExtractorDisplayLabel(extractorName);
      extractorSelectElement.append(option);
    }
    extractorSelectElement.value = selectedExtractorName;
  } catch (error) {
    logLoupeError("Loupe could not list extractors", error);
    // Leave Default-only options on error
  }
}

function getExtractorDisplayLabel(extractorName: string): string {
  const labels: Record<string, string> = {
    hackernews: "Hacker News",
    reddit: "Reddit",
    github: "GitHub",
    chatgpt: "ChatGPT",
    substack: "Substack",
    mastodon: "Mastodon",
    twitter: "Twitter / X",
  };
  return labels[extractorName] ?? extractorName;
}

function snapshotCurrentPageHtml(): string {
  const existingReaderHostElement = readerHostElement;
  existingReaderHostElement?.remove();
  try {
    const pageHtml = document.documentElement.outerHTML;
    assertPageSnapshotWithinLimit(pageHtml);
    return pageHtml;
  } finally {
    if (existingReaderHostElement) {
      document.documentElement.append(existingReaderHostElement);
    }
  }
}

interface ReaderOutlineItem {
  headingId: string;
  headingLabel: string;
  depth: number;
}

function buildReaderOutlineItems(headings: HTMLHeadingElement[]): ReaderOutlineItem[] {
  const outlineItems: ReaderOutlineItem[] = [],
    headingIds = new Set<string>();

  for (const heading of headings) {
    const level = Math.trunc(Number(heading.tagName.charAt(1)));
    if (level === 1) continue;

    let headingId = heading.id;
    if (!headingId || headingIds.has(headingId)) {
      const base =
        heading.textContent
          ?.trim()
          .toLowerCase()
          .replaceAll(/[^a-z0-9]+/g, "-")
          .replaceAll(/^-|-$/g, "") || "heading";
      headingId = base;
      let suffix = 0;
      while (headingIds.has(headingId)) {
        suffix++;
        headingId = `${base}-${suffix}`;
      }
      heading.id = headingId;
    }
    headingIds.add(headingId);
    outlineItems.push({
      headingId,
      headingLabel: heading.textContent?.trim() || "",
      depth: Math.min(level - 2, 4),
    });
  }

  return outlineItems;
}

function renderReaderOutline(outlineItems: ReaderOutlineItem[]): void {
  readerOutlineNavigationElement!.replaceChildren();
  activeReaderHeadingId = undefined;
  intersectingReaderHeadingIds.clear();

  if (outlineItems.length === 0) {
    const emptyState = document.createElement("p");
    emptyState.className = "loupe-reader-outline-empty";
    emptyState.textContent = "Headings in this article will appear here.";
    readerOutlineNavigationElement!.append(emptyState);
    return;
  }

  const hostElement = readerHostElement!;
  for (const outlineItem of outlineItems) {
    const outlineButton = document.createElement("button");
    outlineButton.type = "button";
    outlineButton.className = "loupe-reader-outline-item";
    outlineButton.dataset["depth"] = String(outlineItem.depth);
    outlineButton.textContent = outlineItem.headingLabel || "Untitled heading";
    outlineButton.dataset["headingId"] = outlineItem.headingId;
    outlineButton.setAttribute("aria-label", outlineItem.headingLabel || "Untitled heading");
    const targetHeadingId = outlineItem.headingId;
    outlineButton.addEventListener("click", () => {
      hostElement
        .shadowRoot!.querySelector(`#${CSS.escape(targetHeadingId)}`)
        ?.scrollIntoView({ behavior: "smooth" });
    });
    readerOutlineNavigationElement!.append(outlineButton);
  }
}

function observeReaderHeadingVisibility(headings: HTMLHeadingElement[]): void {
  readerHeadingVisibilityObserver?.disconnect();

  readerHeadingVisibilityObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          intersectingReaderHeadingIds.add(entry.target.id);
        } else {
          intersectingReaderHeadingIds.delete(entry.target.id);
        }
      }
      const nextActiveHeading = headings.findLast((heading) =>
        intersectingReaderHeadingIds.has(heading.id),
      );
      if (nextActiveHeading) {
        setActiveReaderHeading(nextActiveHeading.id);
      }
    },
    { rootMargin: "-80px 0px -75% 0px", threshold: 0 },
  );

  for (const heading of headings) {
    if (heading.id) {
      readerHeadingVisibilityObserver.observe(heading);
    }
  }
}

function setActiveReaderHeading(headingId: string): void {
  if (activeReaderHeadingId === headingId) return;
  activeReaderHeadingId = headingId;

  const activeItem = [
    ...readerOutlineNavigationElement!.querySelectorAll<HTMLElement>("[data-heading-id]"),
  ].find((outlineItem) => outlineItem.dataset["headingId"] === headingId);
  for (const outlineItem of readerOutlineNavigationElement!.querySelectorAll(
    ".loupe-reader-outline-item",
  )) {
    const isActive = outlineItem === activeItem;
    outlineItem.classList.toggle("active", isActive);
    if (isActive) {
      outlineItem.setAttribute("aria-current", "location");
      outlineItem.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else {
      outlineItem.removeAttribute("aria-current");
    }
  }
}

function renderParsedReaderContent(parsedPage: LoupeParsedPage): void {
  readerArticleElement!.innerHTML = parsedPage.content;

  const title = document.createElement("h1");
  title.textContent = parsedPage.title || document.title || "Loupe";
  if (readerArticleElement!.firstElementChild?.tagName === "H1") {
    readerArticleElement!.firstElementChild.replaceWith(title);
  } else {
    readerArticleElement!.prepend(title);
  }

  const bylineParts: string[] = [];
  if (parsedPage.author) bylineParts.push(parsedPage.author);
  if (parsedPage.published) bylineParts.push(formatPublishedDate(parsedPage.published));
  if (parsedPage.domain) bylineParts.push(parsedPage.domain);

  let lastMetadataElement: HTMLElement = title;

  if (parsedPage.description) {
    const descriptionElement = document.createElement("p");
    descriptionElement.className = "loupe-description";
    descriptionElement.textContent = parsedPage.description;
    lastMetadataElement.after(descriptionElement);
    lastMetadataElement = descriptionElement;
  }

  if (bylineParts.length > 0) {
    const bylineElement = document.createElement("p");
    bylineElement.className = "loupe-byline";
    bylineElement.textContent = bylineParts.join(" · ");
    lastMetadataElement.after(bylineElement);
  }

  const readerHeadings =
      readerArticleElement!.querySelectorAll<HTMLHeadingElement>("h1, h2, h3, h4, h5, h6"),
    outlineItems = buildReaderOutlineItems([...readerHeadings]);
  renderReaderOutline(outlineItems);
  observeReaderHeadingVisibility([...readerHeadings]);
}

function renderReaderError(errorMessage: string): void {
  readerArticleElement!.replaceChildren();
  readerOutlineNavigationElement!.replaceChildren();
  readerHeadingVisibilityObserver?.disconnect();
  const title = document.createElement("h1");
  title.textContent = "Loupe could not read this page";
  const errorDetailsElement = document.createElement("p");
  errorDetailsElement.textContent = errorMessage;
  readerArticleElement!.append(title, errorDetailsElement);
}

async function copyReaderTextToClipboard(
  readerText: string,
  contentTypeLabel: string,
): Promise<boolean> {
  if (!readerText) {
    console.error(`No ${contentTypeLabel} is available.`);
    return false;
  }
  return writeClipboardText(readerText, contentTypeLabel);
}

function showReaderCopySuccess(copyButton: HTMLButtonElement): void {
  copyButton.classList.add("loupe-copy-success");
  const existingFeedbackTimeout = copyFeedbackTimeouts.get(copyButton);
  if (existingFeedbackTimeout !== undefined) clearTimeout(existingFeedbackTimeout);
  copyFeedbackTimeouts.set(
    copyButton,
    setTimeout(() => {
      copyButton.classList.remove("loupe-copy-success");
      copyFeedbackTimeouts.delete(copyButton);
    }, 900),
  );
}

function setReaderStatusMessage(statusMessage: string, durationMs = 3000): void {
  if (!readerStatusElement) return;
  readerStatusActionElement(readerStatusElement).hidden = true;
  if (readerStatusClearTimeout !== undefined) {
    clearTimeout(readerStatusClearTimeout);
  }
  readerStatusElement.textContent = statusMessage;
  if (statusMessage) {
    readerStatusClearTimeout = setTimeout(() => {
      readerStatusElement!.textContent = "";
      readerStatusActionElement(readerStatusElement!).hidden = true;
      readerStatusClearTimeout = undefined;
    }, durationMs);
  } else {
    readerStatusClearTimeout = undefined;
  }
}

async function writeClipboardText(
  clipboardText: string,
  contentTypeLabel: string,
): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(clipboardText);
    return true;
  } catch (error) {
    logLoupeError(`Loupe could not copy ${contentTypeLabel}`, error);
    const textarea = document.createElement("textarea");
    textarea.value = clipboardText;
    textarea.style.cssText = "position:fixed;opacity:0";
    document.body.append(textarea);
    textarea.select();
    if (!document.execCommand("copy")) {
      textarea.remove();
      console.error(`Could not copy ${contentTypeLabel}.`);
      return false;
    }
    textarea.remove();
    return true;
  }
}

async function openReaderMarkdownInObsidian(
  readerMarkdown: string,
  noteName: string,
): Promise<void> {
  if (!readerMarkdown) {
    console.error("No Markdown is available.");
    return;
  }
  const copied = await writeClipboardText(readerMarkdown, "Markdown");
  let obsidianUri: string,
    usesLoupeImport = false;
  if (copied) {
    try {
      obsidianUri = createObsidianLoupeImportUri(
        noteName,
        document.URL,
        await sha256HexOfText(readerMarkdown),
      );
      usesLoupeImport = true;
    } catch (error) {
      logLoupeError("Loupe could not prepare the Obsidian import", error);
      obsidianUri = createObsidianImportUri(readerMarkdown, noteName);
    }
  } else {
    obsidianUri = createObsidianImportUri(readerMarkdown, noteName);
  }
  setReaderStatusMessage(
    usesLoupeImport
      ? "Opening in Obsidian; image import will continue there…"
      : "Opening in Obsidian…",
  );
  try {
    const openObsidianResponse = await chrome.runtime.sendMessage({
      action: "openObsidian",
      obsidianUrl: obsidianUri,
    });
    if (!openObsidianResponse?.ok) {
      throw new Error(openObsidianResponse?.error || "The Obsidian URL could not be opened.");
    }
  } catch (error) {
    logLoupeError("Loupe could not open Obsidian", error);
    window.location.href = obsidianUri;
  }
}

function readerStatusActionElement(statusElement: HTMLElement): HTMLButtonElement {
  return statusElement.parentElement!.querySelector<HTMLButtonElement>(
    '[data-action="status-action"]',
  )!;
}

function runTansuStatusAction(kind: "open-note" | "open-options"): void {
  void chrome.runtime
    .sendMessage({ action: kind === "open-note" ? "openTansuTab" : "openOptions" })
    .catch((error: unknown) => logLoupeError("Loupe could not open Tansu", error, { kind }));
}

function toastAction(status: TansuStatus): { label: string; run: () => void } | undefined {
  const action = status.action;
  return action ? { label: action.label, run: () => runTansuStatusAction(action.kind) } : undefined;
}

function showReaderTansuStatus(status: TansuStatus): void {
  setReaderStatusMessage(status.text, status.action ? 10_000 : 3000);
  const action = status.action;
  if (!action || !readerStatusElement) return;
  const button = readerStatusActionElement(readerStatusElement);
  button.textContent = action.label;
  button.hidden = false;
  button.onclick = () => runTansuStatusAction(action.kind);
}

let tansuSendInProgress = false;

async function sendPageToTansu(
  report: (status: TansuStatus) => void,
  openOptionsWhenUnconfigured: boolean,
): Promise<void> {
  if (tansuSendInProgress) {
    return;
  }
  tansuSendInProgress = true;
  report({ text: "Sending to Tansu…" });
  try {
    const parsedPage = await ensureParsedPage(),
      markdown = getReaderMarkdown(),
      response = (await chrome.runtime.sendMessage({
        action: "sendToTansu",
        title: parsedPage.title || document.title || document.URL,
        markdown,
        sourceUrl: document.URL,
      })) as SendToTansuResponse | undefined;
    if (!response) {
      throw new Error("No response from the service worker.");
    }
    report(describeTansuResponse(response));
    if (!response.ok && response.reason === "not-configured" && openOptionsWhenUnconfigured) {
      runTansuStatusAction("open-options");
    }
  } catch (error) {
    logLoupeError("Loupe could not send to Tansu", error);
    report({ text: `Could not send to Tansu: ${getErrorMessage(error)}` });
  } finally {
    tansuSendInProgress = false;
  }
}

function getReaderMarkdown(): string {
  if (!cachedParsedPage) {
    return "";
  }
  return createReaderMarkdownFromPage(
    cachedParsedPage.content_markdown || "",
    cachedParsedPage,
    document.URL,
    document.title || document.URL,
  );
}

async function downloadReaderFixtureBundle(): Promise<void> {
  try {
    setReaderStatusMessage("Preparing fixture downloads…");
    const rawPageHtml = snapshotCurrentPageHtml();
    if (!cachedParsedPage || !rawPageHtml) return;
    const readerTitle = cachedParsedPage.title || document.title || document.URL,
      downloadSlug = sanitizeDownloadFilename(document.title || document.URL),
      downloadReaderFixturesResponse = (await chrome.runtime.sendMessage({
        action: "downloadFixtures",
        rawPageHtml,
        extractedContentHtml: cachedParsedPage.content,
        extractedContentMarkdown: getReaderMarkdown(),
        readerUiHtml: serializeReaderUi(
          readerHostElement!.shadowRoot!,
          readerTitle,
          READER_HOST_ELEMENT_ID,
        ),
        downloadSlug,
        extractorName: selectedExtractorName,
      })) as DownloadReaderFixturesResponse | undefined;
    if (!downloadReaderFixturesResponse) {
      throw new Error("Download failed: no response from the service worker.");
    }
    if (!downloadReaderFixturesResponse.ok) {
      throw new Error(downloadReaderFixturesResponse.error || "Download failed.");
    }
    setReaderStatusMessage("Fixtures downloaded.");
  } catch (error) {
    logLoupeError("Loupe could not download fixtures", error, {
      downloadSlug: sanitizeDownloadFilename(document.title || document.URL),
      extractorName: selectedExtractorName,
    });
    setReaderStatusMessage("Could not download fixtures.");
  }
}
