import { searchNotes, createNote, getSettings, type SearchResult } from "./api.ts";

interface Search {
  toggle(): void;
  open(filterPath?: string): void;
  close(): void;
  isOpen(): boolean;
}

interface SearchDeps {
  openTab: (path: string) => Promise<unknown>;
  invalidateNoteCache: () => void;
}

function appendExcerpt(el: HTMLElement, excerpt: string): void {
  const parts = excerpt.split(/(<b>|<\/b>)/);
  let inBold = false;
  for (const part of parts) {
    if (part === "<b>") {
      inBold = true;
      continue;
    }
    if (part === "</b>") {
      inBold = false;
      continue;
    }
    if (!part) {
      continue;
    }
    if (inBold) {
      const b = document.createElement("b");
      b.textContent = part;
      el.append(b);
    } else {
      el.append(document.createTextNode(part));
    }
  }
}

export function createSearch(deps: SearchDeps): Search {
  const overlay = document.querySelector("#search-overlay")!;
  const input = document.querySelector("#search-input")! as HTMLInputElement;
  const resultsEl = document.querySelector("#search-results")!;

  let results: SearchResult[] = [];
  let selectedIndex = 0;
  let isOpen = false;
  let scopePath: string | null = null;
  let showScoreBreakdown = true;
  let settingsRequestId = 0;
  let searchRequestId = 0;

  function refreshShowScoreBreakdown() {
    const requestId = ++settingsRequestId;
    void getSettings()
      .then((s) => {
        if (requestId === settingsRequestId) {
          showScoreBreakdown = s.show_score_breakdown;
        }
      })
      .catch(() => void 0);
  }

  // Load setting once at startup, refresh on each open
  refreshShowScoreBreakdown();

  function open(filterPath?: string) {
    searchRequestId++;
    isOpen = true;
    scopePath = filterPath ?? null;
    overlay.classList.remove("hidden");
    input.value = "";
    input.placeholder = scopePath ? `Find in note...` : "Search notes...";
    resultsEl.innerHTML = "";
    results = [];
    selectedIndex = 0;
    input.focus();
    refreshShowScoreBreakdown();
  }

  function close() {
    searchRequestId++;
    isOpen = false;
    overlay.classList.add("hidden");
    input.blur();
  }

  function toggle() {
    if (isOpen) {
      close();
    } else {
      open();
    }
  }

  async function doSearch() {
    const q = input.value.trim();
    const requestId = ++searchRequestId;
    const requestScopePath = scopePath;
    if (q.length < 2) {
      results = [];
      renderResults(q);
      return;
    }
    let nextResults: SearchResult[] = [];
    try {
      nextResults = await searchNotes(q, requestScopePath ?? undefined);
    } catch {
      nextResults = [];
    }
    if (
      requestId !== searchRequestId ||
      !isOpen ||
      input.value.trim() !== q ||
      scopePath !== requestScopePath
    ) {
      return;
    }
    results = nextResults;
    selectedIndex = 0;
    renderResults(q);
  }

  input.addEventListener("input", doSearch);

  input.addEventListener("keydown", (e) => {
    const totalItems = results.length + (input.value.trim().length > 0 ? 1 : 0);

    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % Math.max(totalItems, 1);
      updateSelection();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = (selectedIndex - 1 + Math.max(totalItems, 1)) % Math.max(totalItems, 1);
      updateSelection();
    } else if (e.key === "Enter") {
      e.preventDefault();
      selectItem();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      close();
    }
  });

  function renderResults(query: string) {
    resultsEl.innerHTML = "";

    for (const [i, r] of results.entries()) {
      const el = document.createElement("div");
      el.className = `search-result${i === selectedIndex ? " selected" : ""}`;

      const title = document.createElement("div");
      title.className = "title";
      const titleText = document.createElement("span");
      titleText.textContent = r.title;
      title.append(titleText);
      for (const tag of r.tags) {
        const pill = document.createElement("span");
        pill.className = "tag-pill";
        pill.textContent = `#${tag}`;
        title.append(pill);
      }

      const path = document.createElement("div");
      path.className = "path";
      path.textContent = r.path;

      el.append(title, path);

      if (showScoreBreakdown) {
        const score = document.createElement("div");
        score.className = "score";
        const fs = r.field_scores;
        const parts: string[] = [];
        if (fs.title > 0) {
          parts.push(`title:${fs.title.toPrecision(3)}`);
        }
        if (fs.headings > 0) {
          parts.push(`headings:${fs.headings.toPrecision(3)}`);
        }
        if (fs.tags > 0) {
          parts.push(`tags:${fs.tags.toPrecision(3)}`);
        }
        if (fs.content > 0) {
          parts.push(`content:${fs.content.toPrecision(3)}`);
        }
        score.textContent = `${r.score.toPrecision(3)}${parts.length > 0 ? ` = ${parts.join(" + ")}` : ""}`;
        el.append(score);
      }

      if (r.excerpt) {
        const excerpt = document.createElement("div");
        excerpt.className = "excerpt";
        appendExcerpt(excerpt, r.excerpt);
        el.append(excerpt);
      }

      el.onclick = () => {
        selectedIndex = i;
        selectItem();
      };
      resultsEl.append(el);
    }

    // Create note option (not shown when scoped to a single file)
    if (query.length > 0 && !scopePath) {
      const createEl = document.createElement("div");
      createEl.className = `search-create${selectedIndex === results.length ? " selected" : ""}`;
      createEl.textContent = `Create "${query}"`;
      createEl.onclick = () => {
        selectedIndex = results.length;
        selectItem();
      };
      resultsEl.append(createEl);
    }
  }

  function updateSelection() {
    const items = resultsEl.children;
    for (let i = 0; i < items.length; i++) {
      items[i]!.classList.toggle("selected", i === selectedIndex);
    }
    items[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }

  async function selectItem() {
    if (selectedIndex < results.length) {
      const r = results[selectedIndex];
      if (r) {
        close();
        await deps.openTab(r.path);
      }
    } else {
      const name = input.value.trim();
      if (!name) {
        return;
      }
      const path = name.endsWith(".md") ? name : `${name}.md`;
      close();
      try {
        await createNote(path);
        deps.invalidateNoteCache();
        await deps.openTab(path);
        /* c8 ignore next */
      } catch {
        /* ignore */
      }
    }
  }

  return { toggle, open, close, isOpen: () => isOpen };
}
