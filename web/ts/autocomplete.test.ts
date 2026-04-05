import { describe, test, expect, beforeAll, afterAll } from "bun:test";

import { setupDOM, mockFetch } from "./test-helper.ts";

describe("autocomplete", () => {
  let cleanup: () => void;
  let mock: ReturnType<typeof mockFetch>;
  let checkWikiLinkTrigger: (el: HTMLElement, path: string) => void;
  let hideAutocomplete: () => void;
  let invalidateNoteCache: () => void;
  let contentEl: HTMLDivElement;

  beforeAll(async () => {
    cleanup = setupDOM();
    mock = mockFetch();

    mock.on("GET", "/api/notes", [
      { path: "notes/alpha.md", title: "Alpha" },
      { path: "notes/beta.md", title: "Beta" },
      { path: "notes/gamma.md", title: "Gamma" },
    ]);
    mock.on("PUT", "/api/state", {});
    mock.on("GET", "/api/state", { tabs: [], active: -1 });

    const mod = await import("./autocomplete.ts");
    checkWikiLinkTrigger = mod.checkWikiLinkTrigger;
    hideAutocomplete = mod.hideAutocomplete;
    invalidateNoteCache = mod.invalidateNoteCache;

    contentEl = document.createElement("div");
    contentEl.contentEditable = "true";
    document.body.appendChild(contentEl);
  });

  afterAll(() => {
    mock.restore();
    cleanup();
  });

  test("autocomplete lifecycle", async () => {
    // No trigger when no [[ in text
    contentEl.innerHTML = "";
    const text1 = document.createTextNode("hello world");
    contentEl.appendChild(text1);
    const range1 = document.createRange();
    range1.setStart(text1, 11);
    range1.collapse(true);
    const sel1 = window.getSelection()!;
    sel1.removeAllRanges();
    sel1.addRange(range1);
    checkWikiLinkTrigger(contentEl, "test.md");
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector(".autocomplete")).toBe(null);

    // Trigger with [[ shows autocomplete
    contentEl.innerHTML = "";
    const text2 = document.createTextNode("see [[al");
    contentEl.appendChild(text2);
    const range2 = document.createRange();
    range2.setStart(text2, 8);
    range2.collapse(true);
    const sel2 = window.getSelection()!;
    sel2.removeAllRanges();
    sel2.addRange(range2);
    checkWikiLinkTrigger(contentEl, "test.md");
    await new Promise((r) => setTimeout(r, 100));
    const ac = document.querySelector(".autocomplete");
    expect(ac !== null).toBe(true);
    // Should filter to Alpha
    const items = ac!.querySelectorAll(".autocomplete-item");
    expect(items.length >= 1).toBe(true);
    expect(items[0]!.textContent!.includes("Alpha")).toBe(true);

    // hideAutocomplete removes it
    hideAutocomplete();
    expect(document.querySelector(".autocomplete")).toBe(null);

    // invalidateNoteCache clears cached notes (subsequent trigger re-fetches)
    invalidateNoteCache();

    // Already-closed wiki link should not trigger
    contentEl.innerHTML = "";
    const text3 = document.createTextNode("see [[done]] and more");
    contentEl.appendChild(text3);
    const range3 = document.createRange();
    range3.setStart(text3, 21);
    range3.collapse(true);
    const sel3 = window.getSelection()!;
    sel3.removeAllRanges();
    sel3.addRange(range3);
    checkWikiLinkTrigger(contentEl, "test.md");
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector(".autocomplete")).toBe(null);
  });
});
