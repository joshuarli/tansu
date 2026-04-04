import { getNote, deleteNote, createNote, saveState, getState } from './api.ts';
import type { Note } from './api.ts';

export interface Tab {
  path: string;
  title: string;
  dirty: boolean;
  content: string;
  mtime: number;
}

let tabs: Tab[] = [];
let activeIndex = -1;
let onTabChange: ((tab: Tab | null) => void) | null = null;
let onTabClose: ((tab: Tab) => void) | null = null;

const tabBar = document.getElementById('tab-bar')!;
const editorArea = document.getElementById('editor-area')!;
const emptyState = document.getElementById('empty-state')!;

function persistState() {
  saveState({ tabs: tabs.map(t => t.path), active: activeIndex });
}

export function setOnTabChange(fn: (tab: Tab | null) => void) {
  onTabChange = fn;
}

export function setOnTabClose(fn: (tab: Tab) => void) {
  onTabClose = fn;
}

export function getTabs(): Tab[] {
  return tabs;
}

export function getActiveTab(): Tab | null {
  return tabs[activeIndex] ?? null;
}

export function getActiveIndex(): number {
  return activeIndex;
}

export async function openTab(path: string): Promise<Tab> {
  // If already open, switch to it
  const existing = tabs.findIndex(t => t.path === path);
  if (existing >= 0) {
    switchTab(existing);
    return tabs[existing]!;
  }

  // Load note
  const note = await getNote(path);
  const title = titleFromPath(path);
  const tab: Tab = {
    path,
    title,
    dirty: false,
    content: note.content,
    mtime: note.mtime,
  };
  tabs.push(tab);
  switchTab(tabs.length - 1);
  persistState();
  return tab;
}

export async function switchTab(index: number) {
  if (index < 0 || index >= tabs.length) return;
  activeIndex = index;
  const tab = tabs[activeIndex];
  // Lazy-load if not yet fetched
  if (tab && tab.mtime === 0 && !tab.dirty) {
    try {
      const note = await getNote(tab.path);
      tab.content = note.content;
      tab.mtime = note.mtime;
    } catch {
      // Note may have been deleted — keep empty content
    }
  }
  render();
  onTabChange?.(tabs[activeIndex] ?? null);
  persistState();
}

export function closeTab(index: number) {
  const tab = tabs[index];
  if (!tab) return;

  if (tab.dirty && !confirm('Discard unsaved changes?')) return;

  onTabClose?.(tab);
  tabs.splice(index, 1);

  if (tabs.length === 0) {
    activeIndex = -1;
  } else if (activeIndex >= tabs.length) {
    activeIndex = tabs.length - 1;
  } else if (index < activeIndex) {
    activeIndex--;
  }

  render();
  onTabChange?.(tabs[activeIndex] ?? null);
  persistState();
}

export function closeActiveTab() {
  if (activeIndex >= 0) closeTab(activeIndex);
}

export function nextTab() {
  if (tabs.length > 1) switchTab((activeIndex + 1) % tabs.length);
}

export function prevTab() {
  if (tabs.length > 1) switchTab((activeIndex - 1 + tabs.length) % tabs.length);
}

export function markDirty(path: string) {
  const tab = tabs.find(t => t.path === path);
  if (tab && !tab.dirty) {
    tab.dirty = true;
    updateTabDirtyState(tabs.indexOf(tab));
  }
}

export function markClean(path: string, content: string, mtime: number) {
  const tab = tabs.find(t => t.path === path);
  if (tab) {
    const wasDirty = tab.dirty;
    tab.dirty = false;
    tab.content = content;
    tab.mtime = mtime;
    tab.title = titleFromPath(path);
    if (wasDirty) updateTabDirtyState(tabs.indexOf(tab));
  }
}

function updateTabDirtyState(index: number) {
  const tabEl = tabBar.children[index] as HTMLElement | undefined;
  if (!tabEl) return;
  const existing = tabEl.querySelector('.dirty');
  const tab = tabs[index];
  if (tab?.dirty && !existing) {
    const dot = document.createElement('span');
    dot.className = 'dirty';
    dot.textContent = '\u25cf';
    tabEl.insertBefore(dot, tabEl.firstChild);
  } else if (!tab?.dirty && existing) {
    existing.remove();
  }
}

export function updateTabContent(path: string, content: string, mtime: number) {
  const tab = tabs.find(t => t.path === path);
  if (tab) {
    tab.content = content;
    tab.mtime = mtime;
    tab.title = titleFromPath(path);
  }
}

export function updateTabPath(oldPath: string, newPath: string) {
  const tab = tabs.find(t => t.path === oldPath);
  if (tab) {
    tab.path = newPath;
    tab.title = titleFromPath(newPath);
    render();
    persistState();
  }
}

