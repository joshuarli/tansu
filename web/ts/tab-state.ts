/// Pure tab state management — no DOM dependencies.

import { stemFromPath } from "@joshuarli98/md-wysiwyg";
import { batch, createSignal } from "solid-js";

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

const _tabs: Tab[] = [];
let _activeIndex = -1;
export const closedTabs: string[] = [];
let cursors: Record<string, number> = {};

// Reactive signals — updated by syncSignals() after every mutation that needs a UI refresh.
// getTabs() / getActiveIndex() return signal values so SolidJS components track them.
const [_tabsSignal, _setTabsSignal] = createSignal<Tab[]>([]);
const [_activeIndexSignal, _setActiveIndexSignal] = createSignal(-1);

function syncSignals() {
  batch(() => {
    _setTabsSignal([..._tabs]);
    _setActiveIndexSignal(_activeIndex);
  });
}

export function getTabs(): Tab[] {
  return _tabsSignal();
}
export function getActiveTab(): Tab | null {
  return _tabsSignal()[_activeIndexSignal()] ?? null;
}
export function getActiveIndex(): number {
  return _activeIndexSignal();
}

function buildState(): SessionState {
  return { tabs: _tabs.map((t) => t.path), active: _activeIndex, closed: closedTabs, cursors };
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

function notifyChange() {
  syncSignals();
  emit("tab:render");
  emit("tab:change", _tabs[_activeIndex] ?? null);
  persistState();
}

export async function openTab(path: string): Promise<Tab> {
  const existing = _tabs.findIndex((t) => t.path === path);
  if (existing !== -1) {
    await switchTab(existing);
    return _tabs[existing]!;
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
  _tabs.push(tab);
  await switchTab(_tabs.length - 1);
  persistState();
  return tab;
}

export async function switchTab(index: number) {
  if (index < 0 || index >= _tabs.length) {
    return;
  }
  _activeIndex = index;
  const tab = _tabs[index];
  const tabPath = tab?.path;
  if (tab && tab.mtime === 0 && !tab.dirty) {
    try {
      const note = await fetchNote(tab.path);
      // Another switchTab or closeTab may have run while we awaited.
      // If the active index or the tab at this position changed, discard the load.
      if (_activeIndex !== index || _tabs[index]?.path !== tabPath) {
        return;
      }
      _tabs[index] = {
        ..._tabs[index]!,
        content: note.content,
        tags: [...note.tags],
        mtime: note.mtime,
        lastSavedMd: note.content,
        lastSavedTags: [...note.tags],
      };
    } catch {
      console.warn(`Could not load ${tab.path} offline`);
    }
  }
  notifyChange();
}

export function closeTab(index: number) {
  const tab = _tabs[index];
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
  _tabs.splice(index, 1);

  if (_tabs.length === 0) {
    _activeIndex = -1;
  } else if (_activeIndex >= _tabs.length) {
    _activeIndex = _tabs.length - 1;
  } else if (index < _activeIndex) {
    _activeIndex--;
  }

  notifyChange();
}

export function closeActiveTab() {
  if (_activeIndex >= 0) {
    closeTab(_activeIndex);
  }
}

export function closeAllTabs() {
  _tabs.length = 0;
  _activeIndex = -1;
  syncSignals();
  emit("tab:render");
  emit("tab:change", null);
}

export function closeTabByPath(path: string) {
  const index = _tabs.findIndex((t) => t.path === path);
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
  if (_tabs.length > 1) {
    void switchTab((_activeIndex + 1) % _tabs.length);
  }
}

export function prevTab() {
  if (_tabs.length > 1) {
    void switchTab((_activeIndex - 1 + _tabs.length) % _tabs.length);
  }
}

export function markDirty(path: string) {
  const idx = _tabs.findIndex((t) => t.path === path);
  if (idx !== -1 && !_tabs[idx]!.dirty) {
    _tabs[idx] = { ..._tabs[idx]!, dirty: true };
    syncSignals();
    emit("tab:render");
  }
}

export function markClean(path: string, content: string, mtime: number) {
  const idx = _tabs.findIndex((t) => t.path === path);
  if (idx !== -1) {
    const tab = _tabs[idx]!;
    _tabs[idx] = {
      ...tab,
      content,
      mtime,
      lastSavedMd: content,
      title: stemFromPath(path),
      dirty: false,
    };
    /* c8 ignore start */
    notePut(path, content, mtime, tab.tags).catch(() => void 0);
    /* c8 ignore stop */
    syncSignals();
    emit("tab:render");
  }
}

export function markTagsClean(path: string, tags: string[]) {
  const idx = _tabs.findIndex((t) => t.path === path);
  if (idx !== -1) {
    const tab = _tabs[idx]!;
    const newTags = [...tags];
    _tabs[idx] = {
      ...tab,
      tags: newTags,
      lastSavedTags: newTags,
      dirty: tab.content !== tab.lastSavedMd,
    };
    /* c8 ignore start */
    notePut(path, tab.content, tab.mtime, newTags).catch(() => void 0);
    /* c8 ignore stop */
    syncSignals();
    emit("tab:render");
  }
}

export function updateTabDraft(path: string, draft: { content?: string; tags?: string[] }) {
  const idx = _tabs.findIndex((t) => t.path === path);
  if (idx !== -1) {
    const tab = _tabs[idx]!;
    const newContent = draft.content ?? tab.content;
    const newTags = draft.tags ? [...draft.tags] : tab.tags;
    _tabs[idx] = {
      ...tab,
      content: newContent,
      tags: newTags,
      dirty: newContent !== tab.lastSavedMd,
    };
    syncSignals();
    emit("tab:render");
  }
}

// Silent update — does not notify the event bus or update reactive signals.
// The tab object is mutated in place so getTabs()[i].content reflects the
// new value immediately (signal array elements share the same references).
export function updateTabContent(
  path: string,
  content: string,
  mtime: number,
  tags: string[] = [],
) {
  const tab = _tabs.find((t) => t.path === path);
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
  const idx = _tabs.findIndex((t) => t.path === oldPath);
  if (idx !== -1) {
    _tabs[idx] = { ..._tabs[idx]!, path: newPath, title: stemFromPath(newPath) };
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
      _tabs.push({
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
      _tabs.push({
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

  if (_tabs.length > 0) {
    _activeIndex = activeIdx;
    notifyChange();
  }
}
