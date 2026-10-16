import { vi, expect, describe, it } from "vitest";

import type { CommandItem, ViewEvent } from "./app/events.ts";
import { localDraftId, serverInstanceId, vaultId } from "./app/identity.ts";
import { SETTINGS_LIMITS } from "./app/settings-policy.ts";
import {
  createState,
  tabFromDocument,
  tabFromMeta,
  tabIdentity,
  toNoteId,
  toRevisionEventId,
  type State,
} from "./state.ts";
import type { Settings, V2ConflictDraftDocument, V2NoteMeta, V2RevisionMeta } from "./types.generated.ts";
import { createTagPill, tagHue } from "./tag-pill.ts";
import { renderApp, renderAuthGate, renderLoading, renderStatusBar } from "./view.ts";
import type { Outline } from "./editor/source-navigation.js";

const VAULT_ID = vaultId("vault-1");

describe("view rendering", () => {
  it("renders loading, empty, loading-note, dirty, saving, and degraded states", () => {
    expect(renderLoading().textContent).toBe("Loading");

    const state = baseState();
    let root = render(state);
    expect(root.textContent).toContain("No note selected");

    const tab = tabFromMeta(note("n1", "one.md", "One"));
    state.tabs = [tab];
    state.activeTab = tabIdentity(tab);
    root = render(state);
    expect(root.textContent).toContain("Loading");

    tab.doc = { meta: note("n1", "one.md", "One", ["alpha"]), content: "# One\n" };
    tab.draft = "# Changed\n";
    tab.dirty = true;
    state.boot!.searchStatus.degraded = true;
    expect(renderStatusBar(state).textContent).toContain("Unsaved");
    expect(renderStatusBar(state).textContent).toContain("Search degraded");

    tab.saving = true;
    expect(renderStatusBar(state).textContent).toContain("Saving");
  });

  it("wires floating navigation, tabs, tags, and context menu actions", () => {
    const state = baseState();
    const active = tabFromDocument({
      meta: note("n1", "one.md", "One", ["alpha"]),
      content: "---\ntags:\n  - alpha\n---\n\n# One\n",
    });
    const other = tabFromDocument({ meta: note("n2", "two.md", "Two"), content: "# Two\n" });
    active.dirty = true;
    active.conflict = true;
    state.tabs = [active, other];
    state.activeTab = tabIdentity(active);
    state.notes.set(active.noteId, active.doc!.meta);
    state.pinned.add("n1");
    state.contextMenu = { noteId: toNoteId("n1"), x: 12, y: 24 };
    state.searchOpen = true;
    const actions = actionSpies();
    const root = render(state, actions);

    root.querySelector<HTMLSelectElement>(".vault-select")!.value = "vault-1";
    root.querySelector<HTMLSelectElement>(".vault-select")!.dispatchEvent(new Event("change"));
    root.querySelector<HTMLButtonElement>(".recent-search-result")!.click();
    root.querySelector<HTMLButtonElement>('[title="New note"]')!.click();
    root.querySelectorAll<HTMLButtonElement>(".tab-close")[1]!.click();
    root.querySelector<HTMLButtonElement>('[title="Two"]')!.click();
    root
      .querySelector<HTMLButtonElement>('[title="One"]')!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 3, clientY: 4 }));
    root.querySelector<HTMLButtonElement>('[title="View conflict draft"]')!.click();
    root.querySelector<HTMLButtonElement>('[title="Restore conflict draft"]')!.click();
    root.querySelector<HTMLButtonElement>('[title="Unpin note"]')!.click();
    root.querySelector<HTMLButtonElement>('[title="Rename note"]')!.click();
    root.querySelector<HTMLButtonElement>('[title="Delete note"]')!.click();

    expectDispatched(actions, { type: "vault.switch", vaultId: VAULT_ID });
    expectDispatched(actions, { type: "search.recentOpen", noteId: toNoteId("n1") });
    expectDispatched(actions, { type: "command.run", id: "create" });
    expectDispatched(actions, { type: "tab.close", tab: tabIdentity(other) });
    expectDispatched(actions, { type: "tab.activate", tab: tabIdentity(other) });
    expectDispatched(actions, { type: "context.open", noteId: toNoteId("n1"), x: 3, y: 4 });
    expectDispatched(actions, { type: "note.pin", noteId: toNoteId("n1") });
    expectDispatched(actions, { type: "note.rename", noteId: toNoteId("n1") });
    expectDispatched(actions, { type: "note.delete", noteId: toNoteId("n1") });
    expect(root.textContent).toContain("Save conflict");
    expect(root.querySelector(".sidebar")).toBeNull();
    expect(root.querySelector(".toolbar")).toBeNull();
    expect(root.querySelector<HTMLButtonElement>(".tab.active")?.title).toBe("One");
  });

  it("opens a custom animated vault menu", () => {
    const state = baseState();
    state.boot!.vaults = [
      { vaultId: "vault-1", name: "Main" },
      { vaultId: "vault-2", name: "Work" },
    ];
    const actions = actionSpies();
    const root = render(state, actions);
    const vaultControl = root.querySelector<HTMLElement>(".vault-control")!;
    const vaultOptions = root.querySelectorAll<HTMLButtonElement>(".vault-option");

    vaultControl.click();
    expect(vaultControl.classList.contains("open")).toBeTruthy();
    expect(vaultControl.getAttribute("aria-expanded")).toBe("true");
    expect([...vaultOptions].map((option) => option.textContent)).toStrictEqual(["Work"]);

    vaultOptions[0]!.click();
    expectDispatched(actions, { type: "vault.switch", vaultId: vaultId("vault-2") });
    expect(root.querySelector<HTMLElement>(".vault-label")!.textContent).toBe("Work");
    expect(vaultControl.classList.contains("open")).toBeFalsy();
  });

  it("renders reading and theme toggles beside the vault picker", () => {
    const state = baseState();
    const actions = actionSpies();
    const root = render(state, actions);
    const controls = root.querySelector<HTMLElement>(".floating-controls")!;
    const reading = controls.querySelector<HTMLButtonElement>(".reading-mode-toggle")!;
    const theme = controls.querySelector<HTMLButtonElement>(".theme-toggle")!;

    expect(controls.querySelector(".vault-control")).not.toBeNull();
    expect(reading.getAttribute("aria-label")).toBe("Switch to reading mode");
    expect(theme.getAttribute("aria-label")).toBe("Switch to dark mode");
    reading.click();
    theme.click();

    expectDispatched(actions, { type: "reading.toggle" });
    expectDispatched(actions, { type: "theme.toggle" });
  });

  it("renders outline and current-note find controls without replacing the editor region", () => {
    const state = baseState();
    const tab = tabFromDocument({ meta: note("n1", "one.md", "One"), content: "# One\nbody\n" });
    state.tabs = [tab];
    state.activeTab = tabIdentity(tab);
    state.findOpen = true;
    state.findQuery = "body";
    const actions = actionSpies();
    actions.outline.mockReturnValue({
      complete: true,
      headings: [{ level: 1, line: 1, text: "One", from: 0, to: 5 }],
    });
    actions.findMatches.mockReturnValue([{ from: 6, to: 10 }]);
    const root = render(state, actions);

    expect(root.querySelector(".outline-row")?.textContent).toBe("One");
    expect(root.querySelector<HTMLInputElement>(".find-bar input")?.value).toBe("body");
    expect(root.querySelector(".find-count")?.textContent).toBe("1 of 1");
    root.querySelector<HTMLButtonElement>(".outline-row")?.click();
    root.querySelector<HTMLButtonElement>(".find-next")?.click();
    expectDispatched(actions, { type: "outline.select", heading: { level: 1, line: 1, text: "One", from: 0, to: 5 } });
    expectDispatched(actions, { type: "find.move", direction: 1 });
    expect(root.querySelector("#editor-mount")).not.toBeNull();
  });

  it("renders the initial passkey enrollment capability gate", () => {
    const state = createState(VAULT_ID);
    state.authRequired = true;
    state.authError = "Credential was rejected";
    const actions = actionSpies();
    const gate = renderAuthGate(state, actions);
    gate.querySelector<HTMLInputElement>("input")!.value = "capability";
    gate.querySelector<HTMLInputElement>("input")!.dispatchEvent(new Event("input", { bubbles: true }));

    expect(gate.textContent).toContain("Credential was rejected");
    expectDispatched(actions, { type: "auth.capability", value: "capability" });
  });

  it("renders reading mode with minimal editing chrome", () => {
    const state = baseState();
    const tab = tabFromDocument({ meta: note("n1", "one.md", "One"), content: "# One\n" });
    state.tabs = [tab];
    state.activeTab = tabIdentity(tab);
    state.readingMode = true;
    state.commandOpen = true;
    state.commandFilter = "reading";
    const actions = actionSpies();
    actions.commandItems.mockReturnValue([{ id: "reading", label: "Reading mode" }]);
    const root = render(state, actions);

    expect(root.querySelector(".main")?.className).toContain("reading-mode");
    expect(root.querySelector(".topbar")).not.toBeNull();
    expect(root.querySelector(".toolbar")).toBeNull();
    expect(root.querySelector(".editor-meta")).toBeNull();
    root.querySelector<HTMLButtonElement>('[data-command-id="reading"]')!.click();
    expectDispatched(actions, { type: "command.run", id: "reading" });
  });

  it("shows tab close hint and captures x before editor key handlers", () => {
    const state = baseState();
    const tab = tabFromDocument({ meta: note("n1", "one.md", "One"), content: "# One\n" });
    state.tabs = [tab];
    state.activeTab = tabIdentity(tab);
    const actions = actionSpies();
    const root = render(state, actions);
    document.body.append(root);
    const editorKeydown = vi.fn();
    const editor = document.createElement("div");
    editor.className = "md-editor-content";
    editor.contentEditable = "true";
    editor.addEventListener("keydown", editorKeydown);
    document.body.append(editor);

    try {
      const tabButton = root.querySelector<HTMLButtonElement>(".tab")!;
      const hint = root.querySelector<HTMLElement>(".tab-close-tooltip")!;
      tabButton.dispatchEvent(new MouseEvent("mouseenter", { clientX: 112, clientY: 18 }));
      expect(hint.classList.contains("visible")).toBeTruthy();
      expect(hint.parentElement).toBe(document.body);
      expect(hint.style.left).toBe("112px");
      expect(hint.style.top).toBe("18px");

      tabButton.dispatchEvent(new MouseEvent("mousemove", { clientX: 121, clientY: 34 }));
      expect(hint.style.left).toBe("121px");
      expect(hint.style.top).toBe("34px");

      root.querySelector<HTMLButtonElement>(".tab-close")!.click();
      expectDispatched(actions, { type: "tab.close", tab: tabIdentity(tab) });
      expect(hint.parentElement).toBeNull();
      expect(hint.classList.contains("visible")).toBeFalsy();
      actions.dispatch.mockClear();

      tabButton.dispatchEvent(new MouseEvent("mouseenter", { clientX: 112, clientY: 18 }));
      const closeEvent = new KeyboardEvent("keydown", {
        key: "x",
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(closeEvent);
      expectDispatched(actions, { type: "tab.close", tab: tabIdentity(tab) });
      expect(closeEvent.defaultPrevented).toBeTruthy();
      expect(editorKeydown).not.toHaveBeenCalled();
    } finally {
      root.remove();
      editor.remove();
    }
  });

  it("shows tag pills on recent-note and search-result rows with a capped overflow", () => {
    const state = baseState();
    const tagged = note("n1", "one.md", "One", ["alpha", "beta", "gamma", "delta", "epsilon"]);
    const untagged = note("n2", "two.md", "Two");
    state.notes.set("n1", tagged);
    state.notes.set("n2", untagged);
    state.recent = [toNoteId("n1"), toNoteId("n2")];
    state.searchOpen = true;

    const recentRows = render(state).querySelectorAll<HTMLElement>(".recent-search-result");
    const recentTags = recentRows[0]!.querySelector(".search-result-tags")!;
    expect([...recentTags.querySelectorAll(".tag-pill")].map((pill) => pill.textContent)).toEqual(["#alpha", "#beta", "#gamma"]);
    expect(recentTags.querySelector(".tag-pill")!.tagName).toBe("SPAN");
    expect(recentTags.querySelector(".search-result-tags-overflow")!.textContent).toBe("+2");
    expect(recentTags.querySelector<HTMLElement>(".search-result-tags-overflow")!.title).toBe("#delta #epsilon");
    expect(recentRows[1]!.querySelector(".search-result-tags")).toBeNull();

    state.searchOverlayQuery = "alpha";
    state.searchOverlayHits = [searchHit(tagged), searchHit(untagged)];
    const hitRows = render(state).querySelectorAll<HTMLElement>(".search-result-row");
    expect(hitRows[0]!.querySelectorAll(".tag-pill")).toHaveLength(3);
    expect(hitRows[0]!.querySelector(".search-result-tags-overflow")!.textContent).toBe("+2");
    expect(hitRows[1]!.querySelector(".search-result-tags")).toBeNull();
  });

  it("omits the overflow marker when every tag fits", () => {
    const state = baseState();
    state.notes.set("n1", note("n1", "one.md", "One", ["alpha", "beta", "gamma"]));
    state.recent = [toNoteId("n1")];
    state.searchOpen = true;
    const tags = render(state).querySelector(".recent-search-result .search-result-tags")!;
    expect(tags.querySelectorAll(".tag-pill")).toHaveLength(3);
    expect(tags.querySelector(".search-result-tags-overflow")).toBeNull();
  });

  it("renders command, search, revision, settings, conflict, dialog, and notice overlays", () => {
    const state = baseState();
    const revision = revisionMeta(7);
    const noteData = note("n1", "one.md", "One");
    state.notes.set("n1", noteData);
    const tab = tabFromDocument({ meta: noteData, content: "# One\n" });
    state.tabs = [tab];
    state.activeTab = tabIdentity(tab);
    state.commandOpen = true;
    state.commandFilter = "open";
    state.searchOpen = true;
    state.searchOverlayQuery = "alpha";
    state.searchOverlayHits = [searchHit(noteData, "hit alpha", [{ startUtf16: 4, endUtf16: 9 }])];
    state.revisionsOpen = true;
    state.revisionNoteId = toNoteId(noteData.noteId);
    state.revisionList = [revision];
    state.revisionDocument = { revision, content: "# Old\n" };
    state.settingsOpen = true;
    state.conflictDraft = conflictDocument("n1");
    state.noteDialog = { kind: "rename", noteId: toNoteId("n1"), title: "One" };
    state.notice = "Saved";
    const actions = actionSpies();
    const root = render(state, actions);

    root.querySelector<HTMLInputElement>(".command-input")!.value = "save";
    root.querySelector<HTMLInputElement>(".command-input")!.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".command-row")!.click();
    root.querySelectorAll<HTMLInputElement>(".command-input")[1]!.value = "beta";
    root.querySelectorAll<HTMLInputElement>(".command-input")[1]!.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".search-result-row")!.click();
    root.querySelector<HTMLButtonElement>(".revision-row")!.click();
    root.querySelector<HTMLButtonElement>('[title="Restore selected revision"]')!.click();
    root.querySelector<HTMLButtonElement>('[title="Save settings"]')!.click();
    root.querySelector<HTMLButtonElement>('[title="Restore conflict draft"]')!.click();
    root.querySelector<HTMLButtonElement>(".note-dialog-panel .primary-button")!.click();
    root.querySelector<HTMLButtonElement>(".overlay-backdrop")!.click();

    expect(root.textContent).toContain("Revision preview");
    expect(root.textContent).toContain("Settings");
    expect(root.textContent).toContain("Conflict Draft");
    expect(root.textContent).toContain("Saved");
    expect(actions.commandItems).toHaveBeenCalledWith();
    expectDispatched(actions, { type: "search.overlayInput", query: "beta" });
    expectDispatched(actions, { type: "overlay.close" });
    expect(actions.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: "search.hitOpen",
      hit: expect.objectContaining({ excerpt: "hit alpha", identity: expect.objectContaining({ noteId: "n1" }) }),
    }));
    expectDispatched(actions, { type: "revisions.select", eventId: toRevisionEventId(7) });
    expectDispatched(actions, { type: "revisions.restore" });
    expectDispatched(actions, {
      type: "settings.submit",
      settings: {
        excludedFoldersText: "node_modules",
        autosaveDelayMs: 900,
        undoStackMax: 100,
        imageWebpQuality: 0.8,
      },
    });
    expectDispatched(actions, { type: "conflict.restore" });
    expectDispatched(actions, { type: "dialog.submit", value: "One" });
  });

  it("bounds the settings inputs with the shared limits", () => {
    const state = baseState();
    state.settingsOpen = true;
    const root = render(state, actionSpies());
    const attributes = (title: string) => {
      const field = root.querySelector<HTMLInputElement>(`input[title="${title}"]`)!;
      return { min: field.min, max: field.max, step: field.step };
    };

    expect(attributes("Autosave delay")).toStrictEqual({
      min: String(SETTINGS_LIMITS.autosaveDelayMs.min),
      max: String(SETTINGS_LIMITS.autosaveDelayMs.max),
      step: "",
    });
    expect(attributes("Undo stack")).toStrictEqual({
      min: String(SETTINGS_LIMITS.undoStackMax.min),
      max: String(SETTINGS_LIMITS.undoStackMax.max),
      step: "",
    });
    expect(attributes("Image quality")).toStrictEqual({
      min: String(SETTINGS_LIMITS.imageWebpQuality.min),
      max: String(SETTINGS_LIMITS.imageWebpQuality.max),
      step: String(SETTINGS_LIMITS.imageWebpQuality.step),
    });
  });

  it("shows an inline error and dispatches nothing for an invalid excluded folder", () => {
    const state = baseState();
    state.settingsOpen = true;
    const actions = actionSpies();
    const root = render(state, actions);
    root.querySelector<HTMLInputElement>('input[title="Excluded folders"]')!.value = "ok, a/b";
    root.querySelector<HTMLButtonElement>('[title="Save settings"]')!.click();

    expect(root.querySelector(".settings-panel .settings-error")?.textContent).toMatch(/single folder name/);
    expect(actions.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "settings.submit" }));

    root.querySelector<HTMLInputElement>('input[title="Excluded folders"]')!.value = "ok";
    root.querySelector<HTMLButtonElement>('[title="Save settings"]')!.click();
    expect(root.querySelector(".settings-panel .settings-error")?.textContent).toBe("");
    expect(actions.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "settings.submit" }));
  });

  it("shows stored values outside the server range clamped", () => {
    const state = baseState();
    state.settingsOpen = true;
    state.boot!.settings = { ...state.boot!.settings, autosaveDelayMs: 0, undoStackMax: 10_000_000 };
    const root = render(state, actionSpies());

    expect(root.querySelector<HTMLInputElement>('input[title="Autosave delay"]')!.value)
      .toBe(String(SETTINGS_LIMITS.autosaveDelayMs.min));
    expect(root.querySelector<HTMLInputElement>('input[title="Undo stack"]')!.value)
      .toBe(String(SETTINGS_LIMITS.undoStackMax.max));
  });

  it("renders empty search and delete/tag dialogs", () => {
    const state = baseState();
    state.notes.set("n1", note("n1", "one.md", "One"));
    state.searchOpen = true;
    state.searchOverlayQuery = "no matching note";
    state.noteDialog = { kind: "delete", noteId: toNoteId("n1") };
    let actions = actionSpies();
    let root = render(state, actions);
    expect(root.querySelector(".search-result-row")).toBeNull();
    root.querySelector<HTMLButtonElement>(".danger-button")!.click();
    expectDispatched(actions, { type: "dialog.submit" });

    state.noteDialog = { kind: "tag", value: "" };
    actions = actionSpies();
    root = render(state, actions);
    root
      .querySelector<HTMLFormElement>(".note-dialog-panel")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expectDispatched(actions, { type: "dialog.submit", value: "" });
  });

  it("renders the add-tag dialog with the create dialog structure", () => {
    const state = baseState();
    state.noteDialog = { kind: "create", localDraftId: localDraftId("draft-1"), title: "" };
    const create = render(state).querySelector<HTMLFormElement>(".note-dialog-panel")!;
    state.noteDialog = { kind: "tag", value: "idea" };
    const actions = actionSpies();
    const tag = render(state, actions).querySelector<HTMLFormElement>(".note-dialog-panel")!;

    expect([...tag.classList].filter((name) => name !== "is-tag")).toStrictEqual([...create.classList]);
    expect(tag.classList.contains("is-tag")).toBeTruthy();
    expect(tag.querySelector(".modal-header")).toBeNull();
    expect(tag.querySelector("label")).toBeNull();
    expect(tag.querySelector(".modal-actions")).toBeNull();
    expect([...tag.children].map((child) => child.className)).toStrictEqual(
      [...create.children].map((child) => child.className),
    );
    const field = tag.querySelector<HTMLInputElement>(".note-dialog-field > input.settings-input")!;
    expect(field.value).toBe("idea");
    expect(field.getAttribute("aria-label")).toBe("Tag");
    expect(field.placeholder).toBe("Add tag");

    field.value = "#idea-two";
    field.dispatchEvent(new Event("input"));
    expectDispatched(actions, { type: "dialog.input", value: "#idea-two" });
    const submit = new Event("submit", { bubbles: true, cancelable: true });
    tag.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBeTruthy();
    expectDispatched(actions, { type: "dialog.submit", value: "#idea-two" });

    tag.querySelector<HTMLButtonElement>(".note-dialog-field > .tab-close")!.click();
    expectDispatched(actions, { type: "overlay.close" });
  });

  it("derives one stable hue per normalized tag", () => {
    expect(tagHue("alpha")).toBe(tagHue("alpha"));
    expect(tagHue("alpha")).toBe(tagHue(" #alpha "));
    expect(tagHue("alpha")).toBe(tagHue("Alpha"));
    expect(tagHue("alpha")).not.toBe(tagHue("beta"));
    expect(tagHue("alpha")).not.toBe(tagHue("alpha-2"));
    for (const tag of ["alpha", "beta", "a-very-long-tag-name-that-wraps", "日本語"]) {
      expect(Number.isInteger(tagHue(tag))).toBeTruthy();
      expect(tagHue(tag)).toBeGreaterThanOrEqual(0);
      expect(tagHue(tag)).toBeLessThan(360);
    }
    expect(() => tagHue(" # ")).toThrow("Invalid tag");
  });

  it("renders a tag pill with its hue and the same markup for both elements", () => {
    const button = createTagPill("#Alpha", "button");
    const label = createTagPill("Alpha", "span");

    expect(button.tagName).toBe("BUTTON");
    expect(button.type).toBe("button");
    expect(label.tagName).toBe("SPAN");
    expect(button.classList.contains("tag-pill")).toBeTruthy();
    expect(button.textContent).toBe("#Alpha");
    expect(button.style.getPropertyValue("--tag-hue")).toBe(String(tagHue("Alpha")));
    expect(label.style.getPropertyValue("--tag-hue")).toBe(button.style.getPropertyValue("--tag-hue"));
    expect(label.innerHTML).toBe(button.innerHTML);
    expect(() => createTagPill("", "span")).toThrow("Invalid tag");
  });

  it("renders search excerpts as text and preserves highlighted ranges", () => {
    const state = baseState();
    state.searchOpen = true;
    state.searchOverlayQuery = "quote";
    state.searchOverlayHits = [searchHit(note("n1", "one.md", "One"), '"quote" <tag>', [{ startUtf16: 1, endUtf16: 6 }])];

    const root = render(state);
    const snippet = root.querySelector(".search-snippet")!;

    expect(snippet.textContent).toBe('"quote" <tag>');
    expect(snippet.querySelector("mark")?.textContent).toBe("quote");
    expect(snippet.querySelector("tag")).toBeNull();
  });

  it("keeps search snippets within the matched paragraph and removes a repeated heading", () => {
    const state = baseState();
    state.searchOpen = true;
    state.searchOverlayQuery = "Claude";
    const excerpt = "# Claude Search Notes\n\nSearch in Tansu should keep the surrounding text visible.\nA second Claude result makes the result list geometry stable.\nThis fixture covers source context.\n\nAnother paragraph.";
    const headingStart = excerpt.indexOf("Claude");
    const bodyStart = excerpt.indexOf("Claude", headingStart + 1);
    state.searchOverlayHits = [searchHit(
      note("n1", "Claude Search Notes.md", "Claude Search Notes"),
      excerpt,
      [
        { startUtf16: headingStart, endUtf16: headingStart + "Claude".length },
        { startUtf16: bodyStart, endUtf16: bodyStart + "Claude".length },
      ],
    )];

    const root = render(state);
    const snippet = root.querySelector(".search-snippet")!;

    expect(snippet.textContent).toBe("Search in Tansu should keep the surrounding text visible.\nA second Claude result makes the result list geometry stable.\nThis fixture covers source context.");
    expect(snippet.querySelectorAll("mark")).toHaveLength(1);
    expect(snippet.querySelector("mark")?.textContent).toBe("Claude");
  });

  it("does not show a detached note outline when no tab is active", () => {
    const actions = actionSpies();
    actions.outline.mockReturnValue({
      headings: [{ level: 1, line: 1, text: "Previous note", from: 0, to: 15 }],
      complete: true,
    });

    const root = render(baseState(), actions);

    expect(root.querySelector(".note-outline")).toBeNull();
    expect(actions.outline).not.toHaveBeenCalled();
  });
});

