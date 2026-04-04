import { toggleSearch, openSearch, closeSearch, isSearchOpen } from './search.ts';
import { toggleSettings, closeSettings, isSettingsOpen } from './settings.ts';
import { togglePalette, closePalette, isPaletteOpen, registerCommands } from './palette.ts';
import {
  setOnTabChange, setOnTabClose, closeActiveTab, nextTab, prevTab,
  getActiveTab, openTab, updateTabPath, updateTabContent, restoreSession,
  createNewNote,
} from './tabs.ts';
import { initEditor, showEditor, hideEditor, saveCurrentNote, reloadFromDisk, invalidateNoteCache } from './editor.ts';
import { registerWikiLinkClickHandler } from './wikilinks.ts';
import { renameNote, getNote, listNotes } from './api.ts';
import { stemFromPath } from './util.ts';
import type { Tab } from './tabs.ts';

// Initialize editor
initEditor();

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

// Register command palette commands
registerCommands([
  { label: 'Search notes', shortcut: '\u2318K', action: () => openSearch() },
  { label: 'Search in current note', shortcut: '\u2318F', action: () => {
    const tab = getActiveTab();
    if (tab) openSearch(tab.path);
    else openSearch();
  }},
  { label: 'Global search', shortcut: '\u21e7\u2318F', action: () => openSearch() },
  { label: 'New note', shortcut: '\u2318T', action: () => createNewNote() },
  { label: 'Save', shortcut: '\u2318S', action: () => saveCurrentNote() },
  { label: 'Close tab', shortcut: '\u2318W', action: () => closeActiveTab() },
  { label: 'Next tab', shortcut: '\u21e7\u2318]', action: () => nextTab() },
  { label: 'Previous tab', shortcut: '\u21e7\u2318[', action: () => prevTab() },
  { label: 'Settings', shortcut: '\u21e7\u2318S', action: () => toggleSettings() },
]);

// Global keyboard shortcuts
document.addEventListener('keydown', (e) => {
  const meta = e.metaKey || e.ctrlKey;

  if (meta && e.key === 'p') {
    e.preventDefault();
    togglePalette();
    return;
  }

  if (meta && e.key === 'k') {
    e.preventDefault();
    toggleSearch();
    return;
  }

  if (meta && e.shiftKey && e.key === 'f') {
    e.preventDefault();
    openSearch();
    return;
  }

  if (meta && !e.shiftKey && e.key === 'f') {
    e.preventDefault();
    const tab = getActiveTab();
    if (tab) openSearch(tab.path);
    else openSearch();
    return;
  }

  // Cmd+Shift+S: settings
  if (meta && e.shiftKey && e.key === 's') {
    e.preventDefault();
    toggleSettings();
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
    if (isPaletteOpen()) { e.preventDefault(); closePalette(); return; }
    if (isSettingsOpen()) { e.preventDefault(); closeSettings(); return; }
    if (isSearchOpen()) { e.preventDefault(); closeSearch(); return; }
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

// Notification pill
const notif = document.getElementById('notification')!;
let notifTimer: ReturnType<typeof setTimeout> | null = null;

function showNotification(msg: string, type: 'error' | 'info' = 'error') {
  notif.textContent = msg;
  notif.className = `notification ${type}`;
  if (notifTimer) clearTimeout(notifTimer);
  notifTimer = setTimeout(() => { notif.className = 'notification hidden'; }, 5000);
}

// SSE: connect for live reload
function connectSSE() {
  const es = new EventSource('/events');

  es.addEventListener('connected', () => {
    notif.className = 'notification hidden';
  });

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
    showNotification('Live reload disconnected — retrying...');
    setTimeout(connectSSE, 3000);
  };
}

connectSSE();
restoreSession();
