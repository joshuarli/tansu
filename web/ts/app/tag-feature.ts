import { button, el, span } from "../dom.ts";
import { loadedDraft, toNoteId, type State, type Tab } from "../state.ts";
import type { ViewEvent } from "./events.ts";
import { readNoteTags } from "../editor/tags.ts";

export { readNoteTags } from "../editor/tags.ts";
export { rankTagSuggestions, tagSuggestionQueries } from "./tag-suggestions.ts";

export function renderNoteTags(state: State, dispatch: (event: ViewEvent) => void, tab: Tab): HTMLElement {
  const tags = readNoteTags(loadedDraft(tab) ?? "");
  const request = button("Suggest tags", "Suggest tags", () => dispatch({ type: "tags.suggest" }), "text-button");
  request.disabled = state.readingMode || (tab.kind === "local-draft" && tab.session?.state.promotionPending === true);
  const controls = el("div", "note-tag-controls", ...tags.map((tag) => span(tag, "note-tag")), request);
  const section = el("section", "note-tags", controls);
  section.dataset["key"] = `note-tags:${tab.key}`;
  section.setAttribute("aria-label", "Note tags");
  const panel = state.tagSuggestions;
  if (panel === null || panel.tabKey !== tab.key) return section;
  const close = button("×", "Close tag suggestions", () => dispatch({ type: "tags.close" }), "text-button");
  const results = el("div", "tag-suggestions", el("div", "tag-suggestions-heading", span("Suggested tags"), close));
  results.setAttribute("aria-live", "polite");
  if (panel.phase === "loading") {
    results.append(el("p", "", "Looking for tags in matching notes…"));
    request.disabled = true;
  } else if (panel.phase === "error") {
    results.append(el("p", "tag-suggestions-error", panel.message));
  } else if (panel.suggestions.length === 0) {
    results.append(el("p", "", "No new tags found in matching notes."));
  } else {
    results.append(el("p", "tag-suggestions-explanation", "Existing tags, ranked by the number of matching notes that use them."));
    for (const suggestion of panel.suggestions) {
      const add = button(suggestion.tag, `Add tag ${suggestion.tag}`, () => dispatch({ type: "tags.apply", tag: suggestion.tag }), "tag-suggestion-add");
      add.disabled = request.disabled;
      const support = el("div", "tag-suggestion-notes");
      for (const note of suggestion.notes) {
        support.append(button(note.title, note.path, () => dispatch({ type: "note.open", noteId: toNoteId(note.noteId) }), "text-button"));
      }
      const row = el("div", "tag-suggestion", el("div", "tag-suggestion-label", add, span(`${suggestion.notes.length} ${suggestion.notes.length === 1 ? "note" : "notes"}`)), support);
      row.dataset["key"] = `tag-suggestion:${suggestion.tag}`;
      results.append(row);
    }
  }
  section.append(results);
  return section;
}

