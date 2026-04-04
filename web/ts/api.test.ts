import { assertEqual, assertRejects, mockFetch } from './test-helper.ts';
import {
  searchNotes, getNote, saveNote, createNote, deleteNote,
  renameNote, listNotes, getBacklinks, uploadImage,
  listRevisions, getRevision, restoreRevision,
  getState, saveState, getSettings, saveSettings,
} from './api.ts';

const mock = mockFetch();

// searchNotes
mock.on('GET', '/api/search', [{ path: 'a.md', title: 'A', excerpt: '', score: 1, field_scores: { title: 1, headings: 0, tags: 0, content: 0 } }]);
const results = await searchNotes('test');
assertEqual(results.length, 1, 'search returns results');
assertEqual(results[0]!.path, 'a.md', 'search result path');

// searchNotes with path scope
mock.on('GET', '/api/search', []);
const scoped = await searchNotes('test', 'notes/a.md');
assertEqual(scoped.length, 0, 'scoped search');

// getNote
mock.on('GET', '/api/note', { content: '# Hello', mtime: 1000 });
const note = await getNote('test.md');
assertEqual(note.content, '# Hello', 'getNote content');
assertEqual(note.mtime, 1000, 'getNote mtime');

// saveNote success
mock.on('PUT', '/api/note', { mtime: 2000 });
const saved = await saveNote('test.md', '# Updated', 1000);
assertEqual(saved.mtime, 2000, 'saveNote mtime');
assertEqual(saved.conflict, undefined, 'saveNote no conflict');

// saveNote conflict
mock.on('PUT', '/api/note', { mtime: 3000, content: '# Conflict' }, 409);
const conflict = await saveNote('test.md', '# Mine', 1000);
assertEqual(conflict.conflict, true, 'saveNote conflict');
assertEqual(conflict.content, '# Conflict', 'saveNote conflict content');

// createNote
mock.on('POST', '/api/note', { mtime: 4000 });
const created = await createNote('new.md');
assertEqual(created.mtime, 4000, 'createNote mtime');

// deleteNote
mock.on('DELETE', '/api/note', {});
await deleteNote('old.md'); // should not throw

// renameNote
mock.on('POST', '/api/rename', { updated: ['a.md', 'b.md'] });
const renamed = await renameNote('old.md', 'new.md');
assertEqual(renamed.updated.length, 2, 'rename updated count');

// listNotes
mock.on('GET', '/api/notes', [{ path: 'a.md', title: 'A' }]);
const notes = await listNotes();
assertEqual(notes.length, 1, 'listNotes');

// getBacklinks
mock.on('GET', '/api/backlinks', ['ref.md']);
const backlinks = await getBacklinks('test.md');
assertEqual(backlinks[0], 'ref.md', 'backlinks');

// uploadImage
mock.on('POST', '/api/image', { filename: 'img.webp' });
const blob = new Blob(['data'], { type: 'image/webp' });
const filename = await uploadImage(blob, 'img.webp');
assertEqual(filename, 'img.webp', 'uploadImage');

// listRevisions
mock.on('GET', '/api/revisions', [1000, 2000]);
const revisions = await listRevisions('test.md');
assertEqual(revisions.length, 2, 'listRevisions');

// getRevision
mock.on('GET', '/api/revision', { content: '# Old' });
const rev = await getRevision('test.md', 1000);
assertEqual(rev, '# Old', 'getRevision');

// restoreRevision
mock.on('POST', '/api/restore', { mtime: 5000 });
const restored = await restoreRevision('test.md', 1000);
assertEqual(restored.mtime, 5000, 'restoreRevision');

// getState
mock.on('GET', '/api/state', { tabs: ['a.md'], active: 0 });
const state = await getState();
assertEqual(state.tabs!.length, 1, 'getState tabs');

// saveState
mock.on('PUT', '/api/state', {});
await saveState({ tabs: ['a.md'], active: 0 }); // should not throw

// getSettings
mock.on('GET', '/api/settings', {
  weight_title: 10, weight_headings: 5, weight_tags: 2, weight_content: 1,
  fuzzy_distance: 1, result_limit: 20, show_score_breakdown: true, excluded_folders: [],
});
const settings = await getSettings();
assertEqual(settings.weight_title, 10, 'getSettings');

// saveSettings
mock.on('PUT', '/api/settings', {});
await saveSettings(settings); // should not throw

// Error cases: 500 response
mock.on('GET', '/api/notes', {}, 500);
await assertRejects(() => listNotes(), 'listNotes error');

mock.restore();
console.log('All api tests passed');
