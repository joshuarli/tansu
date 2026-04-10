/// Shared test utilities: DOM setup via happy-dom, fetch mocking.

import { Window } from "happy-dom";

import type {
  Note,
  SaveResult,
  NoteEntry,
  SearchResult,
  SessionState,
  Settings,
  AppStatus,
} from "./api.ts";

/// All possible JSON bodies that the mock server can return.
/// Using a union keeps mock.on() calls honest about shape without requiring
/// explicit generics at every call site.
export type MockBody =
  | Note
  | SaveResult
  | NoteEntry[]
  | SearchResult[]
  | SessionState
  | Settings
  | AppStatus
  | { mtime: number }
  | { updated: string[] }
  | { filename: string }
  | { content: string }
  | number[]
  | string[]
  | { error: string }
  | Record<string, never>
  | string;

const TANSU_HTML = `<!doctype html>
<html><head></head><body>
<div id="app">
  <div id="notification" class="notification hidden"></div>
  <div id="tab-bar"></div>
  <div id="editor-area">
    <div id="empty-state">empty</div>
  </div>
  <div id="search-overlay" class="hidden">
    <div id="search-modal">
      <input id="search-input" type="text">
      <div id="search-results"></div>
    </div>
  </div>
  <div id="settings-overlay" class="hidden">
    <div id="settings-panel"></div>
  </div>
  <div id="input-dialog-overlay" class="hidden">
    <div id="input-dialog">
      <input id="input-dialog-input" type="text">
    </div>
  </div>
  <div id="palette-overlay" class="hidden">
    <div id="palette-modal">
      <input id="palette-input" type="text">
      <div id="palette-list"></div>
    </div>
  </div>
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
  const handlers: Array<{
    match: (url: string, init?: RequestInit) => boolean;
    respond: () => Response;
  }> = [];
  const origFetch = globalThis.fetch;

  const mock: MockFetch = {
    on(method: string, urlPattern: string | RegExp, body: MockBody, status = 200) {
      handlers.push({
        match: (url, init) => {
          const m = (init?.method ?? "GET").toUpperCase() === method.toUpperCase();
          if (typeof urlPattern === "string") return m && url.includes(urlPattern);
          return m && urlPattern.test(url);
        },
        respond: () =>
          new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json" },
          }),
      });
      return mock;
    },
    restore() {
      globalThis.fetch = origFetch;
    },
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    // Later handlers take precedence (search in reverse)
    for (let i = handlers.length - 1; i >= 0; i--) {
      if (handlers[i]!.match(url, init)) return handlers[i]!.respond();
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return mock;
}

export interface MockFetch {
  on(method: string, urlPattern: string | RegExp, body: MockBody, status?: number): MockFetch;
  restore(): void;
}