function render(state: State, actions = actionSpies()): HTMLElement {
  const root = document.createElement("div");
  root.append(...renderApp(state, actions));
  return root;
}

type ViewActionSpies = {
  dispatch: ReturnType<typeof vi.fn<(event: ViewEvent) => void>>;
  commandItems: ReturnType<typeof vi.fn<() => CommandItem[]>>;
  recentPreview: ReturnType<typeof vi.fn<(noteId: string) => string | null>>;
  findMatches: ReturnType<typeof vi.fn<() => readonly { from: number; to: number }[]>>;
  outline: ReturnType<typeof vi.fn<() => Outline>>;
  activeHeadingFrom: number | null;
};

function actionSpies(): ViewActionSpies {
  const commands: CommandItem[] = [{ id: "save", label: "Save note" }];
  return {
    dispatch: vi.fn<(event: ViewEvent) => void>(),
    commandItems: vi.fn<() => CommandItem[]>(() => commands),
    recentPreview: vi.fn<(noteId: string) => string | null>(() => null),
    findMatches: vi.fn<() => readonly { from: number; to: number }[]>(() => []),
    outline: vi.fn<() => Outline>(() => ({ headings: [], complete: true })),
    activeHeadingFrom: null,
  };
}

function expectDispatched(actions: ViewActionSpies, event: ViewEvent): void {
  expect(actions.dispatch).toHaveBeenCalledWith(event);
}

