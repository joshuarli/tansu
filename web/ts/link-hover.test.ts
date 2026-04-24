import { describe, test, expect, beforeAll, afterAll } from "vitest";

import { setupDOM } from "./test-helper.ts";

describe("link-hover", () => {
  let cleanup: () => void;

  beforeAll(async () => {
    cleanup = setupDOM();
    const { registerLinkHover } = await import("./link-hover.ts");
    registerLinkHover();
  });

  afterAll(() => {
    cleanup();
  });

  function makeEditorLink(href: string): HTMLAnchorElement {
    const editorDiv = document.createElement("div");
    editorDiv.className = "editor-content";
    const a = document.createElement("a");
    a.href = href;
    a.textContent = "link text";
    editorDiv.appendChild(a);
    document.body.appendChild(editorDiv);
    a.getBoundingClientRect = () =>
      ({ bottom: 50, left: 10, top: 30, right: 110, width: 100, height: 20 }) as DOMRect;
    return a;
  }

  test("mouseover on editor link shows tooltip", () => {
    const a = makeEditorLink("https://example.com");

    document.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    // Event must bubble from anchor; dispatch from the anchor itself
    a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));

    const tooltip = document.body.querySelector(".link-hover-tooltip") as HTMLElement | null;
    expect(tooltip !== null).toBe(true);
    expect(tooltip!.style.display).toBe("block");

    a.parentElement?.remove();
  });

  test("mouseout on editor link schedules tooltip hide", async () => {
    const a = makeEditorLink("https://example.com");

    a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    const tooltip = document.body.querySelector(".link-hover-tooltip") as HTMLElement;
    expect(tooltip.style.display).toBe("block");

    a.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    // Give the 100ms timer time to fire
    await new Promise((r) => setTimeout(r, 150));
    expect(tooltip.style.display).toBe("none");

    a.parentElement?.remove();
  });

  test("Ctrl+click on editor link calls window.open", () => {
    const a = makeEditorLink("https://example.com/page");

    let opened: string | null = null;
    const origOpen = window.open;
    (window as unknown as Record<string, unknown>)["open"] = (url: string) => {
      opened = url;
    };

    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));

    (window as unknown as Record<string, unknown>)["open"] = origOpen;
    expect(opened).toBe("https://example.com/page");

    a.parentElement?.remove();
  });

  test("click outside .editor-content a[href] does nothing", () => {
    const p = document.createElement("p");
    p.textContent = "plain text";
    document.body.appendChild(p);

    let opened = false;
    const origOpen = window.open;
    (window as unknown as Record<string, unknown>)["open"] = () => {
      opened = true;
    };

    p.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));

    (window as unknown as Record<string, unknown>)["open"] = origOpen;
    expect(opened).toBe(false);

    p.remove();
  });
});
