import { searchNotes, createNote, getSettings } from './api.ts';
import type { SearchResult } from './api.ts';
import { debounce, escapeHtml } from './util.ts';

export interface Search {
  toggle(): void;
  open(filterPath?: string): void;
  close(): void;
  isOpen(): boolean;
}

export interface SearchDeps {
  openTab: (path: string) => Promise<unknown>;
  invalidateNoteCache: () => void;
}

export function createSearch(deps: SearchDeps): Search {
  const overlay = document.getElementById('search-overlay')!;
  const input = document.getElementById('search-input')! as HTMLInputElement;
  const resultsEl = document.getElementById('search-results')!;

  let results: SearchResult[] = [];
  let selectedIndex = 0;
  let isOpen = false;
  let scopePath: string | null = null;
  let showScoreBreakdown = true;

  // Load setting once at startup, refresh on each open
  getSettings().then(s => { showScoreBreakdown = s.show_score_breakdown; }).catch((e) => { console.warn('Failed to load settings:', e); });

  function open(filterPath?: string) {
    isOpen = true;
    scopePath = filterPath ?? null;
    overlay.classList.remove('hidden');
    input.value = '';
    input.placeholder = scopePath ? `Find in note...` : 'Search notes...';
    resultsEl.innerHTML = '';
    results = [];
    selectedIndex = 0;
    input.focus();
    getSettings().then(s => { showScoreBreakdown = s.show_score_breakdown; }).catch((e) => { console.warn('Failed to load settings:', e); });
  }

  function close() {
    isOpen = false;
    overlay.classList.add('hidden');
    input.blur();
  }

  function toggle() {
    if (isOpen) close();
    else open();
  }

  const doSearch = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) {
      results = [];
      renderResults(q);
      return;
    }
    try {
      results = await searchNotes(q, scopePath ?? undefined);
    } catch (e) {
      console.warn('Search failed:', e);
      results = [];
    }
    selectedIndex = 0;
    renderResults(q);
  }, 150);

  input.addEventListener('input', doSearch);

  input.addEventListener('keydown', (e) => {
    const totalItems = results.length + (input.value.trim().length > 0 ? 1 : 0);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % Math.max(totalItems, 1);
      updateSelection();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = (selectedIndex - 1 + Math.max(totalItems, 1)) % Math.max(totalItems, 1);
      updateSelection();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      selectItem();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  function renderResults(query: string) {
    resultsEl.innerHTML = '';

    results.forEach((r, i) => {
      const el = document.createElement('div');
      el.className = 'search-result' + (i === selectedIndex ? ' selected' : '');

      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = r.title;

      const path = document.createElement('div');
      path.className = 'path';
      path.textContent = r.path;

      el.append(title, path);

      if (showScoreBreakdown) {
        const score = document.createElement('div');
        score.className = 'score';
        const fs = r.field_scores;
        const parts: string[] = [];
        if (fs.title > 0) parts.push(`title:${fs.title.toPrecision(3)}`);
        if (fs.headings > 0) parts.push(`headings:${fs.headings.toPrecision(3)}`);
        if (fs.tags > 0) parts.push(`tags:${fs.tags.toPrecision(3)}`);
        if (fs.content > 0) parts.push(`content:${fs.content.toPrecision(3)}`);
        score.textContent = `${r.score.toPrecision(3)}${parts.length ? ' = ' + parts.join(' + ') : ''}`;
        el.appendChild(score);
      }

      if (r.excerpt) {
        const excerpt = document.createElement('div');
        excerpt.className = 'excerpt';
        excerpt.innerHTML = r.excerpt;
        el.appendChild(excerpt);
      }

      el.onclick = () => { selectedIndex = i; selectItem(); };
      resultsEl.appendChild(el);
    });

    // Create note option (not shown when scoped to a single file)
    if (query.length > 0 && !scopePath) {
      const createEl = document.createElement('div');
      createEl.className = 'search-create' + (selectedIndex === results.length ? ' selected' : '');
      createEl.textContent = `Create "${query}"`;
      createEl.onclick = () => { selectedIndex = results.length; selectItem(); };
      resultsEl.appendChild(createEl);
    }
  }

  function updateSelection() {
    const items = resultsEl.children;
    for (let i = 0; i < items.length; i++) {
      items[i]!.classList.toggle('selected', i === selectedIndex);
    }
    items[selectedIndex]?.scrollIntoView({ block: 'nearest' });
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
      if (!name) return;
      const path = name.endsWith('.md') ? name : `${name}.md`;
      close();
      try {
        await createNote(path);
        deps.invalidateNoteCache();
        await deps.openTab(path);
      } catch (e) {
        console.error('Failed to create note:', e);
      }
    }
  }

  return { toggle, open, close, isOpen: () => isOpen };
}
