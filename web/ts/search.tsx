import { For, Show, createSignal } from "solid-js";

import { createNote, getSettings, searchNotes, type SearchResult } from "./api.ts";
import { scrollSelectedIndexIntoView, wrapSelectionIndex } from "./listbox.ts";
import { createManagedModal } from "./modal-manager.ts";
import { reportActionError } from "./notify.ts";
import { OverlayFrame } from "./overlay.tsx";
import { getVaultSettings } from "./settings.ts";
import { setCursor } from "./tab-state.ts";
import { uiStore } from "./ui-store.ts";

import styles from "./search.module.css";

type SearchModalProps = {
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
    <div class={`${styles["excerpt"]} excerpt`}>
      <For each={parseExcerpt(props.excerpt)}>
        {(part) => (part.bold ? <b>{part.text}</b> : part.text)}
      </For>
    </div>
  );
}

function Score(props: Readonly<{ result: SearchResult }>) {
  const settings = getVaultSettings();
  const fs = props.result.field_scores;
  const parts: string[] = [];
  if (fs.title > 0) parts.push(`title:${fs.title.toPrecision(settings.searchScorePrecision)}`);
  if (fs.headings > 0) {
    parts.push(`headings:${fs.headings.toPrecision(settings.searchScorePrecision)}`);
  }
  if (fs.tags > 0) parts.push(`tags:${fs.tags.toPrecision(settings.searchScorePrecision)}`);
  if (fs.content > 0)
    parts.push(`content:${fs.content.toPrecision(settings.searchScorePrecision)}`);
  return (
    <div class={`${styles["score"]} score`}>
      {props.result.score.toPrecision(settings.searchScorePrecision)}
      {parts.length > 0 ? ` = ${parts.join(" + ")}` : ""}
    </div>
  );
}

export function SearchModal(props: Readonly<SearchModalProps>) {
  let inputEl: HTMLInputElement | null = null;
  let resultsEl: HTMLDivElement | null = null;
  let searchRequestId = 0;
  let settingsRequestId = 0;

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
      if (reqId !== settingsRequestId) {
        return;
      }
      setShowScoreBreakdown(settings.show_score_breakdown);
    } catch {
      /* ignore */
    }
  }

  async function runSearch(rawQuery: string) {
    const trimmed = rawQuery.trim();
    const reqId = ++searchRequestId;
    const scope = uiStore.searchScopePath();

    setQuery(trimmed);

    if (trimmed.length < getVaultSettings().searchMinQueryLength) {
      setResults([]);
      setSelectedIndex(0);
      return;
    }

    let nextResults: SearchResult[] = [];
    try {
      nextResults = await searchNotes(trimmed, scope ?? undefined);
    } catch {
      nextResults = [];
    }

    const latestQuery = inputEl?.value.trim() ?? "";
    if (
      reqId !== searchRequestId ||
      !uiStore.searchVisibleOpen() ||
      latestQuery !== trimmed ||
      uiStore.searchScopePath() !== scope
    ) {
      return;
    }
    setResults(nextResults);
    setSelectedIndex(0);
  }

  async function selectItem(index = selectedIndex()) {
    const trimmed = inputEl?.value.trim() ?? "";
    const currentResults = results();
    if (index < currentResults.length) {
      const result = currentResults[index];
      if (result) {
        close();
        await props.openTab(result.path);
      }
      return;
    }
    if (!trimmed || uiStore.searchScopePath()) {
      return;
    }
    const path = trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
    close();
    try {
      const result = await createNote(path);
      const savedPath = result.path ?? path;
      setCursor(savedPath, `# ${result.title || trimmed}\n\n`.length);
      props.invalidateNoteCache();
      await props.openTab(savedPath);
    } catch (error) {
      reportActionError(`Failed to create ${path}`, error);
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    const totalItems =
      results().length + (query().length > 0 && !uiStore.searchScopePath() ? 1 : 0);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((index) => wrapSelectionIndex(index, 1, totalItems));
      updateScroll();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((index) => wrapSelectionIndex(index, -1, totalItems));
      updateScroll();
    } else if (e.key === "Enter") {
      e.preventDefault();
      void selectItem();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  function open() {
    searchRequestId++;
    setResults([]);
    setSelectedIndex(0);
    setQuery("");
    queueMicrotask(() => {
      if (inputEl) {
        inputEl.value = "";
        inputEl.focus();
      }
    });
    void refreshSettings();
  }

  function close() {
    searchRequestId++;
    setQuery("");
    if (inputEl) {
      inputEl.blur();
    }
    uiStore.closeSearch();
  }

  const modal = createManagedModal({
    id: "search",
    isRequestedOpen: uiStore.isSearchRequestedOpen,
    onOpen: open,
    onClose: close,
  });

  return (
    <Show when={modal.shouldRender()}>
      <OverlayFrame
        id="search-overlay"
        class={styles["overlay"]}
        isOpen={modal.isOpen()}
        onClose={modal.close}
      >
        <div
          class={`${styles["modal"]} search-modal`}
          role="dialog"
          aria-modal="true"
          aria-label="Search notes"
        >
          <input
            id="search-input"
            class={styles["input"]}
            ref={(el) => {
              inputEl = el;
            }}
            type="text"
            placeholder={uiStore.searchScopePath() ? "Find in note..." : "Search notes..."}
            aria-label={uiStore.searchScopePath() ? "Find in note" : "Search notes"}
            autocomplete="off"
            spellcheck={false}
            on:input={(e) => {
              void runSearch(e.currentTarget.value);
            }}
            on:keydown={handleKeyDown}
          />
          <div
            id="search-results"
            class={styles["results"]}
            ref={(el) => {
              resultsEl = el;
            }}
          >
            <For each={results()}>
              {(result, index) => (
                <button
                  type="button"
                  class={`${styles["result"]} search-result${
                    index() === selectedIndex() ? ` ${styles["selected"]} selected` : ""
                  }`}
                  onClick={() => void selectItem(index())}
                >
                  <span class={`${styles["title"]} title`}>
                    <span>{result.title}</span>
                    <For each={result.tags}>{(tag) => <span class="tag-pill">#{tag}</span>}</For>
                  </span>
                  <span class={`${styles["path"]} path`}>{result.path}</span>
                  <Show when={showScoreBreakdown()}>
                    <Score result={result} />
                  </Show>
                  <Show when={result.excerpt}>
                    <Excerpt excerpt={result.excerpt} />
                  </Show>
                </button>
              )}
            </For>
            <Show when={query().length > 0 && !uiStore.searchScopePath()}>
              <button
                type="button"
                class={`${styles["create"]} search-create${
                  selectedIndex() === results().length ? ` ${styles["selected"]} selected` : ""
                }`}
                onClick={() => void selectItem(results().length)}
              >
                Create "{query()}"
              </button>
            </Show>
          </div>
        </div>
      </OverlayFrame>
    </Show>
  );
}
