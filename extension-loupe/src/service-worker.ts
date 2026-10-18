import type {
  ContentScriptMessage,
  DownloadReaderFixturesRequest,
  DownloadReaderFixturesResponse,
  ListExtractorsResponse,
  OpenObsidianUrlResponse,
  ParsePageResponse,
  ServiceWorkerRequest,
} from "./extension-messages.ts";
import { getErrorMessage, logLoupeError } from "./error-logging.ts";
import { sanitizeDownloadFilename } from "./download-filename.ts";
import { runFocusTansuTab, runSendToTansu } from "./tansu-send.ts";
import { listWasmExtractors, parsePageWithWasm } from "./defuddle-wasm-client.ts";

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) {
    return;
  }

  try {
    await sendMessageToContentScript(tab.id, tab.url, { action: "toggle" });
  } catch (error) {
    logLoupeError("Loupe could not access the current tab", error, {
      tabId: tab.id,
      tabUrl: tab.url,
    });
    await chrome.action.setTitle({ tabId: tab.id, title: "Loupe is unavailable on this page" });
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "send-to-tansu" || !tab?.id) {
    return;
  }

  try {
    await sendMessageToContentScript(tab.id, tab.url, { action: "sendPageToTansu" });
  } catch (error) {
    logLoupeError("Loupe could not send the page to Tansu", error, {
      tabId: tab.id,
      tabUrl: tab.url,
    });
    await chrome.action.setBadgeText({ tabId: tab.id, text: "!" });
    await chrome.action.setTitle({ tabId: tab.id, title: "Loupe is unavailable on this page" });
  }
});

chrome.runtime.onMessage.addListener((request: ServiceWorkerRequest, sender, sendResponse) => {
  if (request.action === "listExtractors") {
    void listWasmExtractors()
      .then((extractorNames): ListExtractorsResponse => ({ extractorNames }))
      .then(sendResponse)
      .catch((error) => {
        logLoupeError("Loupe could not list extractors", error, { action: request.action });
        sendResponse({ extractorNames: [] });
      });
    return true;
  }

  if (request.action === "downloadFixtures") {
    void downloadReaderFixtureBundle(request)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        logLoupeError("Loupe fixture download failed", error, { action: request.action });
        sendResponse({
          ok: false,
          error: getErrorMessage(error),
        } satisfies DownloadReaderFixturesResponse);
      });
    return true;
  }

  if (request.action === "sendToTansu") {
    void runSendToTansu(request).then(sendResponse);
    return true;
  }

  if (request.action === "openTansuTab") {
    void runFocusTansuTab().then(sendResponse);
    return true;
  }

  if (request.action === "openOptions") {
    void chrome.runtime.openOptionsPage().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (request.action === "openObsidian") {
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      sendResponse({
        ok: false,
        error: "No active tab was found.",
      } satisfies OpenObsidianUrlResponse);
      return false;
    }
    void chrome.tabs
      .update(tabId, { url: request.obsidianUrl })
      .then(() => sendResponse({ ok: true } satisfies OpenObsidianUrlResponse))
      .catch((error) => {
        logLoupeError("Loupe could not open Obsidian", error, { action: request.action, tabId });
        sendResponse({
          ok: false,
          error: getErrorMessage(error),
        } satisfies OpenObsidianUrlResponse);
      });
    return true;
  }

  if (request.action !== "parsePage") {
    return false;
  }

  void parsePageWithWasm(request.pageHtml, request.pageUrl, request.extractorName)
    .then((parsedPage): ParsePageResponse => ({ ok: true, parsedPage }))
    .catch((error): ParsePageResponse => {
      logLoupeError("Loupe page parsing failed", error, {
        action: request.action,
        pageUrl: request.pageUrl,
        extractorName: request.extractorName,
      });
      return { ok: false, error: getErrorMessage(error) };
    })
    .then(sendResponse);

  return true;
});

async function downloadReaderFixtureBundle(
  readerFixturesRequest: DownloadReaderFixturesRequest,
): Promise<void> {
  const {
      rawPageHtml,
      extractedContentHtml,
      extractedContentMarkdown,
      readerUiHtml,
      downloadSlug,
      extractorName,
    } = readerFixturesRequest,
    safeDownloadSlug = sanitizeDownloadFilename(downloadSlug),
    safeExtractorName = extractorName ? sanitizeDownloadFilename(extractorName) : "",
    downloadFixtureFile = async (
      downloadFilename: string,
      fixtureContent: string,
      fixtureMimeType: string,
    ): Promise<void> => {
      const downloadDataUrl = `data:${fixtureMimeType};charset=utf-8,${encodeURIComponent(fixtureContent)}`;
      try {
        await chrome.downloads.download({
          filename: downloadFilename,
          saveAs: false,
          url: downloadDataUrl,
        });
      } catch (error) {
        logLoupeError("Loupe download operation failed", error, {
          filename: downloadFilename,
          mimeType: fixtureMimeType,
        });
        throw error;
      }
    },
    extractorFilenameSuffix = safeExtractorName ? `.${safeExtractorName}` : "";
  await downloadFixtureFile(`${safeDownloadSlug}.raw.html`, rawPageHtml, "text/html");
  await downloadFixtureFile(
    `${safeDownloadSlug + extractorFilenameSuffix}.html`,
    extractedContentHtml,
    "text/html",
  );
  await downloadFixtureFile(`${safeDownloadSlug}.ui.html`, readerUiHtml, "text/html");
  if (extractedContentMarkdown) {
    await downloadFixtureFile(
      `${safeDownloadSlug + extractorFilenameSuffix}.md`,
      extractedContentMarkdown,
      "text/markdown",
    );
  }
}

async function sendMessageToContentScript(
  tabId: number,
  tabUrl: string | undefined,
  message: ContentScriptMessage,
): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return;
  } catch {
    // The content script is injected on demand, so a missing receiver is expected here.
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (error) {
    logLoupeError("Loupe could not inject the content script", error, {
      tabId,
      tabUrl,
      action: message.action,
    });
    throw error;
  }

  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    logLoupeError("Loupe could not reach the injected content script", error, {
      tabId,
      tabUrl,
      action: message.action,
    });
    throw error;
  }
}
