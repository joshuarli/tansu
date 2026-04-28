/// Shared test utilities: DOM setup via happy-dom, fetch mocking.

import { Window } from "happy-dom";

import type {
  AppStatus,
  RecentFileEntry,
  SaveResult,
  SessionState,
  Settings,
  VaultEntry,
} from "./api.ts";

type MockNote = { content: string; mtime: number; tags?: string[] };
type MockNoteEntry = { path: string; title: string; tags?: string[] };
type MockSearchResult = {
  path: string;
  title: string;
  excerpt: string;
  score: number;
  tags?: string[];
  field_scores: { title: number; headings: number; tags: number; content: number };
};

/// All possible JSON bodies that the mock server can return.
/// Using a union keeps mock.on() calls honest about shape without requiring
/// explicit generics at every call site.
export type MockBody =
  | MockNote
  | SaveResult
  | MockNoteEntry[]
  | RecentFileEntry[]
  | VaultEntry[]
  | MockSearchResult[]
  | SessionState
  | Settings
  | AppStatus
  | { mtime: number }
  | { tags: string[] }
  | { updated: string[] }
  | { filename: string }
  | { content: string }
  | number[]
  | string[]
  | { error: string }
  | Record<string, never>
  | string;

export type MockRequest = {
  method: string;
  url: string;
  body: string | null;
};

const TANSU_HTML = `<!doctype html>
<html><head></head><body>
  <div id="app">
    <div id="sidebar">
      <button id="sidebar-collapse"></button>
      <div class="sidebar-header">
        <input id="sidebar-search" type="text">
      </div>
      <div id="vault-switcher"></div>
      <div id="sidebar-tree"></div>
    </div>
    <div id="notification" class="notification hidden"></div>
    <div id="tab-bar"></div>
    <div id="server-status" class="server-status hidden" aria-live="polite"></div>
  <div id="editor-area">
      <div id="empty-state">empty</div>
    </div>
  <div id="search-root"></div>
  <div id="settings-root"></div>
  <div id="palette-root"></div>
</div>
</body></html>`;

/// Install happy-dom globals so modules that call document.getElementById at
/// import time will work. Returns a cleanup function.
export function setupDOM(): () => void {
  const win = new Window({ url: "http://localhost:3000" });
  win.document.write(TANSU_HTML);

  // Patch globals
  const originals: Record<string, unknown> = {};
  // Ensure Window has error constructors that happy-dom's internals need
  (win as unknown as Record<string, unknown>)["SyntaxError"] = SyntaxError;
  (win as unknown as Record<string, unknown>)["TypeError"] = TypeError;
  (win as unknown as Record<string, unknown>)["DOMException"] = DOMException;

  const globals = [
    "window",
    "document",
    "HTMLElement",
    "Node",
    "EventSource",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "HTMLSelectElement",
    "CustomEvent",
    "MouseEvent",
    "WheelEvent",
    "KeyboardEvent",
    "Event",
    "OffscreenCanvas",
    "Range",
    "NodeFilter",
  ] as const;

  for (const key of globals) {
    originals[key] = (globalThis as Record<string, unknown>)[key];
    (globalThis as Record<string, unknown>)[key] = (win as unknown as Record<string, unknown>)[key];
  }

  // navigator, location, alert, confirm, prompt
  originals["navigator"] = (globalThis as Record<string, unknown>)["navigator"];
  (globalThis as Record<string, unknown>)["navigator"] = win.navigator;
  originals["location"] = (globalThis as Record<string, unknown>)["location"];
  (globalThis as Record<string, unknown>)["location"] = win.location;
  originals["alert"] = (globalThis as Record<string, unknown>)["alert"];
  (globalThis as Record<string, unknown>)["alert"] = () => {};
  originals["confirm"] = (globalThis as Record<string, unknown>)["confirm"];
  (globalThis as Record<string, unknown>)["confirm"] = () => true;
  originals["prompt"] = (globalThis as Record<string, unknown>)["prompt"];
  (globalThis as Record<string, unknown>)["prompt"] = () => "test";

  return () => {
    for (const [key, val] of Object.entries(originals)) {
      (globalThis as Record<string, unknown>)[key] = val;
    }
    win.close();
  };
}

/// Mock fetch: returns a function to set up responses, and installs a global fetch mock.
export function mockFetch(): MockFetch {
  const handlers: {
    match: (url: string, init?: RequestInit) => boolean;
    respond: () => Response | Promise<Response>;
  }[] = [];
  const requests: MockRequest[] = [];
  const origFetch = globalThis.fetch;

  const mock: MockFetch = {
    requests,
    clearRequests() {
      requests.length = 0;
      return mock;
    },
    on(method: string, urlPattern: string | RegExp, body: MockBody, status = 200) {
      handlers.push({
        match: (url, init) => {
          const m = (init?.method ?? "GET").toUpperCase() === method.toUpperCase();
          if (typeof urlPattern === "string") {
            return m && url.includes(urlPattern);
          }
          return m && urlPattern.test(url);
        },
        respond: () =>
          Response.json(body, {
            status,
            headers: { "Content-Type": "application/json" },
          }),
      });
      return mock;
    },
    onDelayed(
      method: string,
      urlPattern: string | RegExp,
      body: MockBody,
      delayMs: number,
      status = 200,
    ) {
      handlers.push({
        match: (url, init) => {
          const m = (init?.method ?? "GET").toUpperCase() === method.toUpperCase();
          if (typeof urlPattern === "string") {
            return m && url.includes(urlPattern);
          }
          /* c8 ignore next */
          return m && urlPattern.test(url);
        },
        respond: () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve(
                  Response.json(body, {
                    status,
                    headers: { "Content-Type": "application/json" },
                  }),
                ),
              delayMs,
            ),
          ),
      });
      return mock;
    },
    restore() {
      globalThis.fetch = origFetch;
    },
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let url: string;
    if (typeof input === "string") {
      url = input;
    } else if (input instanceof URL) {
      url = input.toString();
    } else {
      ({ url } = input);
    }
    const initBody = init?.body;
    let body: string | null = null;
    if (typeof initBody === "string") {
      body = initBody;
    } else if (initBody) {
      body = String(initBody);
    }
    requests.push({
      method: (init?.method ?? "GET").toUpperCase(),
      url,
      body,
    });
    // Later handlers take precedence (search in reverse)
    for (let i = handlers.length - 1; i >= 0; i--) {
      if (handlers[i]!.match(url, init)) {
        return handlers[i]!.respond();
      }
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return mock;
}

export type MockFetch = {
  requests: MockRequest[];
  clearRequests(): MockFetch;
  on(method: string, urlPattern: string | RegExp, body: MockBody, status?: number): MockFetch;
  onDelayed(
    method: string,
    urlPattern: string | RegExp,
    body: MockBody,
    delayMs: number,
    status?: number,
  ): MockFetch;
  restore(): void;
};
