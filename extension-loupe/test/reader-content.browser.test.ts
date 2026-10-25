import { afterEach, expect, test, vi } from "vitest";
import readerContentScript from "../../build/browser-test/reader-content.js?raw";

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.style.overflow = "";
  document.body.style.overflow = "";
});

test("reader content renders, keeps route data current, and can dismiss extraction errors", async () => {
  let messageListener: ((message: { action: string }) => void) | undefined,
    obsidianUrl = "",
    clipboardText = "",
    clipboardShouldFail = false,
    parsePageResponse: () => Promise<unknown> = () => Promise.resolve({
      ok: true,
      parsedPage: {
        content:
          "<h2 id='section'>Section</h2><h2>Generated</h2><h2>Generated</h2><p>Readable text.</p>",
        content_markdown: String.raw`# Section\n\n![photo](https://example.com/photo.jpg)`,
        title: "Rendered article",
        author: "",
        description: "",
        published: "",
        site: "",
        domain: "example.com",
        extractor_type: null,
      },
    });

  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn(async (text: string) => {
        if (clipboardShouldFail) throw new Error("clipboard unavailable");
        clipboardText = text;
      }),
    },
  });
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: () => false,
  });
  Object.defineProperty(window, "chrome", {
    configurable: true,
    value: {
      runtime: {
        onMessage: { addListener: (listener: (message: { action: string }) => void) => {
          messageListener = listener;
        } },
        sendMessage: async (message: { action: string; obsidianUrl?: unknown }) => {
          if (message.action === "parsePage") return parsePageResponse();
          if (message.action === "listExtractors") return { extractorNames: [] };
          if (message.action === "openObsidian") {
            if (typeof message.obsidianUrl !== "string") {
              throw new Error("Expected an Obsidian URL.");
            }
            obsidianUrl = message.obsidianUrl;
            return { ok: true };
          }
          throw new Error(`Unexpected message: ${message.action}`);
        },
      },
    },
  });

  const script = document.createElement("script");
  script.textContent = readerContentScript;
  document.body.append(script);
  messageListener?.({ action: "toggle" });

  await vi.waitFor(() => {
    const host = document.querySelector<HTMLDivElement>('[id^="loupe-reader-host-"]');
    expect(host?.shadowRoot?.querySelector("article h1")?.textContent).toBe("Rendered article");
  });
  const host = document.querySelector<HTMLDivElement>('[id^="loupe-reader-host-"]')!;
  const shadow = host.shadowRoot!;
  expect(shadow.querySelector("article")?.textContent).toContain("Readable text.");
  expect(shadow.querySelectorAll(".loupe-reader-outline-item")).toHaveLength(3);
  expect([...shadow.querySelectorAll<HTMLElement>(".loupe-reader-outline-item")].map(
    (outlineItem) => outlineItem.dataset["headingId"],
  )).toStrictEqual(["section", "generated", "generated-1"]);

  const menuToggle = shadow.querySelector<HTMLButtonElement>('[data-action="menu-toggle"]')!,
    leftBeforeOpen = menuToggle.getBoundingClientRect().left;
  menuToggle.click();
  expect(shadow.querySelector<HTMLDivElement>(".loupe-reader-menu")?.hidden).toBeFalsy();
  expect(Math.abs(menuToggle.getBoundingClientRect().left - leftBeforeOpen)).toBeLessThan(0.5);

  shadow.querySelector<HTMLButtonElement>('[data-action="obsidian"]')!.click();
  await vi.waitFor(() => {
    expect(shadow.querySelector(".loupe-reader-status")?.textContent)
      .toContain("Opening in Obsidian; image import will continue there");
  });
  expect(new URL(obsidianUrl).hostname).toBe("loupe-import");
  expect(new URL(obsidianUrl).searchParams.has("content")).toBeFalsy();
  expect(clipboardText).toContain("![photo](https://example.com/photo.jpg)");

  clipboardShouldFail = true;
  shadow.querySelector<HTMLButtonElement>('[data-action="obsidian"]')!.click();
  await vi.waitFor(() => {
    expect(shadow.querySelector(".loupe-reader-status")?.textContent).toContain("Opening in Obsidian…");
  });
  const fallbackUri = new URL(obsidianUrl);
  expect(fallbackUri.hostname).toBe("new");
  expect(fallbackUri.searchParams.get("content")).toContain("Rendered article");

  const originalUrl = document.URL;
  messageListener?.({ action: "toggle" });
  history.pushState({}, "", `${originalUrl}#loading-route`);
  let resolveParsePage: ((response: unknown) => void) | undefined;
  parsePageResponse = () => new Promise((resolve) => {
    resolveParsePage = resolve;
  });
  messageListener?.({ action: "toggle" });
  await vi.waitFor(() => expect(resolveParsePage).toBeTypeOf("function"));
  history.pushState({}, "", `${originalUrl}#new-route`);
  resolveParsePage?.({
    ok: true,
    parsedPage: {
      content: "<p>Stale route content</p>",
      content_markdown: "Stale route content",
      title: "Stale route content",
      author: "",
      description: "",
      published: "",
      site: "",
      domain: "example.com",
      extractor_type: null,
    },
  });
  await vi.waitFor(() => {
    expect(shadow.querySelector("article h1")?.textContent)
      .toBe("Loupe could not read this page");
  });
  expect(shadow.querySelector("article")?.textContent).not.toContain("Stale route content");
  expect(document.documentElement.style.overflow).toBe("");
  expect(document.body.style.overflow).toBe("");

  messageListener?.({ action: "toggle" });
  expect(host.hidden).toBeTruthy();
  parsePageResponse = () => Promise.resolve({
    ok: true,
    parsedPage: {
      content: "<p>Current route content</p>",
      content_markdown: "Current route content",
      title: "Current route content",
      author: "",
      description: "",
      published: "",
      site: "",
      domain: "example.com",
      extractor_type: null,
    },
  });
  messageListener?.({ action: "toggle" });
  await vi.waitFor(() => {
    expect(shadow.querySelector("article")?.textContent).toContain("Current route content");
  });

  messageListener?.({ action: "toggle" });
  document.documentElement.style.overflow = "clip";
  document.body.style.overflow = "auto";
  history.pushState({}, "", `${originalUrl}#failure`);
  parsePageResponse = () => Promise.resolve({ ok: false, error: "No article found." });
  messageListener?.({ action: "toggle" });
  await vi.waitFor(() => {
    expect(shadow.querySelector("article h1")?.textContent)
      .toBe("Loupe could not read this page");
  });
  expect(document.documentElement.style.overflow).toBe("clip");
  expect(document.body.style.overflow).toBe("auto");
  messageListener?.({ action: "toggle" });
  expect(host.hidden).toBeTruthy();
  expect(document.documentElement.style.overflow).toBe("clip");
  expect(document.body.style.overflow).toBe("auto");
  history.pushState({}, "", originalUrl);
});
