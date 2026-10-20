import { describe, expect, it, vi } from "vitest";

import type { ViewEvent } from "./app/events.ts";
import { vaultId } from "./app/identity.ts";
import { EMPTY_BACKLINKS_HINT, mentionSegments, renderLinksRail } from "./links-rail.ts";
import { createState, tabFromDocument, tabIdentity, type State } from "./state.ts";
import type { V2NoteLinksResponse, V2NoteMeta } from "./types.generated.ts";

function meta(noteId: string, title: string): V2NoteMeta {
  return {
    noteId, path: `${noteId}.md`, title, tags: [], revision: 1, sourceHash: "h", diskHash: "d",
    sourceHashFormatVersion: 1, diskHashFormatVersion: 1, updatedAtMs: 0,
  };
}

function stateWithActive(): State {
  const state = createState(vaultId("v"));
  state.linkRailCollapsed = false;
  const tab = tabFromDocument({ meta: meta("n1", "One"), content: "# One\n" });
  state.tabs = [tab];
  state.activeTab = tabIdentity(tab);
  state.notes.set("n1", tab.doc!.meta);
  return state;
}

const links: V2NoteLinksResponse = {
  backlinks: [{ note: { noteId: "n2", path: "dir/two.md", title: "Two" }, mentions: ["See [[One|the one]] now", "and [One](../one.md)"] }],
  outgoing: [{ noteId: "n3", path: "three.md", title: "Three" }],
};

describe("mention segments", () => {
  it("emphasizes wiki and markdown link text and keeps surrounding text", () => {
    expect(mentionSegments("See [[One|the one]] and [[Plain]] or [md](x.md) end")).toStrictEqual([
      { text: "See ", link: false },
      { text: "the one", link: true },
      { text: " and ", link: false },
      { text: "Plain", link: true },
      { text: " or ", link: false },
      { text: "md", link: true },
      { text: " end", link: false },
    ]);
  });
});

describe("links rail", () => {
  it("renders backlinks with emphasized mentions, outgoing notes, and opens by note id", () => {
    const state = stateWithActive();
    state.noteLinks = { noteId: "n1", phase: "ready", links };
    const dispatch = vi.fn<(event: ViewEvent) => void>();
    const rail = renderLinksRail(state, dispatch)!;
    const cards = rail.querySelectorAll<HTMLButtonElement>(".link-card");
    expect(cards).toHaveLength(2);
    expect(cards[0]!.textContent).toContain("Two");
    expect(cards[0]!.textContent).toContain("dir/two.md");
    expect([...cards[0]!.querySelectorAll("em")].map((node) => node.textContent)).toStrictEqual(["the one", "One"]);
    expect(rail.textContent).toContain("Outgoing");
    expect(rail.querySelectorAll(".graph-node")).toHaveLength(3);
    cards[1]!.click();
    expect(dispatch).toHaveBeenCalledWith({ type: "note.open", noteId: "n3" });
  });

  it("shows the hint for an empty backlink list and a quiet retry on failure", () => {
    const state = stateWithActive();
    state.noteLinks = { noteId: "n1", phase: "ready", links: { backlinks: [], outgoing: [] } };
    const rail = renderLinksRail(state, vi.fn())!;
    expect(rail.querySelector(".link-rail-hint")?.textContent).toBe(EMPTY_BACKLINKS_HINT);
    expect(rail.querySelector(".local-graph")).toBeNull();

    state.noteLinks = { noteId: "n1", phase: "error", message: "boom" };
    const dispatch = vi.fn<(event: ViewEvent) => void>();
    const failed = renderLinksRail(state, dispatch)!;
    failed.querySelector<HTMLButtonElement>(".link-rail-retry")!.click();
    expect(dispatch).toHaveBeenCalledWith({ type: "links.refresh" });
  });

  it("ignores links that belong to another note and collapses to a toggle", () => {
    const state = stateWithActive();
    state.noteLinks = { noteId: "other", phase: "ready", links };
    expect(renderLinksRail(state, vi.fn())!.querySelector(".link-card")).toBeNull();

    state.linkRailCollapsed = true;
    expect(renderLinksRail(state, vi.fn())).toBeNull();

    state.noteLinks = { noteId: "n1", phase: "ready", links };
    const collapsed = renderLinksRail(state, vi.fn())!;
    expect(collapsed.classList.contains("collapsed")).toBeTruthy();
    expect(collapsed.querySelector(".link-rail-toggle")?.textContent).toBe("Links · 2");
    expect(collapsed.querySelector(".link-card")).toBeNull();

    state.noteLinks = { noteId: "n1", phase: "ready", links: { backlinks: [], outgoing: [] } };
    expect(renderLinksRail(state, vi.fn())).toBeNull();
  });

  it("is absent without an active saved note or while settings are open", () => {
    const state = stateWithActive();
    state.settingsOpen = true;
    expect(renderLinksRail(state, vi.fn())).toBeNull();
    state.settingsOpen = false;
    state.activeTab = null;
    expect(renderLinksRail(state, vi.fn())).toBeNull();
  });
});
