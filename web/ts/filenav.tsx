import { stemFromPath } from "@joshuarli98/md-wysiwyg";
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on } from "solid-js";

import {
  getPinnedFiles,
  getRecentFiles,
  searchFileNames,
  type FileSearchResult,
  type PinnedFileEntry,
  type RecentFileEntry,
} from "./api.ts";
import { showContextMenu } from "./context-menu.ts";
import { buildFileContextMenuItems } from "./file-actions.ts";
import { serverStore } from "./server-store.ts";
import { closeTabByPath, getActiveTab, openTab } from "./tab-state.ts";
import { relativeTime } from "./util.ts";
import { VaultSwitcher } from "./vault-switcher.tsx";

type NavRow = {
  path: string;
  title: string;
  active: boolean;
  timeLabel: string | null;
  dir: string | null;
  isPinned: boolean;
  onContextMenu: (e: MouseEvent) => void;
};

function showNavContextMenu(
  e: MouseEvent,
  path: string,
  title: string,
  isPinned: boolean,
  onPinChanged: () => Promise<void>,
): void {
  e.preventDefault();
  showContextMenu(
    buildFileContextMenuItems({
      path,
      title,
      isPinned,
      onPinChanged,
      onDeleted: () => closeTabByPath(path),
    }),
    e.clientX,
    e.clientY,
  );
}

function FileRow(props: Readonly<NavRow>) {
  let el!: HTMLDivElement;

  createEffect(() => {
    if (props.active) {
      queueMicrotask(() => el.scrollIntoView({ block: "center" }));
    }
  });

  return (
    <div
      ref={el}
      class={`nav-file${props.active ? " active" : ""}`}
      title={props.path}
      onClick={() => void openTab(props.path)}
      onContextMenu={props.onContextMenu}
    >
      <Show
        when={props.dir}
        fallback={<span class="nav-file-name">{props.title || stemFromPath(props.path)}</span>}
      >
        <div class="nav-file-text">
          <span class="nav-file-name">{props.title || stemFromPath(props.path)}</span>
          <div class="nav-file-dir">{props.dir}</div>
        </div>
      </Show>
      <Show when={props.timeLabel}>
        <span class="nav-file-time">{props.timeLabel}</span>
      </Show>
    </div>
  );
}

