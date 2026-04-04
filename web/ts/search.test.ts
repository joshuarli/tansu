import { setupDOM, assertEqual, assert, mockFetch } from './test-helper.ts';
const cleanup = setupDOM();
const mock = mockFetch();

// Mock APIs needed at import time
mock.on('GET', '/api/settings', {
  weight_title: 10, weight_headings: 5, weight_tags: 2, weight_content: 1,
  fuzzy_distance: 1, result_limit: 20, show_score_breakdown: true, excluded_folders: [],
});
mock.on('GET', '/api/note', { content: '', mtime: 1000 });
mock.on('PUT', '/api/state', {});
mock.on('GET', '/api/state', { tabs: [], active: -1 });
mock.on('GET', '/api/search', [
  { path: 'a.md', title: 'Alpha', excerpt: 'test', score: 1.5,
    field_scores: { title: 1, headings: 0.5, tags: 0, content: 0 } },
]);

const { createSearch } = await import('./search.ts');
const { toggle: toggleSearch, open: openSearch, close: closeSearch, isOpen: isSearchOpen } = createSearch({
  openTab: async () => {},
  invalidateNoteCache: () => {},
});

// Initially closed
assertEqual(isSearchOpen(), false, 'initially closed');

// Open
openSearch();
assertEqual(isSearchOpen(), true, 'opened');
const overlay = document.getElementById('search-overlay')!;
assert(!overlay.classList.contains('hidden'), 'overlay visible');

// Input is focused and cleared
const input = document.getElementById('search-input')! as HTMLInputElement;
assertEqual(input.value, '', 'input cleared');

// Close
closeSearch();
assertEqual(isSearchOpen(), false, 'closed');
assert(overlay.classList.contains('hidden'), 'overlay hidden');

// Toggle
toggleSearch();
assertEqual(isSearchOpen(), true, 'toggle opens');
toggleSearch();
assertEqual(isSearchOpen(), false, 'toggle closes');

// Open with scope
openSearch('notes/a.md');
assertEqual(isSearchOpen(), true, 'scoped open');
assertEqual(input.placeholder, 'Find in note...', 'scoped placeholder');
closeSearch();

// Open without scope
openSearch();
assertEqual(input.placeholder, 'Search notes...', 'unscoped placeholder');

// Keyboard: Escape closes
input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
assertEqual(isSearchOpen(), false, 'escape closes');

// Overlay click closes
openSearch();
overlay.click();
// The click handler checks e.target === overlay — direct click should close
assertEqual(isSearchOpen(), false, 'overlay click closes');

mock.restore();
cleanup();
console.log('All search tests passed');
