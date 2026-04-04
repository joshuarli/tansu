import { toggleSearch, closeSearch, isSearchOpen } from './search.ts';
import {
  setOnTabChange, setOnTabClose, closeActiveTab, nextTab, prevTab,
  getActiveTab, openTab, updateTabPath, updateTabContent,
} from './tabs.ts';
import { initEditor, showEditor, hideEditor, saveCurrentNote, reloadFromDisk, invalidateNoteCache } from './editor.ts';
import { registerWikiLinkExtension } from './wikilinks.ts';
import { renameNote, getNote, listNotes } from './api.ts';
import { stemFromPath } from './util.ts';
import type { Tab } from './tabs.ts';

// Initialize editor
initEditor();

// Register wiki-link extension for marked.js
registerWikiLinkExtension(async (target: string) => {
  // Resolve wiki-link: find matching note
  const notes = await listNotes();
  const normalized = target.toLowerCase().replace(/\s+/g, '-');

  // Try to find by stem match
  const match = notes.find(n => {
    const stem = stemFromPath(n.path).toLowerCase().replace(/\s+/g, '-');
    return stem === normalized;
  });

  if (match) {
    await openTab(match.path);
  } else {
    // Create the note
    const path = `${target}.md`;
    const { createNote } = await import('./api.ts');
    await createNote(path);
    invalidateNoteCache();
    await openTab(path);
  }
});

// Tab change handler: show/hide editor
setOnTabChange((tab: Tab | null) => {
  if (tab) {
    showEditor(tab.path, tab.content);
  } else {
    hideEditor();
  }
});

setOnTabClose((_tab: Tab) => {
  // Nothing special needed
});

// Global keyboard shortcuts
document.addEventListener('keydown', (e) => {
  const meta = e.metaKey || e.ctrlKey;

  if (meta && e.key === 'k') {
    e.preventDefault();
    toggleSearch();
    return;
  }

  if (e.key === 'Escape' && isSearchOpen()) {
    e.preventDefault();
    closeSearch();
    return;
  }

  if (meta && e.key === 'w') {
    e.preventDefault();
    closeActiveTab();
    return;
  }

  if (meta && e.shiftKey && e.key === ']') {
    e.preventDefault();
    nextTab();
    return;
  }

  if (meta && e.shiftKey && e.key === '[') {
    e.preventDefault();
    prevTab();
    return;
  }

  if (meta && e.key === 's') {
    e.preventDefault();
    saveCurrentNote();
    return;
  }
});

// Rename handler (dispatched from tab context menu)
window.addEventListener('tansu:rename', async (e: Event) => {
  const detail = (e as CustomEvent).detail as { path: string; newName: string };
  const oldPath = detail.path;
  const dir = oldPath.includes('/') ? oldPath.substring(0, oldPath.lastIndexOf('/') + 1) : '';
  const newPath = `${dir}${detail.newName}.md`;

  try {
    const result = await renameNote(oldPath, newPath);
    invalidateNoteCache();
    updateTabPath(oldPath, newPath);

    // Reload any other open tabs that were updated
    for (const updated of result.updated) {
      try {
        const note = await getNote(updated);
        updateTabContent(updated, note.content, note.mtime);
      } catch {}
    }

    // Refresh current editor if it was the renamed tab
    const active = getActiveTab();
    if (active && active.path === newPath) {
      showEditor(active.path, active.content);
    }
  } catch (e) {
    console.error('Rename failed:', e);
  }
});

// SSE: connect for live reload
function connectSSE() {
  const es = new EventSource('/events');

  es.addEventListener('changed', async (e) => {
    const path = e.data;
    const active = getActiveTab();
    if (active && active.path === path) {
      try {
        const note = await getNote(path);
        reloadFromDisk(note.content, note.mtime);
      } catch {}
    }
  });

  es.addEventListener('deleted', (e) => {
    const path = e.data;
    invalidateNoteCache();
    const active = getActiveTab();
    if (active && active.path === path) {
      alert(`"${stemFromPath(path)}" was deleted externally.`);
      closeActiveTab();
    }
  });

  es.onerror = () => {
    es.close();
    // Retry after 3 seconds
    setTimeout(connectSSE, 3000);
  };
}

connectSSE();
