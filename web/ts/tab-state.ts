/// Tab/session state management with persistence delegated to tab-state-storage.ts.

import { stemFromPath } from "@joshuarli98/md-wysiwyg";
import { batch, createSignal } from "solid-js";

import type { SessionState } from "./api.ts";
import { MAX_CLOSED_TABS } from "./constants.ts";
import {
  cacheNoteSnapshot,
  fetchNoteWithOfflineFallback,
  loadSessionState,
  persistSessionCache,
  persistSessionState,
  syncCachedSessionToServer,
} from "./tab-state-storage.ts";

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

export function createTabsStore() {
  const tabs: Tab[] = [];
  let activeIndex = -1;
  const closedTabs: string[] = [];
  let cursors: Record<string, number> = {};

  const [tabsSignal, setTabsSignal] = createSignal<Tab[]>([]);
  const [activeIndexSignal, setActiveIndexSignal] = createSignal(-1);

  function syncSignals() {
    batch(() => {
      setTabsSignal([...tabs]);
      setActiveIndexSignal(activeIndex);
    });
  }

  function buildState(): SessionState {
    return {
      tabs: tabs.map((tab) => tab.path),
      active: activeIndex,
      closed: closedTabs,
      cursors,
    };
  }

  function persistState() {
    persistSessionState(buildState());
  }

  function notifyChange() {
    syncSignals();
    persistState();
  }

  const store = {
    closedTabs,
    getTabs: () => tabsSignal(),
    getActiveIndex: () => activeIndexSignal(),
    getActiveTab: () => tabsSignal()[activeIndexSignal()] ?? null,
    useTabs() {
      return {
        tabs: () => tabsSignal(),
        activeIndex: () => activeIndexSignal(),
        activeTab: () => tabsSignal()[activeIndexSignal()] ?? null,
      };
    },
    setCursor(path: string, offset: number) {
      cursors[path] = offset;
      persistSessionCache(buildState());
    },
    getCursor(path: string) {
      return cursors[path];
    },
    async syncToServer() {
      await syncCachedSessionToServer();
    },
    async openTab(path: string): Promise<Tab> {
      const existing = tabs.findIndex((tab) => tab.path === path);
      if (existing !== -1) {
        await store.switchTab(existing);
        return tabs[existing]!;
      }

      const { content, mtime, tags } = await fetchNoteWithOfflineFallback(path);
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
      await store.switchTab(tabs.length - 1);
      persistState();
      return tab;
    },
    async switchTab(index: number) {
      if (index < 0 || index >= tabs.length) {
        return;
      }
      activeIndex = index;
      const tab = tabs[index];
      const tabPath = tab?.path;
      if (tab && tab.mtime === 0 && !tab.dirty) {
        try {
          const note = await fetchNoteWithOfflineFallback(tab.path);
          if (activeIndex !== index || tabs[index]?.path !== tabPath) {
            return;
          }
          tabs[index] = {
            ...tabs[index]!,
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
    },
    closeTab(index: number) {
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
      cacheNoteSnapshot(tab.path, tab.content, tab.mtime, tab.tags);

      tabs.splice(index, 1);

      if (tabs.length === 0) {
        activeIndex = -1;
      } else if (activeIndex >= tabs.length) {
        activeIndex = tabs.length - 1;
      } else if (index < activeIndex) {
        activeIndex--;
      }

      notifyChange();
    },
    closeActiveTab() {
      if (activeIndex >= 0) {
        store.closeTab(activeIndex);
      }
    },
    closeAllTabs() {
      tabs.length = 0;
      activeIndex = -1;
      syncSignals();
    },
    closeTabByPath(path: string) {
      const index = tabs.findIndex((tab) => tab.path === path);
      if (index !== -1) {
        store.closeTab(index);
      }
    },
    async reopenClosedTab() {
      const path = closedTabs.pop();
      if (!path) {
        return;
      }
      persistState();
      try {
        await store.openTab(path);
      } catch {
        console.warn(`Could not reopen ${path}`);
      }
    },
    nextTab() {
      if (tabs.length > 1) {
        void store.switchTab((activeIndex + 1) % tabs.length);
      }
    },
    prevTab() {
      if (tabs.length > 1) {
        void store.switchTab((activeIndex - 1 + tabs.length) % tabs.length);
      }
    },
    markDirty(path: string) {
      const idx = tabs.findIndex((tab) => tab.path === path);
      if (idx !== -1 && !tabs[idx]!.dirty) {
        tabs[idx] = { ...tabs[idx]!, dirty: true };
        syncSignals();
      }
    },
    markClean(path: string, content: string, mtime: number) {
      const idx = tabs.findIndex((tab) => tab.path === path);
      if (idx !== -1) {
        const tab = tabs[idx]!;
        tabs[idx] = {
          ...tab,
          content,
          mtime,
          lastSavedMd: content,
          title: stemFromPath(path),
          dirty: false,
        };
        cacheNoteSnapshot(path, content, mtime, tab.tags);
        syncSignals();
      }
    },
    markTagsClean(path: string, tags: string[]) {
      const idx = tabs.findIndex((tab) => tab.path === path);
      if (idx !== -1) {
        const tab = tabs[idx]!;
        const newTags = [...tags];
        tabs[idx] = {
          ...tab,
          tags: newTags,
          lastSavedTags: newTags,
          dirty: tab.content !== tab.lastSavedMd,
        };
        cacheNoteSnapshot(path, tab.content, tab.mtime, newTags);
        syncSignals();
      }
    },
    updateTabDraft(path: string, draft: { content?: string; tags?: string[] }) {
      const idx = tabs.findIndex((tab) => tab.path === path);
      if (idx !== -1) {
        const tab = tabs[idx]!;
        const newContent = draft.content ?? tab.content;
        const newTags = draft.tags ? [...draft.tags] : tab.tags;
        tabs[idx] = {
          ...tab,
          content: newContent,
          tags: newTags,
          dirty:
            newContent !== tab.lastSavedMd || newTags.join("\0") !== tab.lastSavedTags.join("\0"),
        };
        syncSignals();
      }
    },
    updateTabContent(path: string, content: string, mtime: number, tags: string[] = []) {
      const idx = tabs.findIndex((tab) => tab.path === path);
      if (idx === -1) {
        return;
      }
      tabs[idx] = {
        ...tabs[idx]!,
        content,
        mtime,
        tags: [...tags],
        lastSavedMd: content,
        lastSavedTags: [...tags],
        dirty: false,
        title: stemFromPath(path),
      };
      syncSignals();
    },
    updateTabPath(oldPath: string, newPath: string) {
      const idx = tabs.findIndex((tab) => tab.path === oldPath);
      if (idx !== -1) {
        tabs[idx] = { ...tabs[idx]!, path: newPath, title: stemFromPath(newPath) };
        notifyChange();
      }
    },
    async restoreSession() {
      const state = await loadSessionState();

      closedTabs.length = 0;
      if (state.closed?.length) {
        closedTabs.push(...state.closed.slice(-MAX_CLOSED_TABS));
      }
      cursors = state.cursors ? { ...state.cursors } : {};
      tabs.length = 0;
      if (!state.tabs?.length) {
        activeIndex = -1;
        syncSignals();
        return;
      }

      const restoredActiveIndex =
        typeof state.active === "number" && state.active >= 0 && state.active < state.tabs.length
          ? state.active
          : 0;

      for (let i = 0; i < state.tabs.length; i++) {
        const path = state.tabs[i]!;
        if (i === restoredActiveIndex) {
          let content = "";
          let mtime = 0;
          let tags: string[] = [];
          try {
            const note = await fetchNoteWithOfflineFallback(path);
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

      activeIndex = tabs.length > 0 ? restoredActiveIndex : -1;
      syncSignals();
      persistState();
    },
  };
  return store;
}

export const tabsStore = createTabsStore();
export type TabsStore = ReturnType<typeof createTabsStore>;

export const closedTabs = tabsStore.closedTabs;
export const getTabs = tabsStore.getTabs;
export const getActiveTab = tabsStore.getActiveTab;
export const getActiveIndex = tabsStore.getActiveIndex;
export const useTabs = tabsStore.useTabs;
export const setCursor = tabsStore.setCursor;
export const getCursor = tabsStore.getCursor;
export const syncToServer = tabsStore.syncToServer;
export const openTab = tabsStore.openTab;
export const switchTab = tabsStore.switchTab;
export const closeTab = tabsStore.closeTab;
export const closeActiveTab = tabsStore.closeActiveTab;
export const closeAllTabs = tabsStore.closeAllTabs;
export const closeTabByPath = tabsStore.closeTabByPath;
export const reopenClosedTab = tabsStore.reopenClosedTab;
export const nextTab = tabsStore.nextTab;
export const prevTab = tabsStore.prevTab;
export const markDirty = tabsStore.markDirty;
export const markClean = tabsStore.markClean;
export const markTagsClean = tabsStore.markTagsClean;
export const updateTabDraft = tabsStore.updateTabDraft;
export const updateTabContent = tabsStore.updateTabContent;
export const updateTabPath = tabsStore.updateTabPath;
export const restoreSession = tabsStore.restoreSession;
