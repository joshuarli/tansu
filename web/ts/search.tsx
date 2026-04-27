import { For, Show, createSignal } from "solid-js";
import { render } from "solid-js/web";

import { createNote, getSettings, searchNotes, type SearchResult } from "./api.ts";
import { SEARCH_MIN_QUERY_LENGTH, SEARCH_SCORE_PRECISION } from "./constants.ts";

type Search = {
  toggle(): void;
  open(filterPath?: string): void;
  close(): void;
  isOpen(): boolean;
};

type SearchDeps = {
  openTab: (path: string) => Promise<unknown>;
  invalidateNoteCache: () => void;
};

type SearchController = {
  deps: SearchDeps;
  isOpen: boolean;
  scopePath: string | null;
  results: SearchResult[];
  selectedIndex: number;
  showScoreBreakdown: boolean;
  settingsRequestId: number;
  searchRequestId: number;
};

type SearchViewState = {
  isOpen: boolean;
  scopePath: string | null;
  query: string;
  results: SearchResult[];
  selectedIndex: number;
  showScoreBreakdown: boolean;
};

type SearchViewProps = {
  state: () => SearchViewState;
  onSelectResult: (index: number) => void;
  onSelectCreate: () => void;
};

let overlayEl: HTMLElement | null = null;
let inputEl: HTMLInputElement | null = null;
let resultsEl: HTMLElement | null = null;
let savedFocus: Element | null = null;
const [viewState, setViewState] = createSignal<SearchViewState>({
  isOpen: false,
  scopePath: null,
  query: "",
  results: [],
  selectedIndex: 0,
  showScoreBreakdown: true,
});
let mounted = false;
let activeController: SearchController | null = null;

function Excerpt(props: Readonly<{ excerpt: string }>) {
  const parts = props.excerpt.split(/(<b>|<\/b>)/);
  let inBold = false;
  return (
    <div class="excerpt">
      <For each={parts}>
        {(part) => {
          if (part === "<b>") {
            inBold = true;
            return null;
          }
          if (part === "</b>") {
            inBold = false;
            return null;
          }
          if (!part) {
            return null;
          }
          return inBold ? <b>{part}</b> : part;
        }}
      </For>
    </div>
  );
}

function Score(props: Readonly<{ result: SearchResult }>) {
  const fs = props.result.field_scores;
  const parts: string[] = [];
  if (fs.title > 0) {
    parts.push(`title:${fs.title.toPrecision(SEARCH_SCORE_PRECISION)}`);
  }
  if (fs.headings > 0) {
    parts.push(`headings:${fs.headings.toPrecision(SEARCH_SCORE_PRECISION)}`);
  }
  if (fs.tags > 0) {
    parts.push(`tags:${fs.tags.toPrecision(SEARCH_SCORE_PRECISION)}`);
  }
  if (fs.content > 0) {
    parts.push(`content:${fs.content.toPrecision(SEARCH_SCORE_PRECISION)}`);
  }
  return (
    <div class="score">
      {props.result.score.toPrecision(SEARCH_SCORE_PRECISION)}
      {parts.length > 0 ? ` = ${parts.join(" + ")}` : ""}
    </div>
  );
}

