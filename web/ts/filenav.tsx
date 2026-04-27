import { stemFromPath } from "@joshuarli98/md-wysiwyg";
import { For, Match, Show, Switch, createEffect, createMemo, createSignal } from "solid-js";
import { render } from "solid-js/web";

import {
  getPinnedFiles,
  getRecentFiles,
  searchFileNames,
  type FileSearchResult,
  type PinnedFileEntry,
  type RecentFileEntry,
} from "./api.ts";
import { showContextMenu } from "./context-menu.tsx";
import { on } from "./events.ts";
import { buildFileContextMenuItems } from "./file-actions.ts";
import { closeTabByPath, getActiveTab, openTab } from "./tab-state.ts";
import { relativeTime } from "./util.ts";

type NavRow = {
  path: string;
  title: string;
  active: boolean;
  timeLabel: string | null;
  dir: string | null;
};

const [currentMode, setCurrentMode] = createSignal<"recent" | "search">("recent");
const [pinnedFiles, setPinnedFiles] = createSignal<PinnedFileEntry[]>([]);
const [pinnedPaths, setPinnedPaths] = createSignal(new Set<string>());
const [recentFiles, setRecentFiles] = createSignal<RecentFileEntry[]>([]);
const [searchResults, setSearchResults] = createSignal<FileSearchResult[]>([]);
const [currentQuery, setCurrentQuery] = createSignal("");
const [recentError, setRecentError] = createSignal(false);
const [searchError, setSearchError] = createSignal(false);
let renderQueued = false;
let renderInFlight = false;
let searchGen = 0;

function showNavContextMenu(e: MouseEvent, path: string, title: string): void {
  e.preventDefault();
  showContextMenu(
    buildFileContextMenuItems({
      path,
      title,
      isPinned: pinnedPaths().has(path),
      onPinChanged: async () => {
        await refreshPinned();
      },
      onDeleted: () => closeTabByPath(path),
    }),
    e.clientX,
    e.clientY,
  );
}

function getContainer(): HTMLElement | null {
  return document.querySelector("#sidebar-tree");
}

function FileRow(props: Readonly<NavRow>) {
  let el!: HTMLDivElement;

  // Scroll into view when this row becomes active (e.g. after tab switch).
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
      onContextMenu={(e) =>
        showNavContextMenu(e, props.path, props.title || stemFromPath(props.path))
      }
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

function NavView() {
  const recentNonPinned = createMemo(() => recentFiles().filter((f) => !pinnedPaths().has(f.path)));

  return (
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
              />
            )}
          </For>
        </>
      </Match>
    </Switch>
  );
}

async function refreshPinned(): Promise<void> {
  try {
    const files = await getPinnedFiles();
    setPinnedFiles(files);
    setPinnedPaths(new Set(files.map((f) => f.path)));
  } catch {
    /* keep stale data */
  }
}

function updateRecentOnSave(savedPath: string): void {
  const nowSecs = Math.floor(Date.now() / 1000);
  const existing = recentFiles().find((f) => f.path === savedPath);
  setRecentFiles(
    existing
      ? [{ ...existing, mtime: nowSecs }, ...recentFiles().filter((f) => f.path !== savedPath)]
      : [{ path: savedPath, title: "", mtime: nowSecs }, ...recentFiles()],
  );
}

async function renderRecent(): Promise<void> {
  try {
    setRecentFiles(await getRecentFiles());
    setRecentError(false);
  } catch {
    setRecentError(true);
  }
}

async function renderSearch(q: string): Promise<void> {
  const gen = ++searchGen;
  try {
    const results = await searchFileNames(q);
    if (gen !== searchGen) return;
    setSearchResults(results);
    setSearchError(false);
  } catch {
    if (gen !== searchGen) return;
    setSearchResults([]);
    setSearchError(true);
  }
}

async function renderNav(): Promise<void> {
  await (currentMode() === "search" && currentQuery().trim()
    ? renderSearch(currentQuery())
    : renderRecent());
}

export async function initFileNav(): Promise<() => void> {
  await refreshPinned();
  await renderNav();

  // Mount the nav view once; signals drive all subsequent updates.
  const container = getContainer();
  let dispose: (() => void) | null = null;
  if (container instanceof HTMLElement) {
    dispose = render(() => <NavView />, container);
  }

  const collapseBtn = document.querySelector("#sidebar-collapse");
  const app = document.querySelector("#app");
  const searchInput = document.querySelector("#sidebar-search");
  if (
    !(collapseBtn instanceof HTMLButtonElement) ||
    !(app instanceof HTMLElement) ||
    !(searchInput instanceof HTMLInputElement)
  ) {
    return () => dispose?.();
  }

  const onCollapse = () => {
    const collapsed = app.classList.toggle("sidebar-collapsed");
    collapseBtn.innerHTML = collapsed ? "&#x203A;" : "&#x2039;";
    collapseBtn.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
  };

  const onInput = () => {
    const q = searchInput.value;
    setCurrentQuery(q);
    if (q.trim()) {
      setCurrentMode("search");
    } else if (currentMode() === "search") {
      setCurrentMode("recent");
    }
    void renderNav();
  };

  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && currentMode() === "search") {
      searchInput.value = "";
      setCurrentQuery("");
      setCurrentMode("recent");
      void renderNav();
    }
  };

  collapseBtn.addEventListener("click", onCollapse);
  searchInput.addEventListener("input", onInput);
  searchInput.addEventListener("keydown", onKeydown);

  const offFilesChanged = on("files:changed", async (data) => {
    if (data?.savedPath) {
      updateRecentOnSave(data.savedPath);
      return;
    }

    if (renderInFlight) {
      renderQueued = true;
      return;
    }
    renderInFlight = true;
    try {
      await renderNav();
      if (renderQueued) {
        renderQueued = false;
        await renderNav();
      }
    } finally {
      renderInFlight = false;
      renderQueued = false;
    }
  });
  const offPinnedChanged = on("pinned:changed", async () => {
    await refreshPinned();
  });
  const offVaultSwitched = on("vault:switched", async () => {
    await refreshPinned();
    await renderNav();
  });

  return () => {
    collapseBtn.removeEventListener("click", onCollapse);
    searchInput.removeEventListener("input", onInput);
    searchInput.removeEventListener("keydown", onKeydown);
    offFilesChanged();
    offPinnedChanged();
    offVaultSwitched();
    dispose?.();
  };
}
