import { setupDOM, assertEqual, assert, mockFetch } from './test-helper.ts';
const cleanup = setupDOM();
const mock = mockFetch();

mock.on('GET', '/api/notes', [
  { path: 'notes/alpha.md', title: 'Alpha' },
  { path: 'notes/beta.md', title: 'Beta' },
  { path: 'notes/gamma.md', title: 'Gamma' },
]);
mock.on('PUT', '/api/state', {});
mock.on('GET', '/api/state', { tabs: [], active: -1 });

const { checkWikiLinkTrigger, hideAutocomplete, invalidateNoteCache } = await import('./autocomplete.ts');

const contentEl = document.createElement('div');
contentEl.contentEditable = 'true';
document.body.appendChild(contentEl);

// No trigger when no [[ in text
{
  contentEl.innerHTML = '';
  const text = document.createTextNode('hello world');
  contentEl.appendChild(text);
  const range = document.createRange();
  range.setStart(text, 11);
  range.collapse(true);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  checkWikiLinkTrigger(contentEl, 'test.md');
  await new Promise(r => setTimeout(r, 50));
  assertEqual(document.querySelector('.autocomplete'), null, 'no autocomplete without [[');
}

// Trigger with [[ shows autocomplete
{
  contentEl.innerHTML = '';
  const text = document.createTextNode('see [[al');
  contentEl.appendChild(text);
  const range = document.createRange();
  range.setStart(text, 8);
  range.collapse(true);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  checkWikiLinkTrigger(contentEl, 'test.md');
  await new Promise(r => setTimeout(r, 100));
  const ac = document.querySelector('.autocomplete');
  assert(ac !== null, 'autocomplete shown');
  // Should filter to Alpha
  const items = ac!.querySelectorAll('.autocomplete-item');
  assert(items.length >= 1, 'at least one item');
  assert(items[0]!.textContent!.includes('Alpha'), 'filtered to Alpha');
}

// hideAutocomplete removes it
hideAutocomplete();
assertEqual(document.querySelector('.autocomplete'), null, 'autocomplete hidden');

// invalidateNoteCache clears cached notes (subsequent trigger re-fetches)
invalidateNoteCache();

// Already-closed wiki link should not trigger
{
  contentEl.innerHTML = '';
  const text = document.createTextNode('see [[done]] and more');
  contentEl.appendChild(text);
  const range = document.createRange();
  range.setStart(text, 21);
  range.collapse(true);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  checkWikiLinkTrigger(contentEl, 'test.md');
  await new Promise(r => setTimeout(r, 50));
  assertEqual(document.querySelector('.autocomplete'), null, 'no autocomplete after closed [[]]');
}

mock.restore();
cleanup();
console.log('All autocomplete tests passed');
