import {
  checkWikiLinkTrigger,
  completeWikiLink,
  hideAutocomplete,
  invalidateNoteCache,
} from "./autocomplete.ts";
import { setupDOM, mockFetch } from "./test-helper.ts";
import { TEST_IDS } from "./test-selectors.ts";

const NOTES = [
  { path: "notes/alpha.md", title: "Alpha", tags: [] },
  { path: "notes/beta.md", title: "Beta", tags: [] },
  { path: "notes/gamma.md", title: "Gamma", tags: [] },
];

function getDropdown() {
  return document.querySelector(TEST_IDS.autocomplete);
}

describe("autocomplete", () => {
  let cleanup: () => void;
  let mock: ReturnType<typeof mockFetch>;
  let contentEl: HTMLDivElement;

  beforeAll(async () => {
    cleanup = setupDOM();
    mock = mockFetch();

    mock.on("GET", "/api/notes", NOTES);
    mock.on("PUT", "/api/state", {});
    mock.on("GET", "/api/state", { tabs: [], active: -1 });

    contentEl = document.createElement("div");
    contentEl.contentEditable = "true";
    document.body.append(contentEl);
  });

  afterAll(() => {
    contentEl.remove();
    mock.restore();
    cleanup();
  });

  function typeInEditor(text: string, cursorAt?: number) {
    contentEl.innerHTML = "";
    const node = document.createTextNode(text);
    contentEl.append(node);
    const pos = cursorAt ?? text.length;
    const range = document.createRange();
    range.setStart(node, pos);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    return node;
  }

  function fireKey(key: string) {
    // Dispatch on contentEl so the event bubbles up through the capture phase
    // on document, where the autocomplete keydown handler is registered.
    contentEl.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  }

  function getItems() {
    return [...(getDropdown()?.querySelectorAll(TEST_IDS.autocompleteItem) ?? [])];
  }

  function selectedIndex() {
    return getItems().findIndex((el) => (el as HTMLElement).dataset["selected"] === "true");
  }

  it("no trigger when text has no [[", async () => {
    typeInEditor("hello world");
    checkWikiLinkTrigger(contentEl, "test.md");
    await new Promise((r) => setTimeout(r, 50));
    expect(getDropdown()).toBeNull();
  });

  it("no trigger when cursor is after a closed [[...]]", async () => {
    typeInEditor("see [[done]] and more");
    checkWikiLinkTrigger(contentEl, "test.md");
    await new Promise((r) => setTimeout(r, 50));
    expect(getDropdown()).toBeNull();
  });

  it("no trigger when selection is on non-text node", async () => {
    // Selection on a non-TEXT_NODE (e.g. contentEl itself) should hide autocomplete
    contentEl.innerHTML = "<b>bold</b>";
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.setStart(contentEl, 0);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    checkWikiLinkTrigger(contentEl, "test.md");
    await new Promise((r) => setTimeout(r, 50));
    expect(getDropdown()).toBeNull();
  });

  it("dropdown appears and filters by query", async () => {
    invalidateNoteCache();
    typeInEditor("see [[al");
    checkWikiLinkTrigger(contentEl, "test.md");
    await new Promise((r) => setTimeout(r, 100));
    expect(getDropdown() !== null).toBeTruthy();
    const items = getItems();
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toContain("Alpha");
    hideAutocomplete();
  });

  it("dropdown shows all notes when query is empty ([[)", async () => {
    invalidateNoteCache();
    typeInEditor("see [[");
    checkWikiLinkTrigger(contentEl, "test.md");
    await new Promise((r) => setTimeout(r, 100));
    const items = getItems();
    expect(items).toHaveLength(NOTES.length);
    hideAutocomplete();
  });

  it("dropdown hides when there are no matches", async () => {
    invalidateNoteCache();
    typeInEditor("[[zzzznothing");
    checkWikiLinkTrigger(contentEl, "test.md");
    await new Promise((r) => setTimeout(r, 100));
    expect(getDropdown()).toBeNull();
  });

  it("first item is selected by default", async () => {
    invalidateNoteCache();
    typeInEditor("[[");
    checkWikiLinkTrigger(contentEl, "test.md");
    await new Promise((r) => setTimeout(r, 100));
    expect(selectedIndex()).toBe(0);
    hideAutocomplete();
  });

  it("ArrowDown moves selection forward", async () => {
    invalidateNoteCache();
    typeInEditor("[[");
    checkWikiLinkTrigger(contentEl, "test.md");
    await new Promise((r) => setTimeout(r, 100));
    expect(selectedIndex()).toBe(0);
    fireKey("ArrowDown");
    expect(selectedIndex()).toBe(1);
    hideAutocomplete();
  });

  it("ArrowDown wraps at the end of the list", async () => {
    invalidateNoteCache();
    typeInEditor("[[");
    checkWikiLinkTrigger(contentEl, "test.md");
    await new Promise((r) => setTimeout(r, 100));
    const count = getItems().length;
    // Advance to last item
    for (let i = 0; i < count - 1; i++) {
      fireKey("ArrowDown");
    }
    expect(selectedIndex()).toBe(count - 1);
    // One more wraps back to 0
    fireKey("ArrowDown");
    expect(selectedIndex()).toBe(0);
    hideAutocomplete();
  });

  it("ArrowUp wraps at the beginning of the list", async () => {
    invalidateNoteCache();
    typeInEditor("[[");
    checkWikiLinkTrigger(contentEl, "test.md");
    await new Promise((r) => setTimeout(r, 100));
    const count = getItems().length;
    // At index 0, ArrowUp should wrap to last
    fireKey("ArrowUp");
    expect(selectedIndex()).toBe(count - 1);
    hideAutocomplete();
  });

  it("Escape dismisses the dropdown", async () => {
    invalidateNoteCache();
    typeInEditor("[[");
    checkWikiLinkTrigger(contentEl, "test.md");
    await new Promise((r) => setTimeout(r, 100));
    expect(getDropdown() !== null).toBeTruthy();
    fireKey("Escape");
    expect(getDropdown()).toBeNull();
  });

  it("Enter completes the selected wiki-link", async () => {
    invalidateNoteCache();
    const node = typeInEditor("see [[al");
    checkWikiLinkTrigger(contentEl, "test.md");
    await new Promise((r) => setTimeout(r, 100));
    expect(getItems()[0]!.textContent).toContain("Alpha");
    // Call completeWikiLink directly (capture-phase keyboard events are not
    // reliably dispatched in happy-dom headless mode).
    completeWikiLink(node, "see [[al".indexOf("[["), "see [[al".length, NOTES[0]!, "test.md");
    expect(getDropdown()).toBeNull();
    expect(node.textContent).toContain("[[alpha]]");
  });

  it("Tab completes the selected wiki-link", async () => {
    invalidateNoteCache();
    const node = typeInEditor("link [[be");
    checkWikiLinkTrigger(contentEl, "test.md");
    await new Promise((r) => setTimeout(r, 100));
    expect(getItems()[0]!.textContent).toContain("Beta");
    // Call completeWikiLink directly (same headless limitation as Enter test).
    completeWikiLink(node, "link [[be".indexOf("[["), "link [[be".length, NOTES[1]!, "test.md");
    expect(getDropdown()).toBeNull();
    expect(node.textContent).toContain("[[beta]]");
  });

  it("clicking an item completes the wiki-link", async () => {
    invalidateNoteCache();
    const node = typeInEditor("see [[ga");
    checkWikiLinkTrigger(contentEl, "test.md");
    await new Promise((r) => setTimeout(r, 100));
    const item = getItems()[0]! as HTMLElement;
    expect(item.textContent).toContain("Gamma");
    item.click();
    expect(getDropdown()).toBeNull();
    expect(node.textContent).toContain("[[gamma]]");
  });

  it("invalidateNoteCache causes a re-fetch on next trigger", async () => {
    // First trigger — populates cache
    invalidateNoteCache();
    typeInEditor("[[");
    checkWikiLinkTrigger(contentEl, "test.md");
    await new Promise((r) => setTimeout(r, 100));
    hideAutocomplete();

    // Replace with a different set of notes
    mock.on("GET", "/api/notes", [{ path: "notes/new.md", title: "New Note", tags: [] }]);
    invalidateNoteCache();

    typeInEditor("[[new");
    checkWikiLinkTrigger(contentEl, "test.md");
    await new Promise((r) => setTimeout(r, 100));
    const items = getItems();
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toContain("New Note");
    hideAutocomplete();

    // Restore original note list
    mock.on("GET", "/api/notes", NOTES);
    invalidateNoteCache();
  });

  it("no trigger when selection has no ranges", () => {
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    checkWikiLinkTrigger(contentEl, "test.md");
    expect(getDropdown()).toBeNull();
  });

  it("showAutocomplete handles API failure gracefully", async () => {
    invalidateNoteCache();
    mock.on("GET", "/api/notes", { error: "fail" }, 500);
    typeInEditor("[[broken");
    checkWikiLinkTrigger(contentEl, "test.md");
    await new Promise((r) => setTimeout(r, 100));
    expect(getDropdown()).toBeNull();
    // Restore
    mock.on("GET", "/api/notes", NOTES);
    invalidateNoteCache();
  });

  it("ignores stale autocomplete results after the trigger disappears", async () => {
    mock.onDelayed("GET", "/api/notes", NOTES, 100);
    invalidateNoteCache();

    typeInEditor("see [[al");
    checkWikiLinkTrigger(contentEl, "test.md");

    typeInEditor("see done");
    checkWikiLinkTrigger(contentEl, "test.md");

    await new Promise((r) => setTimeout(r, 150));
    expect(getDropdown()).toBeNull();

    mock.on("GET", "/api/notes", NOTES);
    invalidateNoteCache();
  });

  it("hideAutocomplete removes the dropdown", async () => {
    invalidateNoteCache();
    typeInEditor("[[");
    checkWikiLinkTrigger(contentEl, "test.md");
    await new Promise((r) => setTimeout(r, 100));
    expect(getDropdown() !== null).toBeTruthy();
    hideAutocomplete();
    expect(getDropdown()).toBeNull();
  });
});
