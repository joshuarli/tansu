import { setupDOM, assertEqual, assert, mockFetch } from './test-helper.ts';
const cleanup = setupDOM();
const mock = mockFetch();

// Mock API responses needed by tabs
mock.on('GET', '/api/note', { content: '# Test', mtime: 1000 });
mock.on('PUT', '/api/state', {});
mock.on('GET', '/api/state', { tabs: [], active: -1 });
mock.on('DELETE', '/api/note', {});
mock.on('POST', '/api/note', { mtime: 2000 });

const {
  openTab, closeTab, getActiveTab, getTabs, getActiveIndex,
  nextTab, prevTab, markDirty, markClean, updateTabContent,
  updateTabPath, closeActiveTab,
} = await import('./tabs.ts');
const { on, clearAll } = await import('./events.ts');

// Initially no tabs
assertEqual(getActiveTab(), null, 'no active tab initially');
assertEqual(getTabs().length, 0, 'no tabs initially');
assertEqual(getActiveIndex(), -1, 'active index -1');

// Track tab changes
let changeCount = 0;
on('tab:change', () => { changeCount++; });

// Open a tab
const tab1 = await openTab('notes/hello.md');
assertEqual(tab1.path, 'notes/hello.md', 'tab1 path');
assertEqual(tab1.title, 'hello', 'tab1 title');
assertEqual(tab1.content, '# Test', 'tab1 content from api');
assertEqual(tab1.dirty, false, 'tab1 not dirty');
assertEqual(getTabs().length, 1, 'one tab');
assertEqual(getActiveIndex(), 0, 'active is 0');
assert(changeCount > 0, 'tab change callback fired');

// Open same tab again — should not duplicate
const tab1Again = await openTab('notes/hello.md');
assertEqual(getTabs().length, 1, 'no duplicate tab');
assertEqual(tab1Again.path, tab1.path, 'same tab returned');

// Open second tab
const tab2 = await openTab('notes/world.md');
assertEqual(getTabs().length, 2, 'two tabs');
assertEqual(getActiveIndex(), 1, 'active is 1');
assertEqual(getActiveTab()!.path, 'notes/world.md', 'active is tab2');

// nextTab / prevTab
await nextTab();
assertEqual(getActiveIndex(), 0, 'next wraps to 0');
await prevTab();
assertEqual(getActiveIndex(), 1, 'prev wraps to 1');

// markDirty / markClean
markDirty('notes/hello.md');
assertEqual(getTabs()[0]!.dirty, true, 'tab1 dirty');
markClean('notes/hello.md', '# Updated', 2000);
assertEqual(getTabs()[0]!.dirty, false, 'tab1 clean');
assertEqual(getTabs()[0]!.content, '# Updated', 'tab1 content updated');
assertEqual(getTabs()[0]!.mtime, 2000, 'tab1 mtime updated');

// updateTabContent
updateTabContent('notes/world.md', '# World', 3000);
assertEqual(getTabs()[1]!.content, '# World', 'tab2 content updated');

// updateTabPath
updateTabPath('notes/world.md', 'notes/earth.md');
assertEqual(getTabs()[1]!.path, 'notes/earth.md', 'tab2 path renamed');
assertEqual(getTabs()[1]!.title, 'earth', 'tab2 title after rename');

// closeTab
closeTab(0);
assertEqual(getTabs().length, 1, 'one tab after close');
assertEqual(getActiveTab()!.path, 'notes/earth.md', 'remaining tab');

// closeActiveTab
closeActiveTab();
assertEqual(getTabs().length, 0, 'no tabs after close active');
assertEqual(getActiveTab(), null, 'no active after close all');

mock.restore();
clearAll();
cleanup();
console.log('All tabs tests passed');
