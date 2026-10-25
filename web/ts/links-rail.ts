import type { ViewEvent } from "./app/events.ts";
import { button, el, span } from "./dom.ts";
import { LocalGraphView, layoutLocalGraph } from "./local-graph.ts";
import { activeTab, loadedDraft, toNoteId, type State } from "./state.ts";
import type { V2Backlink, V2LinkedNote } from "./types.generated.ts";

export const EMPTY_BACKLINKS_HINT = "no notes link here yet · type [[ to link a note";

export type MentionSegment = { text: string; link: boolean };

const MENTION_LINK = /\[\[([^\]|]*)(?:\|([^\]]*))?\]\]|\[([^\]]*)\]\([^)]*\)/g;

export function mentionSegments(mention: string): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let cursor = 0;
  for (const match of mention.matchAll(MENTION_LINK)) {
    if (match.index > cursor) segments.push({ text: mention.slice(cursor, match.index), link: false });
    const label = (match[2] ?? match[1] ?? match[3] ?? "").trim();
    segments.push({ text: label === "" ? match[0] : label, link: true });
    cursor = match.index + match[0].length;
  }
  if (cursor < mention.length) segments.push({ text: mention.slice(cursor), link: false });
  return segments;
}

export function linksRailNoteId(state: State): string | null {
  if (state.settingsOpen) return null;
  const tab = activeTab(state);
  if (tab === undefined || tab.kind !== "saved" || loadedDraft(tab) === null) return null;
  return tab.noteId;
}

const sharedGraphView = new LocalGraphView();

export function renderLinksRail(
  state: State,
  dispatch: (event: ViewEvent) => void,
  graphView: LocalGraphView = sharedGraphView,
): HTMLElement | null {
  const noteId = linksRailNoteId(state);
  if (noteId === null) return null;
  const links = state.noteLinks;
  const loaded = links !== null && links.noteId === noteId && links.phase === "ready" ? links.links : null;
  const linkCount = loaded === null ? 0 : loaded.backlinks.length + loaded.outgoing.length;
  if (state.linkRailCollapsed && linkCount === 0) return null;
  const aside = el("aside", state.linkRailCollapsed ? "link-rail collapsed" : "link-rail");
  aside.setAttribute("aria-label", "Note links");
  const toggle = button(
    state.linkRailCollapsed ? `Links · ${linkCount}` : "Hide",
    state.linkRailCollapsed ? "Show links rail" : "Hide links rail",
    () => dispatch({ type: "linkRail.toggle" }),
    "link-rail-toggle",
  );
  toggle.setAttribute("aria-expanded", String(!state.linkRailCollapsed));
  if (state.linkRailCollapsed) {
    aside.append(toggle);
    return aside;
  }
  aside.append(el("div", "link-rail-header", span("Links", "link-rail-heading"), toggle));
  const open = (id: string) => dispatch({ type: "note.open", noteId: toNoteId(id) });
  if (links === null || links.noteId !== noteId || links.phase === "loading") return aside;
  if (links.phase === "error") {
    aside.append(el(
      "p",
      "link-rail-error",
      "Links unavailable · ",
      button("retry", "Retry loading links", () => dispatch({ type: "links.refresh" }), "link-rail-retry"),
    ));
    return aside;
  }
  const meta = state.notes.get(noteId);
  const title = meta?.title ?? activeTab(state)?.title ?? noteId;
  const layout = layoutLocalGraph({ noteId, title }, links.links, state.knownLinks);
  if (layout.nodes.length > 1) {
    aside.append(el("div", "link-rail-graph", graphView.update(layout, open)));
  }
  const backlinks = el("section", "link-rail-section");
  backlinks.append(span(`Backlinks${links.links.backlinks.length === 0 ? "" : ` · ${links.links.backlinks.length}`}`, "link-rail-label"));
  if (links.links.backlinks.length === 0) backlinks.append(el("p", "link-rail-hint", EMPTY_BACKLINKS_HINT));
  for (const backlink of links.links.backlinks) backlinks.append(renderBacklink(backlink, open));
  aside.append(backlinks);
  if (links.links.outgoing.length > 0) {
    const outgoing = el("section", "link-rail-section", span("Outgoing", "link-rail-label"));
    for (const note of links.links.outgoing) outgoing.append(renderOutgoing(note, open));
    aside.append(outgoing);
  }
  return aside;
}

function linkCard(note: V2LinkedNote, className: string, open: (id: string) => void): HTMLButtonElement {
  const card = document.createElement("button");
  card.type = "button";
  card.className = className;
  card.title = note.path;
  card.dataset["key"] = `link:${className}:${note.noteId}`;
  card.addEventListener("click", () => open(note.noteId));
  card.append(span(note.title, "link-card-title"), span(note.path, "link-card-path"));
  return card;
}

function renderBacklink(backlink: V2Backlink, open: (id: string) => void): HTMLElement {
  const card = linkCard(backlink.note, "link-card", open);
  for (const mention of backlink.mentions) {
    const quote = span("", "link-card-mention");
    for (const segment of mentionSegments(mention)) {
      if (segment.link) {
        const emphasized = document.createElement("em");
        emphasized.textContent = segment.text;
        quote.append(emphasized);
      } else {
        quote.append(document.createTextNode(segment.text));
      }
    }
    card.append(quote);
  }
  return card;
}

function renderOutgoing(note: V2LinkedNote, open: (id: string) => void): HTMLElement {
  return linkCard(note, "link-card outgoing", open);
}
