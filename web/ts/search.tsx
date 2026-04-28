import { For, Show, createSignal } from "solid-js";
import { render } from "solid-js/web";

import { createNote, getSettings, searchNotes, type SearchResult } from "./api.ts";
import { SEARCH_MIN_QUERY_LENGTH, SEARCH_SCORE_PRECISION } from "./constants.ts";
import { scrollSelectedIndexIntoView, wrapSelectionIndex } from "./listbox.ts";
import { reportActionError } from "./notify.ts";
import { createFocusRestorer, OverlayFrame } from "./overlay.tsx";

export type Search = {
  toggle(): void;
  open(filterPath?: string): void;
  close(): void;
  isOpen(): boolean;
};

type SearchDeps = {
  root: HTMLElement;
  openTab: (path: string) => Promise<unknown>;
  invalidateNoteCache: () => void;
};

type ExcerptPart = { text: string; bold: boolean };

function parseExcerpt(raw: string): ExcerptPart[] {
  const parts = raw.split(/(<b>|<\/b>)/);
  const result: ExcerptPart[] = [];
  let inBold = false;
  for (const part of parts) {
    if (part === "<b>") {
      inBold = true;
    } else if (part === "</b>") {
      inBold = false;
    } else if (part) {
      result.push({ text: part, bold: inBold });
    }
  }
  return result;
}

function Excerpt(props: Readonly<{ excerpt: string }>) {
  return (
    <div class="excerpt">
      <For each={parseExcerpt(props.excerpt)}>
        {(part) => (part.bold ? <b>{part.text}</b> : part.text)}
      </For>
    </div>
  );
}

function Score(props: Readonly<{ result: SearchResult }>) {
  const fs = props.result.field_scores;
  const parts: string[] = [];
  if (fs.title > 0) parts.push(`title:${fs.title.toPrecision(SEARCH_SCORE_PRECISION)}`);
  if (fs.headings > 0) parts.push(`headings:${fs.headings.toPrecision(SEARCH_SCORE_PRECISION)}`);
  if (fs.tags > 0) parts.push(`tags:${fs.tags.toPrecision(SEARCH_SCORE_PRECISION)}`);
  if (fs.content > 0) parts.push(`content:${fs.content.toPrecision(SEARCH_SCORE_PRECISION)}`);
  return (
    <div class="score">
      {props.result.score.toPrecision(SEARCH_SCORE_PRECISION)}
      {parts.length > 0 ? ` = ${parts.join(" + ")}` : ""}
    </div>
  );
}

type SearchViewProps = {
  inputRef: (el: HTMLInputElement) => void;
  resultsRef: (el: HTMLDivElement) => void;
  scopePath: () => string | null;
  results: () => SearchResult[];
  selectedIndex: () => number;
  showScoreBreakdown: () => boolean;
  query: () => string;
  onInput: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
  onSelectResult: (index: number) => void;
  onSelectCreate: () => void;
};

