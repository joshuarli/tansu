import { createSearch } from './search.ts';
import { createSettings } from './settings.ts';
import { createPalette, matchesKey } from './palette.ts';
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

// Register command palette commands (keys field drives the global keydown handler)
palette.registerCommands([
  { label: 'Search notes',          shortcut: '\u2318K',    keys: { key: 'k', meta: true },              action: () => search.toggle() },
  { label: 'Search in current note', shortcut: '\u2318F',   keys: { key: 'f', meta: true },              action: () => {
    const tab = getActiveTab();
    if (tab) search.open(tab.path);
    else search.open();
  }},
  { label: 'Global search',         shortcut: '\u21e7\u2318F', keys: { key: 'f', meta: true, shift: true }, action: () => search.open() },
  { label: 'New note',              shortcut: '\u2318T',    keys: { key: 't', meta: true },              action: () => createNewNote() },
  { label: 'Save',                  shortcut: '\u2318S',    keys: { key: 's', meta: true },              action: () => saveCurrentNote() },
  { label: 'Close tab',             shortcut: '\u2318W',    keys: { key: 'w', meta: true },              action: () => closeActiveTab() },
  { label: 'Next tab',              shortcut: '\u21e7\u2318]', keys: { key: ']', meta: true, shift: true }, action: () => nextTab() },
  { label: 'Previous tab',          shortcut: '\u21e7\u2318[', keys: { key: '[', meta: true, shift: true }, action: () => prevTab() },
  { label: 'Settings',              shortcut: '\u21e7\u2318S', keys: { key: 's', meta: true, shift: true }, action: () => settings.toggle() },
]);

// Global keyboard shortcuts — driven by command palette registry
document.addEventListener('keydown', (e) => {
  // Escape: dismiss overlays in priority order
  if (e.key === 'Escape') {
    if (palette.isOpen()) { e.preventDefault(); palette.close(); return; }
    if (settings.isOpen()) { e.preventDefault(); settings.close(); return; }
    if (search.isOpen()) { e.preventDefault(); search.close(); return; }
    return;
  }

  // Cmd+P: palette toggle (not shown in palette itself)
  if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
    e.preventDefault();
    palette.toggle();
    return;
  }

  // Match registered commands (shift bindings checked first to avoid shadowing)
  for (const cmd of palette.getCommands()) {
    if (cmd.keys && matchesKey(e, cmd.keys)) {
      e.preventDefault();
      cmd.action();
      return;
    }
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
