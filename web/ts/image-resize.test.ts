import { describe, test, expect, beforeAll, afterAll } from "vitest";

import { initImageResize } from "./image-resize.ts";
import { setupDOM } from "./test-helper.ts";

describe("image-resize", () => {
  let cleanup: () => void;

  beforeAll(() => {
    cleanup = setupDOM();
  });

  afterAll(() => {
    cleanup();
  });

  function makeImg(withAttr = true): { contentEl: HTMLElement; img: HTMLImageElement } {
    const contentEl = document.createElement("div");
    const img = document.createElement("img");
    if (withAttr) img.setAttribute("data-wiki-image", "true");
    img.setAttribute("width", "200");
    contentEl.appendChild(img);
    document.body.appendChild(contentEl);
    img.getBoundingClientRect = () =>
      ({
        width: 200,
        height: 100,
        top: 0,
        left: 0,
        right: 200,
        bottom: 100,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    return { contentEl, img };
  }

  // happy-dom 20.x WheelEvent doesn't propagate ctrlKey from constructor init.
  // Patch via defineProperty so image-resize handler sees e.ctrlKey correctly.
  function makeCtrlWheel(deltaY: number): WheelEvent {
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY });
    Object.defineProperty(event, "ctrlKey", { value: true, configurable: true });
    return event;
  }

  test("Ctrl+wheel on wiki-image scales width and calls callback", () => {
    const { contentEl, img } = makeImg();
    let resizeCalled = false;
    initImageResize(contentEl, () => {
      resizeCalled = true;
    });

    // deltaY = -10 → scroll up → zoom in: newWidth = max(50, round(200 - (-10)*1.5)) = 215
    img.dispatchEvent(makeCtrlWheel(-10));

    expect(resizeCalled).toBe(true);
    expect(img.getAttribute("width")).toBe("215");

    contentEl.remove();
  });

  test("Ctrl+wheel clamps width to minimum 50", () => {
    const { contentEl, img } = makeImg();
    img.getBoundingClientRect = () => ({ width: 50 }) as DOMRect;
    img.setAttribute("width", "50");

    initImageResize(contentEl, () => {});

    // deltaY large positive → zoom out: newWidth = max(50, round(50 - 1000*1.5)) clamped to 50
    img.dispatchEvent(makeCtrlWheel(1000));

    expect(parseInt(img.getAttribute("width")!)).toBeGreaterThanOrEqual(50);

    contentEl.remove();
  });

  test("non-Ctrl wheel is ignored", () => {
    const { contentEl, img } = makeImg();
    let resizeCalled = false;
    initImageResize(contentEl, () => {
      resizeCalled = true;
    });

    const event = new WheelEvent("wheel", { bubbles: true, ctrlKey: false });
    img.dispatchEvent(event);

    expect(resizeCalled).toBe(false);

    contentEl.remove();
  });

  test("Ctrl+wheel on non-IMG element is ignored", () => {
    const contentEl = document.createElement("div");
    const p = document.createElement("p");
    p.textContent = "text";
    contentEl.appendChild(p);
    document.body.appendChild(contentEl);

    let resizeCalled = false;
    initImageResize(contentEl, () => {
      resizeCalled = true;
    });

    const event = new WheelEvent("wheel", { bubbles: true, ctrlKey: true });
    p.dispatchEvent(event);

    expect(resizeCalled).toBe(false);

    contentEl.remove();
  });

  test("Ctrl+wheel on IMG without data-wiki-image is ignored", () => {
    const { contentEl, img } = makeImg(false);
    let resizeCalled = false;
    initImageResize(contentEl, () => {
      resizeCalled = true;
    });

    const event = new WheelEvent("wheel", { bubbles: true, ctrlKey: true });
    img.dispatchEvent(event);

    expect(resizeCalled).toBe(false);

    contentEl.remove();
  });
});