function SearchView(props: Readonly<SearchViewProps>) {
  return (
    <div id="search-modal" role="dialog" aria-modal="true" aria-label="Search notes">
      <input
        id="search-input"
        type="text"
        placeholder={viewState().scopePath ? "Find in note..." : "Search notes..."}
        aria-label={viewState().scopePath ? "Find in note" : "Search notes"}
        autocomplete="off"
        spellcheck={false}
      />
      <div id="search-results">
        <For each={props.state().results}>
          {(result, i) => (
            <button
              type="button"
              class={`search-result${i() === props.state().selectedIndex ? " selected" : ""}`}
              onClick={() => props.onSelectResult(i())}
            >
              <span class="title">
                <span>{result.title}</span>
                <For each={result.tags}>{(tag) => <span class="tag-pill">#{tag}</span>}</For>
              </span>
              <span class="path">{result.path}</span>
              <Show when={props.state().showScoreBreakdown}>
                <Score result={result} />
              </Show>
              <Show when={result.excerpt}>
                <Excerpt excerpt={result.excerpt} />
              </Show>
            </button>
          )}
        </For>
        <Show when={props.state().query.length > 0 && !props.state().scopePath}>
          <button
            type="button"
            class={`search-create${props.state().selectedIndex === props.state().results.length ? " selected" : ""}`}
            onClick={props.onSelectCreate}
          >
            Create "{props.state().query}"
          </button>
        </Show>
      </div>
    </div>
  );
}

function syncView(controller: SearchController, query?: string) {
  setViewState({
    isOpen: controller.isOpen,
    scopePath: controller.scopePath,
    query: query ?? inputEl?.value.trim() ?? viewState().query,
    results: controller.results,
    selectedIndex: controller.selectedIndex,
    showScoreBreakdown: controller.showScoreBreakdown,
  });
}

function updateSelection() {
  queueMicrotask(() => {
    const items = resultsEl?.children;
    items?.[viewState().selectedIndex]?.scrollIntoView({ block: "nearest" });
  });
}

async function refreshShowScoreBreakdown(controller: SearchController) {
  const requestId = ++controller.settingsRequestId;
  try {
    const settings = await getSettings();
    if (requestId !== controller.settingsRequestId) {
      return;
    }
    controller.showScoreBreakdown = settings.show_score_breakdown;
    if (activeController === controller) {
      syncView(controller);
    }
  } catch {
    /* ignore */
  }
}

async function doSearch(controller: SearchController) {
  const query = inputEl?.value.trim() ?? "";
  const requestId = ++controller.searchRequestId;
  const requestScopePath = controller.scopePath;

  if (query.length < SEARCH_MIN_QUERY_LENGTH) {
    controller.results = [];
    controller.selectedIndex = 0;
    if (activeController === controller) {
      syncView(controller, query);
    }
    return;
  }

  let nextResults: SearchResult[] = [];
  try {
    nextResults = await searchNotes(query, requestScopePath ?? undefined);
  } catch {
    nextResults = [];
  }

  const latestQuery = inputEl?.value.trim() ?? "";
  if (
    requestId !== controller.searchRequestId ||
    !controller.isOpen ||
    latestQuery !== query ||
    controller.scopePath !== requestScopePath ||
    activeController !== controller
  ) {
    return;
  }

  controller.results = nextResults;
  controller.selectedIndex = 0;
  syncView(controller, query);
}

async function selectItem(controller: SearchController, index = controller.selectedIndex) {
  const query = inputEl?.value.trim() ?? "";
  if (index < controller.results.length) {
    const result = controller.results[index];
    if (result) {
      closeController(controller);
      await controller.deps.openTab(result.path);
    }
    return;
  }

  if (!query) {
    return;
  }
  const path = query.endsWith(".md") ? query : `${query}.md`;
  closeController(controller);
  try {
    await createNote(path);
    controller.deps.invalidateNoteCache();
    await controller.deps.openTab(path);
  } catch {
    /* ignore */
  }
}

function closeController(controller: SearchController) {
  controller.searchRequestId++;
  controller.isOpen = false;
  if (activeController === controller) {
    overlayEl?.classList.add("hidden");
    inputEl?.blur();
    syncView(controller, "");
    if (savedFocus instanceof HTMLElement) {
      savedFocus.focus();
    }
    savedFocus = null;
  }
}

function ensureMounted() {
  if (mounted) {
    return;
  }
  const overlay = document.querySelector("#search-overlay");
  if (!(overlay instanceof HTMLElement)) {
    throw new Error("missing #search-overlay");
  }
  overlayEl = overlay;
  overlayEl.textContent = "";

  render(
    () => (
      <SearchView
        state={viewState}
        onSelectResult={(index) => {
          const controller = activeController;
          if (!controller) {
            return;
          }
          controller.selectedIndex = index;
          syncView(controller);
          void selectItem(controller, index);
        }}
        onSelectCreate={() => {
          const controller = activeController;
          if (!controller) {
            return;
          }
          controller.selectedIndex = controller.results.length;
          syncView(controller);
          void selectItem(controller, controller.results.length);
        }}
      />
    ),
    overlayEl,
  );

  inputEl = document.querySelector("#search-input");
  resultsEl = document.querySelector("#search-results");
  if (!(inputEl instanceof HTMLInputElement) || !(resultsEl instanceof HTMLElement)) {
    throw new Error("missing search nodes");
  }

  inputEl.addEventListener("input", () => {
    const controller = activeController;
    if (!controller) {
      return;
    }
    void doSearch(controller);
  });
  inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
    const controller = activeController;
    if (!controller) {
      return;
    }
    const totalItems =
      controller.results.length + ((inputEl?.value.trim().length ?? 0) > 0 ? 1 : 0);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      controller.selectedIndex = (controller.selectedIndex + 1) % Math.max(totalItems, 1);
      syncView(controller);
      updateSelection();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      controller.selectedIndex =
        (controller.selectedIndex - 1 + Math.max(totalItems, 1)) % Math.max(totalItems, 1);
      syncView(controller);
      updateSelection();
    } else if (e.key === "Enter") {
      e.preventDefault();
      void selectItem(controller);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeController(controller);
    }
  });
  overlayEl.addEventListener("click", (e) => {
    if (e.target === overlayEl && activeController) {
      closeController(activeController);
    }
  });

  mounted = true;
}

export function createSearch(deps: SearchDeps): Search {
  ensureMounted();

  const controller: SearchController = {
    deps,
    isOpen: false,
    scopePath: null,
    results: [],
    selectedIndex: 0,
    showScoreBreakdown: true,
    settingsRequestId: 0,
    searchRequestId: 0,
  };

  void refreshShowScoreBreakdown(controller);

  function open(filterPath?: string) {
    savedFocus = document.activeElement;
    activeController = controller;
    controller.searchRequestId++;
    controller.isOpen = true;
    controller.scopePath = filterPath ?? null;
    controller.results = [];
    controller.selectedIndex = 0;
    overlayEl?.classList.remove("hidden");
    if (inputEl) {
      inputEl.value = "";
      inputEl.placeholder = filterPath ? "Find in note..." : "Search notes...";
      inputEl.focus();
    }
    syncView(controller, "");
    void refreshShowScoreBreakdown(controller);
  }

  function close() {
    closeController(controller);
  }

  function toggle() {
    if (controller.isOpen) {
      close();
    } else {
      open();
    }
  }

  return {
    toggle,
    open,
    close,
    isOpen: () => controller.isOpen,
  };
}
