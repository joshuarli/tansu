/// Shared test utilities: DOM setup via happy-dom.

import { Window } from "happy-dom";

const MINIMAL_HTML = `<!doctype html><html><head></head><body></body></html>`;

/// Install happy-dom globals so modules that access document/window at
/// import time will work. Returns a cleanup function.
export function setupDOM(): () => void {
  const win = new Window({ url: "http://localhost:3000" });
  win.document.write(MINIMAL_HTML);

  (win as unknown as Record<string, unknown>)["SyntaxError"] = SyntaxError;
  (win as unknown as Record<string, unknown>)["TypeError"] = TypeError;
  (win as unknown as Record<string, unknown>)["DOMException"] = DOMException;

  const globals = [
    "window",
    "document",
    "HTMLElement",
    "Node",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "HTMLSelectElement",
    "CustomEvent",
    "MouseEvent",
    "KeyboardEvent",
    "Event",
    "Range",
    "NodeFilter",
  ] as const;

  const originals: Record<string, unknown> = {};
  for (const key of globals) {
    originals[key] = (globalThis as Record<string, unknown>)[key];
    (globalThis as Record<string, unknown>)[key] = (win as unknown as Record<string, unknown>)[key];
  }

  originals["navigator"] = (globalThis as Record<string, unknown>)["navigator"];
  (globalThis as Record<string, unknown>)["navigator"] = win.navigator;
  originals["location"] = (globalThis as Record<string, unknown>)["location"];
  (globalThis as Record<string, unknown>)["location"] = win.location;

  return () => {
    for (const [key, val] of Object.entries(originals)) {
      (globalThis as Record<string, unknown>)[key] = val;
    }
    win.close();
  };
}
