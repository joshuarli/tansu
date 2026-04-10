/// Pure tab state management — no DOM dependencies.

import { getNote, createNote, saveState, getState } from "./api.ts";
import type { SessionState } from "./api.ts";
import { emit } from "./events.ts";
import { kvGet, kvPut, noteGet, notePut } from "./local-store.ts";

export interface Tab {
  path: string;
  title: string;
  dirty: boolean;
  content: string;
  mtime: number;
}

let tabs: Tab[] = [];
let activeIndex = -1;
let closedTabs: string[] = [];
const MAX_CLOSED = 20;

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
  const state: SessionState = {
    tabs: tabs.map((t) => t.path),
    active: activeIndex,
    closed: closedTabs,
  };
  kvPut("session", state).catch(() => {});
  saveState(state).catch(() => {});
}

/// Push cached session state to the server. Call on SSE reconnect.
export async function syncToServer() {
  const cached = await kvGet<SessionState>("session");
  if (cached) saveState(cached).catch(() => {});
}

/// Try server, cache to IDB on success, fall back to IDB cache on failure.
async function fetchNote(path: string): Promise<{ content: string; mtime: number }> {
  try {
    const note = await getNote(path);
    notePut(path, note.content, note.mtime).catch(() => {});
    return note;
  } catch {
    const cached = await noteGet(path);
    if (cached) return cached;
    throw new Error(`Note ${path} not available offline`);
  }
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

  const { content, mtime } = await fetchNote(path);
  const tab: Tab = { path, title: titleFromPath(path), dirty: false, content, mtime };
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
      const note = await fetchNote(tab.path);
      tab.content = note.content;
      tab.mtime = note.mtime;
    } catch {
      console.warn("Note not available offline:", tab.path);
    }
  }
  notifyChange();
}

export function closeTab(index: number) {
  const tab = tabs[index];
  if (!tab) return;

  if (tab.dirty && !confirm("Discard unsaved changes?")) return;

  closedTabs.push(tab.path);
  if (closedTabs.length > MAX_CLOSED) closedTabs.shift();
  notePut(tab.path, tab.content, tab.mtime).catch(() => {});

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

export function closeTabByPath(path: string) {
  const index = tabs.findIndex((t) => t.path === path);
  if (index >= 0) closeTab(index);
}

export function clearClosedTabs() {
  closedTabs.length = 0;
}

export async function reopenClosedTab() {
  const path = closedTabs.pop();
  if (!path) return;
  persistState();
  try {
    await openTab(path);
  } catch (e) {
    console.warn("Could not reopen closed tab:", path, e);
  }
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
    notePut(path, content, mtime).catch(() => {});
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

export async function createNewNote() {
  const name = prompt("New note name:");
  if (!name) return;
  const path = name.endsWith(".md") ? name : `${name}.md`;
  try {
    await createNote(path);
    emit("files:changed", undefined);
    await openTab(path);
  } catch (e) {
    console.error("Failed to create note:", e);
  }
}

export async function restoreSession() {
  let state: SessionState;
  try {
    state = await getState();
    kvPut("session", state).catch(() => {});
  } catch {
    state = (await kvGet<SessionState>("session")) ?? {};
  }

  closedTabs.length = 0;
  if (state.closed?.length) closedTabs.push(...state.closed.slice(-MAX_CLOSED));
  if (!state.tabs?.length) return;

  const activeIdx =
    typeof state.active === "number" && state.active >= 0 && state.active < state.tabs.length
      ? state.active
      : 0;

  for (let i = 0; i < state.tabs.length; i++) {
    const path = state.tabs[i]!;
    if (i === activeIdx) {
      let content = "";
      let mtime = 0;
      try {
        const note = await fetchNote(path);
        content = note.content;
        mtime = note.mtime;
      } catch (e) {
        console.warn("Failed to load note for session restore:", e);
      }
      tabs.push({ path, title: titleFromPath(path), dirty: false, content, mtime });
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