export function Sidebar(props: Readonly<{ appEl: HTMLElement }>) {
  const [currentMode, setCurrentMode] = createSignal<"recent" | "search">("recent");
  const [pinnedFiles, setPinnedFiles] = createSignal<PinnedFileEntry[]>([]);
  const [pinnedPaths, setPinnedPaths] = createSignal(new Set<string>());
  const [recentFiles, setRecentFiles] = createSignal<RecentFileEntry[]>([]);
  const [searchResults, setSearchResults] = createSignal<FileSearchResult[]>([]);
  const [currentQuery, setCurrentQuery] = createSignal("");
  const [recentError, setRecentError] = createSignal(false);
  const [searchError, setSearchError] = createSignal(false);
  const [collapsed, setCollapsed] = createSignal(false);
  let searchGen = 0;

  async function refreshPinned(): Promise<void> {
    try {
      const files = await getPinnedFiles();
      setPinnedFiles(files);
      setPinnedPaths(new Set(files.map((file) => file.path)));
    } catch {
      /* keep stale data */
    }
  }

  function updateRecentOnSave(savedPath: string): void {
    const nowSecs = Math.floor(Date.now() / 1000);
    const existing = recentFiles().find((file) => file.path === savedPath);
    setRecentFiles(
      existing
        ? [
            { ...existing, mtime: nowSecs },
            ...recentFiles().filter((file) => file.path !== savedPath),
          ]
        : [{ path: savedPath, title: "", mtime: nowSecs }, ...recentFiles()],
    );
  }

  async function refreshRecent(): Promise<void> {
    try {
      setRecentFiles(await getRecentFiles());
      setRecentError(false);
    } catch {
      setRecentError(true);
    }
  }

  async function refreshSearch(query: string): Promise<void> {
    const gen = ++searchGen;
    try {
      const results = await searchFileNames(query);
      if (gen !== searchGen) {
        return;
      }
      setSearchResults(results);
      setSearchError(false);
    } catch {
      if (gen !== searchGen) {
        return;
      }
      setSearchResults([]);
      setSearchError(true);
    }
  }

  async function refreshNav(): Promise<void> {
    await refreshPinned();
    if (currentMode() === "search" && currentQuery().trim()) {
      await refreshSearch(currentQuery());
      return;
    }
    await refreshRecent();
  }

  createEffect(
    on(serverStore.fileChange, (change) => {
      if (change.version === 0) {
        void refreshNav();
        return;
      }
      if (change.savedPath) {
        updateRecentOnSave(change.savedPath);
        return;
      }
      void refreshNav();
    }),
  );

  createEffect(
    on(serverStore.pinnedVersion, () => {
      void refreshPinned();
    }),
  );

  createEffect(
    on(serverStore.vaultVersion, () => {
      void refreshNav();
    }),
  );

  const recentNonPinned = createMemo(() =>
    recentFiles().filter((file) => !pinnedPaths().has(file.path)),
  );

  return (
    <div id="sidebar" class={collapsed() ? "sidebar-collapsed" : ""}>
      <div class="sidebar-header">
        <input
          id="sidebar-search"
          type="text"
          placeholder="Filter files..."
          aria-label="Filter files"
          autocomplete="off"
          spellcheck={false}
          value={currentQuery()}
          onInput={(e) => {
            const query = e.currentTarget.value;
            setCurrentQuery(query);
            if (query.trim()) {
              setCurrentMode("search");
            } else {
              setCurrentMode("recent");
            }
            void refreshNav();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && currentMode() === "search") {
              e.currentTarget.value = "";
              setCurrentQuery("");
              setCurrentMode("recent");
              void refreshNav();
            }
          }}
        />
        <button
          id="sidebar-collapse"
          title={collapsed() ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed() ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => {
            setCollapsed((value) => !value);
            props.appEl.classList.toggle("sidebar-collapsed");
          }}
        >
          {collapsed() ? "\u203A" : "\u2039"}
        </button>
      </div>
      <div id="vault-switcher">
        <VaultSwitcher />
      </div>
      <div id="sidebar-tree">
        <Switch>
          <Match when={currentMode() === "search" && searchError()}>
            <div class="nav-empty">Search failed</div>
          </Match>
          <Match when={currentMode() === "search" && searchResults().length === 0}>
            <div class="nav-empty">No matches</div>
          </Match>
          <Match when={currentMode() === "search"}>
            <For each={searchResults()}>
              {(result) => (
                <FileRow
                  path={result.path}
                  title={result.title}
                  active={result.path === getActiveTab()?.path}
                  timeLabel={null}
                  dir={
                    result.path.includes("/")
                      ? result.path.slice(0, result.path.lastIndexOf("/"))
                      : null
                  }
                  isPinned={false}
                  onContextMenu={(e) =>
                    showNavContextMenu(
                      e,
                      result.path,
                      result.title || stemFromPath(result.path),
                      false,
                      refreshPinned,
                    )
                  }
                />
              )}
            </For>
          </Match>
          <Match when={recentError()}>
            <div class="nav-empty">Failed to load</div>
          </Match>
          <Match when={pinnedFiles().length === 0 && recentNonPinned().length === 0}>
            <div class="nav-empty">No files</div>
          </Match>
          <Match when={true}>
            <>
              <For each={pinnedFiles()}>
                {(file) => (
                  <FileRow
                    path={file.path}
                    title={file.title}
                    active={file.path === getActiveTab()?.path}
                    timeLabel={null}
                    dir={null}
                    isPinned={true}
                    onContextMenu={(e) =>
                      showNavContextMenu(
                        e,
                        file.path,
                        file.title || stemFromPath(file.path),
                        true,
                        refreshPinned,
                      )
                    }
                  />
                )}
              </For>
              <For each={recentNonPinned()}>
                {(file) => (
                  <FileRow
                    path={file.path}
                    title={file.title}
                    active={file.path === getActiveTab()?.path}
                    timeLabel={relativeTime(file.mtime * 1000)}
                    dir={null}
                    isPinned={false}
                    onContextMenu={(e) =>
                      showNavContextMenu(
                        e,
                        file.path,
                        file.title || stemFromPath(file.path),
                        false,
                        refreshPinned,
                      )
                    }
                  />
                )}
              </For>
            </>
          </Match>
        </Switch>
      </div>
    </div>
  );
}
