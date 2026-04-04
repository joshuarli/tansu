import { createSearch } from './search.ts';
import { createSettings } from './settings.ts';
import { createPalette } from './palette.ts';
import {
  closeActiveTab, nextTab, prevTab,
  getActiveTab, openTab, updateTabPath, updateTabContent, restoreSession,
  createNewNote,
} from './tabs.ts';
import type { Tab } from './tabs.ts';
import { on } from './events.ts';
import { initEditor, showEditor, hideEditor, saveCurrentNote, reloadFromDisk, invalidateNoteCache } from './editor.ts';
import { registerWikiLinkClickHandler } from './wikilinks.ts';
import { renameNote, getNote, listNotes } from './api.ts';
import { stemFromPath } from './util.ts';

// Initialize modules
initEditor();
const palette = createPalette();
const settings = createSettings();
const search = createSearch({ openTab, invalidateNoteCache });

// Wiki-link click handler
registerWikiLinkClickHandler(async (target: string) => {
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
on<Tab | null>('tab:change', (tab) => {
  if (tab) {
    showEditor(tab.path, tab.content);
  } else {
    hideEditor();
  }
});

// Register command palette commands
palette.registerCommands([
  { label: 'Search notes', shortcut: '\u2318K', action: () => search.open() },
  { label: 'Search in current note', shortcut: '\u2318F', action: () => {
    const tab = getActiveTab();
    if (tab) search.open(tab.path);
    else search.open();
  }},
  { label: 'Global search', shortcut: '\u21e7\u2318F', action: () => search.open() },
  { label: 'New note', shortcut: '\u2318T', action: () => createNewNote() },
  { label: 'Save', shortcut: '\u2318S', action: () => saveCurrentNote() },
  { label: 'Close tab', shortcut: '\u2318W', action: () => closeActiveTab() },
  { label: 'Next tab', shortcut: '\u21e7\u2318]', action: () => nextTab() },
  { label: 'Previous tab', shortcut: '\u21e7\u2318[', action: () => prevTab() },
  { label: 'Settings', shortcut: '\u21e7\u2318S', action: () => settings.toggle() },
]);

// Global keyboard shortcuts
document.addEventListener('keydown', (e) => {
  const meta = e.metaKey || e.ctrlKey;

  if (meta && e.key === 'p') {
    e.preventDefault();
    palette.toggle();
    return;
  }

  if (meta && e.key === 'k') {
    e.preventDefault();
    search.toggle();
    return;
  }

  if (meta && e.shiftKey && e.key === 'f') {
    e.preventDefault();
    search.open();
    return;
  }

  if (meta && !e.shiftKey && e.key === 'f') {
    e.preventDefault();
    const tab = getActiveTab();
    if (tab) search.open(tab.path);
    else search.open();
    return;
  }

  // Cmd+Shift+S: settings
  if (meta && e.shiftKey && e.key === 's') {
    e.preventDefault();
    settings.toggle();
    return;
  }

  // Cmd+S: save
  if (meta && !e.shiftKey && e.key === 's') {
    e.preventDefault();
    saveCurrentNote();
    return;
  }

  // Cmd+T: new note
  if (meta && e.key === 't') {
    e.preventDefault();
    createNewNote();
    return;
  }

  if (e.key === 'Escape') {
    if (palette.isOpen()) { e.preventDefault(); palette.close(); return; }
    if (settings.isOpen()) { e.preventDefault(); settings.close(); return; }
    if (search.isOpen()) { e.preventDefault(); search.close(); return; }
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

    // Reload any other open tabs that were updated (in parallel)
    await Promise.all(result.updated.map(async (updated) => {
      try {
        const note = await getNote(updated);
        updateTabContent(updated, note.content, note.mtime);
      } catch (e) { console.warn('Failed to reload tab after rename:', e); }
    }));

    // Refresh current editor if it was the renamed tab
    const active = getActiveTab();
    if (active && active.path === newPath) {
      showEditor(active.path, active.content);
    }
  } catch (e) {
    console.error('Rename failed:', e);
  }
});

// Notification pill
const notif = document.getElementById('notification')!;
let notifTimer: ReturnType<typeof setTimeout> | null = null;

function showNotification(msg: string, type: 'error' | 'info' = 'error') {
  notif.textContent = msg;
  notif.className = `notification ${type}`;
  if (notifTimer) clearTimeout(notifTimer);
  notifTimer = setTimeout(() => { notif.className = 'notification hidden'; }, 5000);
}

// SSE: connect for live reload with exponential backoff
let sseBackoff = 1000;

function connectSSE() {
  const es = new EventSource('/events');

  es.addEventListener('connected', () => {
    sseBackoff = 1000;
    notif.className = 'notification hidden';
  });

  es.addEventListener('changed', async (e) => {
    const path = e.data;
    const active = getActiveTab();
    if (active && active.path === path) {
      try {
        const note = await getNote(path);
        reloadFromDisk(note.content, note.mtime);
      } catch (e) { console.warn('Failed to reload note from disk:', e); }
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
    showNotification(`Live reload disconnected — retrying in ${Math.round(sseBackoff / 1000)}s...`);
    setTimeout(connectSSE, sseBackoff);
    sseBackoff = Math.min(sseBackoff * 2, 30000);
  };
}

connectSSE();
restoreSession();