function baseState(): State {
  const state = createState(VAULT_ID);
  const notes: V2NoteMeta[] = [];
  state.boot = {
    serverInstanceId: serverInstanceId("server-1"),
    vaults: [{ vaultId: VAULT_ID, name: "Main" }, { vaultId: vaultId("vault-2"), name: "Work" }],
    vault: { vaultId: VAULT_ID, name: "Main" },
    notes,
    settings: settings(),
    searchStatus: { dirty: false, degraded: false },
  };
  return state;
}

function note(noteId: string, path: string, title: string, tags: string[] = []): V2NoteMeta {
  return {
    noteId,
    path,
    title,
    tags,
    revision: 1,
    sourceHash: `sha256-v2:${"a".repeat(64)}`,
    diskHash: `sha256:${"b".repeat(64)}`,
    sourceHashFormatVersion: 2,
    diskHashFormatVersion: 1,
    updatedAtMs: 1,
  };
}

function searchHit(meta: V2NoteMeta, excerpt = meta.title, excerptRanges = [{ startUtf16: 0, endUtf16: meta.title.length }]) {
  return {
    identity: { kind: "canonical" as const, noteId: meta.noteId, revision: meta.revision, sourceHash: meta.sourceHash },
    title: meta.title,
    path: meta.path,
    score: 4,
    excerpt,
    excerptRanges,
    sourceRange: null,
  };
}

function revisionMeta(revision: number): V2RevisionMeta {
  return {
    revision,
    noteId: "n1",
    kind: "save",
    source: "user",
    sourceHash: `sha256-v2:${"c".repeat(64)}`,
    createdAtMs: 1,
  };
}

function conflictDocument(noteId: string): V2ConflictDraftDocument {
  return {
    draft: {
      draftId: 7,
      noteId,
      baseRevision: 1,
      baseSourceHash: `sha256-v2:${"a".repeat(64)}`,
      sourceHash: `sha256-v2:${"d".repeat(64)}`,
      createdAtMs: 1,
    },
    content: "# Draft\n",
  };
}

function settings(): Settings {
  return {
    excludedFolders: ["node_modules"],
    searchTitleWeight: 3,
    searchHeadingWeight: 2,
    searchTagWeight: 2,
    searchContentWeight: 1,
    recencyBoost: 0,
    autosaveDelayMs: 900,
    undoStackMax: 100,
    imageWebpQuality: 0.8,
  };
}
