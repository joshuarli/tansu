/// Pure tab state management — no DOM dependencies.

import { stemFromPath } from "@joshuarli98/md-wysiwyg";

import { getNote, createNote, saveState, getState, type SessionState } from "./api.ts";
import { MAX_CLOSED_TABS } from "./constants.ts";
import { emit } from "./events.ts";
import { kvGet, kvPut, noteGet, notePut } from "./local-store.ts";

export type Tab = {
  path: string;
  title: string;
  dirty: boolean;
  content: string;
  tags: string[];
  mtime: number;
  lastSavedMd: string;
  lastSavedTags: string[];
};

const tabs: Tab[] = [];
let activeIndex = -1;
export const closedTabs: string[] = [];
let cursors: Record<string, number> = {};
export function getTabs(): Tab[] {
  return tabs;
}
export function getActiveTab(): Tab | null {
  return tabs[activeIndex] ?? null;
}
export function getActiveIndex(): number {
  return activeIndex;
}

function buildState(): SessionState {
  return { tabs: tabs.map((t) => t.path), active: activeIndex, closed: closedTabs, cursors };
}

function persistState() {
  const state = buildState();
  /* c8 ignore start */
  kvPut("session", state).catch(() => void 0);
  saveState(state).catch(() => void 0);
  /* c8 ignore stop */
}

export function setCursor(path: string, offset: number) {
  cursors[path] = offset;
  /* c8 ignore next */
  kvPut("session", buildState()).catch(() => void 0);
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
async function fetchNote(
  path: string,
): Promise<{ content: string; mtime: number; tags: string[] }> {
  try {
    const note = await getNote(path);
    notePut(path, note.content, note.mtime, note.tags).catch(() => void 0);
    return note;
  } catch {
    const cached = await noteGet(path);
    if (cached) {
      return cached;
    }
    throw new Error(`Note ${path} not available offline`);
  }
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tag, i) => tag === b[i]);
}

function recomputeDirty(tab: Tab): boolean {
  return tab.content !== tab.lastSavedMd || !sameTags(tab.tags, tab.lastSavedTags);
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

  const { content, mtime, tags } = await fetchNote(path);
  const tab: Tab = {
    path,
    title: stemFromPath(path),
    dirty: false,
    content,
    tags,
    mtime,
    lastSavedMd: content,
    lastSavedTags: tags,
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
      tab.tags = note.tags;
      tab.mtime = note.mtime;
      tab.lastSavedMd = note.content;
      tab.lastSavedTags = note.tags;
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
  if (closedTabs.length > MAX_CLOSED_TABS) {
    closedTabs.shift();
  }
  /* c8 ignore start */
  notePut(tab.path, tab.content, tab.mtime, tab.tags).catch(() => void 0);
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

export function closeAllTabs() {
  tabs.length = 0;
  activeIndex = -1;
  emit("tab:render");
  emit("tab:change", null);
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
    tab.content = content;
    tab.mtime = mtime;
    tab.lastSavedMd = content;
    tab.title = stemFromPath(path);
    tab.dirty = recomputeDirty(tab);
    /* c8 ignore start */
    notePut(path, content, mtime, tab.tags).catch(() => void 0);
    /* c8 ignore stop */
    emit("tab:render");
  }
}

export function markTagsClean(path: string, tags: string[]) {
  const tab = tabs.find((t) => t.path === path);
  if (tab) {
    tab.tags = [...tags];
    tab.lastSavedTags = [...tags];
    tab.dirty = recomputeDirty(tab);
    /* c8 ignore start */
    notePut(path, tab.content, tab.mtime, tab.tags).catch(() => void 0);
    /* c8 ignore stop */
    emit("tab:render");
  }
}

export function updateTabDraft(path: string, draft: { content?: string; tags?: string[] }) {
  const tab = tabs.find((t) => t.path === path);
  if (tab) {
    if (draft.content !== undefined) {
      tab.content = draft.content;
    }
    if (draft.tags !== undefined) {
      tab.tags = [...draft.tags];
    }
    tab.dirty = recomputeDirty(tab);
    emit("tab:render");
  }
}

export function updateTabContent(
  path: string,
  content: string,
  mtime: number,
  tags: string[] = [],
) {
  const tab = tabs.find((t) => t.path === path);
  if (tab) {
    tab.content = content;
    tab.mtime = mtime;
    tab.tags = [...tags];
    tab.lastSavedMd = content;
    tab.lastSavedTags = [...tags];
    tab.dirty = false;
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
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
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
    closedTabs.push(...state.closed.slice(-MAX_CLOSED_TABS));
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
      let tags: string[] = [];
      try {
        const note = await fetchNote(path);
        ({ content } = note);
        ({ mtime } = note);
        ({ tags } = note);
      } catch {
        console.warn(`Could not load ${path} for session restore`);
      }
      tabs.push({
        path,
        title: stemFromPath(path),
        dirty: false,
        content,
        tags,
        mtime,
        lastSavedMd: content,
        lastSavedTags: tags,
      });
    } else {
      tabs.push({
        path,
        title: stemFromPath(path),
        dirty: false,
        content: "",
        tags: [],
        mtime: 0,
        lastSavedMd: "",
        lastSavedTags: [],
      });
    }
  }

  if (tabs.length > 0) {
    activeIndex = activeIdx;
    notifyChange();
  }
}
