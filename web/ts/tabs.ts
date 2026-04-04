import { getNote, deleteNote } from './api.ts';
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
  const title = titleFromContent(note.content, path);
  const tab: Tab = {
    path,
    title,
    dirty: false,
    content: note.content,
    mtime: note.mtime,
  };
  tabs.push(tab);
  switchTab(tabs.length - 1);
  return tab;
}

export function switchTab(index: number) {
  if (index < 0 || index >= tabs.length) return;
  activeIndex = index;
  render();
  onTabChange?.(tabs[activeIndex] ?? null);
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
    render();
  }
}

export function markClean(path: string, content: string, mtime: number) {
  const tab = tabs.find(t => t.path === path);
  if (tab) {
    tab.dirty = false;
    tab.content = content;
    tab.mtime = mtime;
    tab.title = titleFromContent(content, path);
    render();
  }
}

export function updateTabContent(path: string, content: string, mtime: number) {
  const tab = tabs.find(t => t.path === path);
  if (tab) {
    tab.content = content;
    tab.mtime = mtime;
    tab.title = titleFromContent(content, path);
  }
}

export function updateTabPath(oldPath: string, newPath: string) {
  const tab = tabs.find(t => t.path === oldPath);
  if (tab) {
    tab.path = newPath;
    tab.title = titleFromContent(tab.content, newPath);
    render();
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
}

function titleFromContent(content: string, path: string): string {
  // First H1, or filename stem
  const match = content.match(/^#\s+(.+)$/m);
  if (match?.[1]) return match[1];
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
}