function SearchView(props: Readonly<SearchViewProps>) {
  return (
    <div class="search-modal" role="dialog" aria-modal="true" aria-label="Search notes">
      <input
        id="search-input"
        ref={props.inputRef}
        type="text"
        placeholder={props.scopePath() ? "Find in note..." : "Search notes..."}
        aria-label={props.scopePath() ? "Find in note" : "Search notes"}
        autocomplete="off"
        spellcheck={false}
        on:input={props.onInput}
        on:keydown={props.onKeyDown}
      />
      <div id="search-results" ref={props.resultsRef}>
        <For each={props.results()}>
          {(result, i) => (
            <button
              type="button"
              class={`search-result${i() === props.selectedIndex() ? " selected" : ""}`}
              onClick={() => props.onSelectResult(i())}
            >
              <span class="title">
                <span>{result.title}</span>
                <For each={result.tags}>{(tag) => <span class="tag-pill">#{tag}</span>}</For>
              </span>
              <span class="path">{result.path}</span>
              <Show when={props.showScoreBreakdown()}>
                <Score result={result} />
              </Show>
              <Show when={result.excerpt}>
                <Excerpt excerpt={result.excerpt} />
              </Show>
            </button>
          )}
        </For>
        <Show when={props.query().length > 0 && !props.scopePath()}>
          <button
            type="button"
            class={`search-create${props.selectedIndex() === props.results().length ? " selected" : ""}`}
            onClick={props.onSelectCreate}
          >
            Create "{props.query()}"
          </button>
        </Show>
      </div>
    </div>
  );
}

export function initSearch(deps: SearchDeps): Search {
  let inputEl: HTMLInputElement | null = null;
  let resultsEl: HTMLDivElement | null = null;
  let searchRequestId = 0;
  let settingsRequestId = 0;
  const focus = createFocusRestorer();

  const [isOpen, setIsOpen] = createSignal(false);
  const [scopePath, setScopePath] = createSignal<string | null>(null);
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<SearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [showScoreBreakdown, setShowScoreBreakdown] = createSignal(true);

  function updateScroll() {
    scrollSelectedIndexIntoView(resultsEl, selectedIndex());
  }

  async function refreshSettings() {
    const reqId = ++settingsRequestId;
    try {
      const settings = await getSettings();
      if (reqId !== settingsRequestId) return;
      setShowScoreBreakdown(settings.show_score_breakdown);
    } catch {
      /* ignore */
    }
  }

  async function doSearch() {
    const q = inputEl?.value.trim() ?? "";
    const reqId = ++searchRequestId;
    const scope = scopePath();

    setQuery(q);

    if (q.length < SEARCH_MIN_QUERY_LENGTH) {
      setResults([]);
      setSelectedIndex(0);
      return;
    }

    let nextResults: SearchResult[] = [];
    try {
      nextResults = await searchNotes(q, scope ?? undefined);
    } catch {
      nextResults = [];
    }

    const latestQ = inputEl?.value.trim() ?? "";
    if (reqId !== searchRequestId || !isOpen() || latestQ !== q || scopePath() !== scope) return;
    setResults(nextResults);
    setSelectedIndex(0);
  }

  async function selectItem(index = selectedIndex()) {
    const q = inputEl?.value.trim() ?? "";
    const res = results();
    if (index < res.length) {
      const result = res[index];
      if (result) {
        close();
        await deps.openTab(result.path);
      }
      return;
    }
    if (!q) return;
    const path = q.endsWith(".md") ? q : `${q}.md`;
    close();
    try {
      await createNote(path);
      deps.invalidateNoteCache();
      await deps.openTab(path);
    } catch (error) {
      reportActionError(`Failed to create ${path}`, error);
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    const totalItems = results().length + ((inputEl?.value.trim().length ?? 0) > 0 ? 1 : 0);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => wrapSelectionIndex(i, 1, totalItems));
      updateScroll();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => wrapSelectionIndex(i, -1, totalItems));
      updateScroll();
    } else if (e.key === "Enter") {
      e.preventDefault();
      void selectItem();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  function open(filterPath?: string) {
    focus.remember();
    searchRequestId++;
    setIsOpen(true);
    setScopePath(filterPath ?? null);
    setResults([]);
    setSelectedIndex(0);
    setQuery("");
    if (inputEl) {
      inputEl.value = "";
      inputEl.focus();
    }
    void refreshSettings();
  }

  function close() {
    searchRequestId++;
    setIsOpen(false);
    setQuery("");
    if (inputEl) inputEl.blur();
    focus.restore();
  }

  render(
    () => (
      <OverlayFrame id="search-overlay" isOpen={isOpen()} onClose={close}>
        <SearchView
          inputRef={(el) => {
            inputEl = el;
          }}
          resultsRef={(el) => {
            resultsEl = el;
          }}
          scopePath={scopePath}
          results={results}
          selectedIndex={selectedIndex}
          showScoreBreakdown={showScoreBreakdown}
          query={query}
          onInput={() => void doSearch()}
          onKeyDown={handleKeyDown}
          onSelectResult={(i) => {
            setSelectedIndex(i);
            void selectItem(i);
          }}
          onSelectCreate={() => {
            setSelectedIndex(results().length);
            void selectItem(results().length);
          }}
        />
      </OverlayFrame>
    ),
    deps.root,
  );

  return {
    toggle() {
      if (isOpen()) close();
      else open();
    },
    open,
    close,
    isOpen,
  };
}
