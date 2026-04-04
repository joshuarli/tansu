/// Pure tab state management — no DOM dependencies.

import { getNote, deleteNote, createNote, saveState, getState } from "./api.ts";
import { emit } from "./events.ts";

export interface Tab {
  path: string;
  title: string;
  dirty: boolean;
  content: string;
  mtime: number;
}

let tabs: Tab[] = [];
let activeIndex = -1;

export function getTabs(): Tab[] {
  return tabs;
}
export function getActiveTab(): Tab | null {
  return tabs[activeIndex] ?? null;
}
export function getActiveIndex(): number {
  return activeIndex;
}

function persistState() {
  saveState({ tabs: tabs.map((t) => t.path), active: activeIndex });
}

function notifyChange() {
  emit("tab:render", undefined);
  emit("tab:change", tabs[activeIndex] ?? null);
  persistState();
}

export async function openTab(path: string): Promise<Tab> {
  const existing = tabs.findIndex((t) => t.path === path);
  if (existing >= 0) {
    await switchTab(existing);
    return tabs[existing]!;
  }

  const note = await getNote(path);
  const tab: Tab = {
    path,
    title: titleFromPath(path),
    dirty: false,
    content: note.content,
    mtime: note.mtime,
  };
  tabs.push(tab);
  await switchTab(tabs.length - 1);
  persistState();
  return tab;
}

export async function switchTab(index: number) {
  if (index < 0 || index >= tabs.length) return;
  activeIndex = index;
  const tab = tabs[activeIndex];
  if (tab && tab.mtime === 0 && !tab.dirty) {
    try {
      const note = await getNote(tab.path);
      tab.content = note.content;
      tab.mtime = note.mtime;
    } catch (e) {
      console.warn("Failed to load tab content (note may be deleted):", e);
    }
  }
  notifyChange();
}

export function closeTab(index: number) {
  const tab = tabs[index];
  if (!tab) return;

  if (tab.dirty && !confirm("Discard unsaved changes?")) return;

  emit("tab:close", tab);
  tabs.splice(index, 1);

  if (tabs.length === 0) {
    activeIndex = -1;
  } else if (activeIndex >= tabs.length) {
    activeIndex = tabs.length - 1;
  } else if (index < activeIndex) {
    activeIndex--;
  }

  notifyChange();
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
  const tab = tabs.find((t) => t.path === path);
  if (tab && !tab.dirty) {
    tab.dirty = true;
    emit("tab:render", undefined);
  }
}

export function markClean(path: string, content: string, mtime: number) {
  const tab = tabs.find((t) => t.path === path);
  if (tab) {
    tab.dirty = false;
    tab.content = content;
    tab.mtime = mtime;
    tab.title = titleFromPath(path);
    emit("tab:render", undefined);
  }
}

export function updateTabContent(path: string, content: string, mtime: number) {
  const tab = tabs.find((t) => t.path === path);
  if (tab) {
    tab.content = content;
    tab.mtime = mtime;
    tab.title = titleFromPath(path);
  }
}

export function updateTabPath(oldPath: string, newPath: string) {
  const tab = tabs.find((t) => t.path === oldPath);
  if (tab) {
    tab.path = newPath;
    tab.title = titleFromPath(newPath);
    notifyChange();
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
  notifyChange();
}

export async function createNewNote() {
  const name = prompt("New note name:");
  if (!name) return;
  const path = name.endsWith(".md") ? name : `${name}.md`;
  try {
    await createNote(path);
    await openTab(path);
  } catch (e) {
    console.error("Failed to create note:", e);
  }
}

export async function restoreSession() {
  const state = await getState();
  if (!state.tabs?.length) return;

  const activeIdx =
    typeof state.active === "number" && state.active >= 0 && state.active < state.tabs.length
      ? state.active
      : 0;

  for (let i = 0; i < state.tabs.length; i++) {
    const path = state.tabs[i]!;
    if (i === activeIdx) {
      try {
        const note = await getNote(path);
        tabs.push({
          path,
          title: titleFromPath(path),
          dirty: false,
          content: note.content,
          mtime: note.mtime,
        });
      } catch (e) {
        console.warn("Failed to load note for session restore:", e);
        tabs.push({ path, title: titleFromPath(path), dirty: false, content: "", mtime: 0 });
      }
    } else {
      tabs.push({ path, title: titleFromPath(path), dirty: false, content: "", mtime: 0 });
    }
  }

  if (tabs.length > 0) {
    activeIndex = activeIdx;
    notifyChange();
  }
}

export function titleFromPath(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.md$/i, "");
}
