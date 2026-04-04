import { searchNotes, createNote } from './api.ts';
import type { SearchResult } from './api.ts';
import { debounce, escapeHtml } from './util.ts';
import { openTab } from './tabs.ts';
import { invalidateNoteCache } from './editor.ts';

const overlay = document.getElementById('search-overlay')!;
const input = document.getElementById('search-input')! as HTMLInputElement;
const resultsEl = document.getElementById('search-results')!;

let results: SearchResult[] = [];
let selectedIndex = 0;
let isOpen = false;

export function toggleSearch() {
  if (isOpen) closeSearch();
  else openSearch();
}

export function openSearch() {
  isOpen = true;
  overlay.classList.remove('hidden');
  input.value = '';
  resultsEl.innerHTML = '';
  results = [];
  selectedIndex = 0;
  input.focus();
}

export function closeSearch() {
  isOpen = false;
  overlay.classList.add('hidden');
  input.blur();
}

export function isSearchOpen(): boolean {
  return isOpen;
}

const doSearch = debounce(async () => {
  const q = input.value.trim();
  if (q.length < 2) {
    results = [];
    renderResults(q);
    return;
  }
  try {
    results = await searchNotes(q);
  } catch {
    results = [];
  }
  selectedIndex = 0;
  renderResults(q);
}, 150);

input.addEventListener('input', doSearch);

input.addEventListener('keydown', (e) => {
  const totalItems = results.length + (input.value.trim().length > 0 ? 1 : 0); // +1 for create option

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
    closeSearch();
  }
});

overlay.addEventListener('click', (e) => {
  if (e.target === overlay) closeSearch();
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

    if (r.excerpt) {
      const excerpt = document.createElement('div');
      excerpt.className = 'excerpt';
      excerpt.innerHTML = r.excerpt; // tantivy returns HTML with <b> tags
      el.appendChild(excerpt);
    }

    el.onclick = () => { selectedIndex = i; selectItem(); };
    resultsEl.appendChild(el);
  });

  // Create note option
  if (query.length > 0) {
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
  // Scroll into view
  items[selectedIndex]?.scrollIntoView({ block: 'nearest' });
}

async function selectItem() {
  if (selectedIndex < results.length) {
    const r = results[selectedIndex];
    if (r) {
      closeSearch();
      await openTab(r.path);
    }
  } else {
    // Create new note
    const name = input.value.trim();
    if (!name) return;
    const path = name.endsWith('.md') ? name : `${name}.md`;
    closeSearch();
    try {
      await createNote(path);
      invalidateNoteCache();
      await openTab(path);
    } catch (e) {
      console.error('Failed to create note:', e);
    }
  }
}
