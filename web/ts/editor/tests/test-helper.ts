import { Window } from "happy-dom";

const MINIMAL_HTML = `<!doctype html><html><head></head><body></body></html>`;

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
    "HTMLImageElement",
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

  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: win.navigator, writable: true });
  originals["location"] = (globalThis as Record<string, unknown>)["location"];
  (globalThis as Record<string, unknown>)["location"] = win.location;

  return () => {
    for (const [key, val] of Object.entries(originals)) {
      (globalThis as Record<string, unknown>)[key] = val;
    }
    if (navigatorDescriptor) {
      Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "navigator");
    }
    win.close();
  };
}
