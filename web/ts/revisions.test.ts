import { setupDOM, assertEqual, assert, mockFetch } from './test-helper.ts';
const cleanup = setupDOM();
const mock = mockFetch();

mock.on('GET', /\/api\/revisions\?/, [1000, 2000, 3000]);
mock.on('GET', /\/api\/revision\?/, { content: '# Old version' });
mock.on('POST', '/api/restore', { mtime: 5000 });

const { toggleRevisions, hideRevisions, setOnRestore } = await import('./revisions.ts');

// Track restore calls
let restoredContent: string | null = null;
let restoredMtime = 0;
setOnRestore((content, mtime) => {
  restoredContent = content;
  restoredMtime = mtime;
});

// Show revisions
toggleRevisions('test.md');
await new Promise(r => setTimeout(r, 200));

// Panel should be in the DOM
const panel = document.querySelector('.revisions-panel');
assert(panel !== null, 'revisions panel created');

// Header
const header = panel!.querySelector('.revisions-header');
assert(header !== null, 'header exists');
assert(header!.textContent!.includes('Revisions'), 'header text');

// Revision items
const items = panel!.querySelectorAll('.revision-item');
assertEqual(items.length, 3, 'three revision items');

// Each item has a restore button
const restoreBtn = items[0]!.querySelector('.restore-btn');
assert(restoreBtn !== null, 'restore button exists');
assertEqual(restoreBtn!.textContent, 'Restore', 'restore button text');

// Hide revisions
hideRevisions();
assertEqual(document.querySelector('.revisions-panel'), null, 'panel removed');

// Toggle: show then toggle again hides
toggleRevisions('test.md');
await new Promise(r => setTimeout(r, 200));
assert(document.querySelector('.revisions-panel') !== null, 'panel shown again');
toggleRevisions('test.md');
assertEqual(document.querySelector('.revisions-panel'), null, 'toggle hides');

// Toggle different path shows new panel
toggleRevisions('a.md');
await new Promise(r => setTimeout(r, 200));
assert(document.querySelector('.revisions-panel') !== null, 'new path panel shown');
hideRevisions();

mock.restore();
cleanup();
console.log('All revisions tests passed');
