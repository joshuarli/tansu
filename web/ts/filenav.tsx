import { stemFromPath } from "@joshuarli98/md-wysiwyg";
import { For, Show } from "solid-js";
import { render } from "solid-js/web";

import {
  getPinnedFiles,
  getRecentFiles,
  searchFileNames,
  type FileSearchResult,
  type PinnedFileEntry,
  type RecentFileEntry,
} from "./api.ts";
import { showContextMenu } from "./context-menu.ts";
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

let currentMode: "recent" | "search" = "recent";
let pinnedFiles: PinnedFileEntry[] = [];
let pinnedPaths = new Set<string>();
let recentFiles: RecentFileEntry[] = [];
let searchResults: FileSearchResult[] = [];
let currentQuery = "";
let recentError = false;
let searchError = false;
let renderQueued = false;
let renderInFlight = false;
let containerDispose: (() => void) | null = null;
const noop = () => void 0;

function showNavContextMenu(e: MouseEvent, path: string, title: string): void {
  e.preventDefault();

  showContextMenu(
    buildFileContextMenuItems({
      path,
      title,
      isPinned: pinnedPaths.has(path),
      onPinChanged: async () => {
        await refreshPinned();
        renderNavDom();
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
  return (
    <div
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
  const activePath = getActiveTab()?.path;
  if (currentMode === "search") {
    if (searchError) {
      return <div class="nav-empty">Search failed</div>;
    }
    if (searchResults.length === 0) {
      return <div class="nav-empty">No matches</div>;
    }
    return (
      <For each={searchResults}>
        {(result) => (
          <FileRow
            path={result.path}
            title={result.title}
            active={result.path === activePath}
            timeLabel={null}
            dir={
              result.path.includes("/") ? result.path.slice(0, result.path.lastIndexOf("/")) : null
            }
          />
        )}
      </For>
    );
  }

  if (recentError) {
    return <div class="nav-empty">Failed to load</div>;
  }

  const recentNonPinned = recentFiles.filter((f) => !pinnedPaths.has(f.path));
  if (pinnedFiles.length === 0 && recentNonPinned.length === 0) {
    return <div class="nav-empty">No files</div>;
  }

  return (
    <>
      <For each={pinnedFiles}>
        {(file) => (
          <FileRow
            path={file.path}
            title={file.title}
            active={file.path === activePath}
            timeLabel={null}
            dir={null}
          />
        )}
      </For>
      <For each={recentNonPinned}>
        {(file) => (
          <FileRow
            path={file.path}
            title={file.title}
            active={file.path === activePath}
            timeLabel={relativeTime(file.mtime * 1000)}
            dir={null}
          />
        )}
      </For>
    </>
  );
}

function renderNavDom(): void {
  const container = getContainer();
  if (!(container instanceof HTMLElement)) {
    return;
  }
  containerDispose?.();
  container.textContent = "";
  containerDispose = render(() => <NavView />, container);
}

async function refreshPinned(): Promise<void> {
  try {
    pinnedFiles = await getPinnedFiles();
    pinnedPaths = new Set(pinnedFiles.map((f) => f.path));
  } catch {
    /* keep stale data */
  }
}

function updateRecentOnSave(savedPath: string): void {
  const nowSecs = Math.floor(Date.now() / 1000);
  const existing = recentFiles.find((f) => f.path === savedPath);
  recentFiles = existing
    ? [{ ...existing, mtime: nowSecs }, ...recentFiles.filter((f) => f.path !== savedPath)]
    : [{ path: savedPath, title: "", mtime: nowSecs }, ...recentFiles];
}

function onTabChange(): void {
  const container = getContainer();
  if (!container) {
    return;
  }

  const active = getActiveTab();
  for (const el of container.querySelectorAll<HTMLElement>(".nav-file")) {
    el.classList.toggle("active", el.title === active?.path);
  }
  container.querySelector<HTMLElement>(".nav-file.active")?.scrollIntoView({ block: "center" });
}

async function renderRecent(): Promise<void> {
  try {
    recentFiles = await getRecentFiles();
    recentError = false;
  } catch {
    recentError = true;
  }
  renderNavDom();
}

async function renderSearch(q: string): Promise<void> {
  try {
    searchResults = await searchFileNames(q);
    searchError = false;
  } catch {
    searchResults = [];
    searchError = true;
  }
  renderNavDom();
}

async function renderNav(): Promise<void> {
  await (currentMode === "search" && currentQuery.trim()
    ? renderSearch(currentQuery)
    : renderRecent());
}

export async function initFileNav(): Promise<() => void> {
  await refreshPinned();
  await renderNav();

  const collapseBtn = document.querySelector("#sidebar-collapse");
  const app = document.querySelector("#app");
  const searchInput = document.querySelector("#sidebar-search");
  if (
    !(collapseBtn instanceof HTMLButtonElement) ||
    !(app instanceof HTMLElement) ||
    !(searchInput instanceof HTMLInputElement)
  ) {
    return noop;
  }

  const onCollapse = () => {
    const collapsed = app.classList.toggle("sidebar-collapsed");
    collapseBtn.innerHTML = collapsed ? "&#x203A;" : "&#x2039;";
    collapseBtn.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
  };

  const onInput = () => {
    const q = searchInput.value;
    currentQuery = q;
    if (q.trim()) {
      currentMode = "search";
    } else if (currentMode === "search") {
      currentMode = "recent";
    }
    void renderNav();
  };

  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && currentMode === "search") {
      searchInput.value = "";
      currentQuery = "";
      currentMode = "recent";
      void renderNav();
    }
  };

  collapseBtn.addEventListener("click", onCollapse);
  searchInput.addEventListener("input", onInput);
  searchInput.addEventListener("keydown", onKeydown);

  const offTabChange = on("tab:change", () => onTabChange());
  const offFilesChanged = on("files:changed", async (data) => {
    if (data?.savedPath) {
      updateRecentOnSave(data.savedPath);
      renderNavDom();
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
    renderNavDom();
  });
  const offVaultSwitched = on("vault:switched", async () => {
    await refreshPinned();
    await renderNav();
  });

  return () => {
    collapseBtn.removeEventListener("click", onCollapse);
    searchInput.removeEventListener("input", onInput);
    searchInput.removeEventListener("keydown", onKeydown);
    offTabChange();
    offFilesChanged();
    offPinnedChanged();
    offVaultSwitched();
  };
}
