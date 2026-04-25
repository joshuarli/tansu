/// Pure tab state management — no DOM dependencies.

import { stemFromPath } from "@joshuarli98/md-wysiwyg";

import { getNote, createNote, saveState, getState, type SessionState } from "./api.ts";
import { emit } from "./events.ts";
import { kvGet, kvPut, noteGet, notePut } from "./local-store.ts";

export interface Tab {
  path: string;
  title: string;
  dirty: boolean;
  content: string;
  mtime: number;
  lastSavedMd: string;
}

const tabs: Tab[] = [];
let activeIndex = -1;
export const closedTabs: string[] = [];
let cursors: Record<string, number> = {};
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
    cursors,
  };
  /* c8 ignore start */
  kvPut("session", state).catch(() => void 0);
  saveState(state).catch(() => void 0);
  /* c8 ignore stop */
}

export function setCursor(path: string, offset: number) {
  cursors[path] = offset;
  persistState();
}

export function getCursor(path: string): number | undefined {
  return cursors[path];
}

/// Push cached session state to the server. Call on SSE reconnect.
export async function syncToServer() {
  const cached = await kvGet<SessionState>("session");
  if (cached) {
    saveState(cached).catch(() => void 0);
  }
}

/// Try server, cache to IDB on success, fall back to IDB cache on failure.
async function fetchNote(path: string): Promise<{ content: string; mtime: number }> {
  try {
    const note = await getNote(path);
    notePut(path, note.content, note.mtime).catch(() => void 0);
    return note;
  } catch {
    const cached = await noteGet(path);
    if (cached) {
      return cached;
    }
    throw new Error(`Note ${path} not available offline`);
  }
}

function notifyChange() {
  emit("tab:render");
  emit("tab:change", tabs[activeIndex] ?? null);
  persistState();
}

export async function openTab(path: string): Promise<Tab> {
  const existing = tabs.findIndex((t) => t.path === path);
  if (existing !== -1) {
    await switchTab(existing);
    return tabs[existing]!;
  }

  const { content, mtime } = await fetchNote(path);
  const tab: Tab = {
    path,
    title: stemFromPath(path),
    dirty: false,
    content,
    mtime,
    lastSavedMd: content,
  };
  tabs.push(tab);
  await switchTab(tabs.length - 1);
  persistState();
  return tab;
}

export async function switchTab(index: number) {
  if (index < 0 || index >= tabs.length) {
    return;
  }
  activeIndex = index;
  const tab = tabs[index];
  if (tab && tab.mtime === 0 && !tab.dirty) {
    try {
      const note = await fetchNote(tab.path);
      // Another switchTab or closeTab may have run while we awaited.
      // If the tab is no longer current, discard the load and let the
      // winner's notifyChange() stand.
      if (tabs[activeIndex] !== tab) {
        return;
      }
      tab.content = note.content;
      tab.mtime = note.mtime;
      tab.lastSavedMd = note.content;
    } catch {
      console.warn(`Could not load ${tab.path} offline`);
    }
  }
  notifyChange();
}

export function closeTab(index: number) {
  const tab = tabs[index];
  if (!tab) {
    return;
  }

  if (tab.dirty && !confirm("Discard unsaved changes?")) {
    return;
  }

  closedTabs.push(tab.path);
  if (closedTabs.length > MAX_CLOSED) {
    closedTabs.shift();
  }
  /* c8 ignore start */
  notePut(tab.path, tab.content, tab.mtime).catch(() => void 0);
  /* c8 ignore stop */

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
  if (activeIndex >= 0) {
    closeTab(activeIndex);
  }
}

export function closeTabByPath(path: string) {
  const index = tabs.findIndex((t) => t.path === path);
  if (index !== -1) {
    closeTab(index);
  }
}

export async function reopenClosedTab() {
  const path = closedTabs.pop();
  if (!path) {
    return;
  }
  persistState();
  try {
    await openTab(path);
  } catch {
    console.warn(`Could not reopen ${path}`);
  }
}

export function nextTab() {
  if (tabs.length > 1) {
    switchTab((activeIndex + 1) % tabs.length);
  }
}

export function prevTab() {
  if (tabs.length > 1) {
    switchTab((activeIndex - 1 + tabs.length) % tabs.length);
  }
}

export function markDirty(path: string) {
  const tab = tabs.find((t) => t.path === path);
  if (tab && !tab.dirty) {
    tab.dirty = true;
    emit("tab:render");
  }
}

export function markClean(path: string, content: string, mtime: number) {
  const tab = tabs.find((t) => t.path === path);
  if (tab) {
    tab.dirty = false;
    tab.content = content;
    tab.mtime = mtime;
    tab.lastSavedMd = content;
    tab.title = stemFromPath(path);
    /* c8 ignore start */
    notePut(path, content, mtime).catch(() => void 0);
    /* c8 ignore stop */
    emit("tab:render");
  }
}

export function updateTabContent(path: string, content: string, mtime: number) {
  const tab = tabs.find((t) => t.path === path);
  if (tab) {
    tab.content = content;
    tab.mtime = mtime;
    tab.title = stemFromPath(path);
  }
}

export function updateTabPath(oldPath: string, newPath: string) {
  const tab = tabs.find((t) => t.path === oldPath);
  if (tab) {
    tab.path = newPath;
    tab.title = stemFromPath(newPath);
    notifyChange();
  }
}

export async function createNewNote(name: string) {
  const path = name.endsWith(".md") ? name : `${name}.md`;
  try {
    await createNote(path);
    emit("files:changed");
    await openTab(path);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    emit("notification", { msg: `Failed to create note ${path}: ${reason}`, type: "error" });
  }
}

export async function restoreSession() {
  let state: SessionState;
  try {
    state = await getState();
    /* c8 ignore start */
    kvPut("session", state).catch(() => void 0);
    /* c8 ignore stop */
  } catch {
    state = (await kvGet<SessionState>("session")) ?? {};
  }

  closedTabs.length = 0;
  if (state.closed?.length) {
    closedTabs.push(...state.closed.slice(-MAX_CLOSED));
  }
  if (state.cursors) {
    cursors = { ...state.cursors };
  }
  if (!state.tabs?.length) {
    return;
  }

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
        ({ content } = note);
        ({ mtime } = note);
      } catch {
        console.warn(`Could not load ${path} for session restore`);
      }
      tabs.push({
        path,
        title: stemFromPath(path),
        dirty: false,
        content,
        mtime,
        lastSavedMd: content,
      });
    } else {
      tabs.push({
        path,
        title: stemFromPath(path),
        dirty: false,
        content: "",
        mtime: 0,
        lastSavedMd: "",
      });
    }
  }

  if (tabs.length > 0) {
    activeIndex = activeIdx;
    notifyChange();
  }
}