export async function deleteActiveTab() {
  const tab = getActiveTab();
  if (!tab) return;
  if (!confirm(`Delete ${tab.title}?`)) return;
  await deleteNote(tab.path);
  tabs.splice(activeIndex, 1);
  if (tabs.length === 0) {
    activeIndex = -1;
  } else if (activeIndex >= tabs.length) {
    activeIndex = tabs.length - 1;
  }
  render();
  onTabChange?.(tabs[activeIndex] ?? null);
  persistState();
}

export async function createNewNote() {
  const name = prompt('New note name:');
  if (!name) return;
  const path = name.endsWith('.md') ? name : `${name}.md`;
  try {
    await createNote(path);
    await openTab(path);
  } catch (e) {
    console.error('Failed to create note:', e);
  }
}

export async function restoreSession() {
  const state = await getState();
  if (!state.tabs?.length) return;

  const activeIdx = typeof state.active === 'number' && state.active >= 0 && state.active < state.tabs.length
    ? state.active : 0;

  // Load active tab first, add placeholders for the rest
  for (let i = 0; i < state.tabs.length; i++) {
    const path = state.tabs[i]!;
    if (i === activeIdx) {
      try {
        const note = await getNote(path);
        tabs.push({ path, title: titleFromPath(path), dirty: false, content: note.content, mtime: note.mtime });
      } catch {
        tabs.push({ path, title: titleFromPath(path), dirty: false, content: '', mtime: 0 });
      }
    } else {
      // Placeholder — content loaded on switch
      tabs.push({ path, title: titleFromPath(path), dirty: false, content: '', mtime: 0 });
    }
  }

  if (tabs.length > 0) {
    activeIndex = activeIdx;
    render();
    onTabChange?.(tabs[activeIndex] ?? null);
  }
}

function titleFromPath(path: string): string {
  const name = path.split('/').pop() ?? path;
  return name.replace(/\.md$/i, '');
}

let contextMenuEl: HTMLElement | null = null;

function showContextMenu(e: MouseEvent, index: number) {
  e.preventDefault();
  hideContextMenu();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;

  const rename = document.createElement('div');
  rename.className = 'context-menu-item';
  rename.textContent = 'Rename...';
  rename.onclick = () => {
    hideContextMenu();
    const tab = tabs[index];
    if (!tab) return;
    const newName = prompt('New name:', tab.title);
    if (newName && newName !== tab.title) {
      // Dispatch custom event for main.ts to handle
      window.dispatchEvent(new CustomEvent('tansu:rename', {
        detail: { path: tab.path, newName }
      }));
    }
  };

  const del = document.createElement('div');
  del.className = 'context-menu-item danger';
  del.textContent = 'Delete';
  del.onclick = () => {
    hideContextMenu();
    const tab = tabs[index];
    if (!tab) return;
    if (!confirm(`Delete ${tab.title}?`)) return;
    deleteNote(tab.path).then(() => {
      closeTab(index);
    });
  };

  const close = document.createElement('div');
  close.className = 'context-menu-item';
  close.textContent = 'Close';
  close.onclick = () => {
    hideContextMenu();
    closeTab(index);
  };

  menu.append(rename, del, close);
  document.body.appendChild(menu);
  contextMenuEl = menu;

  const dismiss = () => { hideContextMenu(); document.removeEventListener('click', dismiss); };
  setTimeout(() => document.addEventListener('click', dismiss), 0);
}

function hideContextMenu() {
  if (contextMenuEl) {
    contextMenuEl.remove();
    contextMenuEl = null;
  }
}

function render() {
  tabBar.innerHTML = '';
  emptyState.style.display = tabs.length === 0 ? 'flex' : 'none';

  tabs.forEach((tab, i) => {
    const el = document.createElement('div');
    el.className = 'tab' + (i === activeIndex ? ' active' : '');

    if (tab.dirty) {
      const dot = document.createElement('span');
      dot.className = 'dirty';
      dot.textContent = '\u25cf';
      el.appendChild(dot);
    }

    const label = document.createElement('span');
    label.textContent = tab.title;
    el.appendChild(label);

    const closeBtn = document.createElement('span');
    closeBtn.className = 'close';
    closeBtn.textContent = '\u00d7';
    closeBtn.onclick = (e) => { e.stopPropagation(); closeTab(i); };
    el.appendChild(closeBtn);

    el.onclick = () => switchTab(i);
    el.oncontextmenu = (e) => showContextMenu(e, i);
    el.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); closeTab(i); } };

    tabBar.appendChild(el);
  });

  const addBtn = document.createElement('div');
  addBtn.className = 'tab tab-new';
  addBtn.textContent = '+';
  addBtn.title = 'New note (Cmd+T)';
  addBtn.onclick = () => createNewNote();
  tabBar.appendChild(addBtn);
}
