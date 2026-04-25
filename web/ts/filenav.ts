import { stemFromPath } from "@joshuarli98/md-wysiwyg";

import {
  searchFileNames,
  getRecentFiles,
  getPinnedFiles,
  type PinnedFileEntry,
  type RecentFileEntry,
  type FileSearchResult,
} from "./api.ts";
import { showContextMenu } from "./context-menu.ts";
import { on } from "./events.ts";
import { buildFileContextMenuItems } from "./file-actions.ts";
import { openTab, getActiveTab, closeTabByPath } from "./tab-state.ts";
import { relativeTime } from "./util.ts";

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

let currentMode: "recent" | "search" = "recent";
let pinnedFiles: PinnedFileEntry[] = [];
let pinnedPaths = new Set<string>();
let recentFiles: RecentFileEntry[] = [];
let currentQuery = "";
// Prevents a queued files:changed render from being dropped when one is already in-flight.
let renderQueued = false;
let renderInFlight = false;

export async function initFileNav(): Promise<() => void> {
  await refreshPinned();
  render();

  const collapseBtn = document.querySelector("#sidebar-collapse") as HTMLButtonElement;
  collapseBtn.addEventListener("click", () => {
    const app = document.querySelector("#app")!;
    const collapsed = app.classList.toggle("sidebar-collapsed");
    collapseBtn.innerHTML = collapsed ? "&#x203A;" : "&#x2039;";
    collapseBtn.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
  });

  const searchInput = document.querySelector("#sidebar-search") as HTMLInputElement;

  searchInput.addEventListener("input", (e) => {
    const q = (e.target as HTMLInputElement).value;
    currentQuery = q;
    if (q.trim()) {
      currentMode = "search";
    } else if (currentMode === "search") {
      currentMode = "recent";
    }
    render();
  });

  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && currentMode === "search") {
      searchInput.value = "";
      currentQuery = "";
      currentMode = "recent";
      render();
    }
  });

  // Re-render on tab changes to update active file highlight and scroll
  const offTabChange = on("tab:change", () => onTabChange());

  // On save, update the recent list client-side — no network calls needed.
  // For other mutations (delete), do a full re-fetch with the in-flight guard.
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
      await render();
      if (renderQueued) {
        renderQueued = false;
        await render();
      }
    } finally {
      renderInFlight = false;
      renderQueued = false;
    }
  });

  // Refresh pinned state when changed from tab context menu
  const offPinnedChanged = on("pinned:changed", async () => {
    await refreshPinned();
    renderNavDom();
  });

  return () => {
    offTabChange();
    offFilesChanged();
    offPinnedChanged();
  };
}

async function refreshPinned(): Promise<void> {
  try {
    pinnedFiles = await getPinnedFiles();
    pinnedPaths = new Set(pinnedFiles.map((f) => f.path));
  } catch {
    // keep stale data on failure
  }
}

function updateRecentOnSave(savedPath: string): void {
  const nowSecs = Math.floor(Date.now() / 1000);
  const existing = recentFiles.find((f) => f.path === savedPath);
  if (existing) {
    recentFiles = [
      { ...existing, mtime: nowSecs },
      ...recentFiles.filter((f) => f.path !== savedPath),
    ];
  } else {
    recentFiles = [{ path: savedPath, title: "", mtime: nowSecs }, ...recentFiles];
  }
}

// Update active highlight and scroll into view on tab change — no network calls.
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

async function render(): Promise<void> {
  await (currentMode === "search" && currentQuery.trim()
    ? renderSearch(currentQuery)
    : renderRecent());
}

async function renderRecent(): Promise<void> {
  const container = getContainer();
  if (!container) {
    return;
  }

  try {
    recentFiles = await getRecentFiles();
  } catch {
    container.innerHTML = '<div class="nav-empty">Failed to load</div>';
    return;
  }

  renderNavDom();
}

function renderNavDom(): void {
  const container = getContainer();
  if (!container) {
    return;
  }

  const active = getActiveTab();
  container.innerHTML = "";

  const recentNonPinned = recentFiles.filter((f) => !pinnedPaths.has(f.path));

  if (pinnedFiles.length === 0 && recentNonPinned.length === 0) {
    container.innerHTML = '<div class="nav-empty">No files</div>';
    return;
  }

  for (const file of pinnedFiles) {
    container.append(makeFileRow(file.path, file.title, active?.path, null));
  }
  for (const file of recentNonPinned) {
    container.append(
      makeFileRow(file.path, file.title, active?.path, relativeTime(file.mtime * 1000)),
    );
  }
}

async function renderSearch(q: string): Promise<void> {
  const container = getContainer();
  if (!container) {
    return;
  }
  let results: FileSearchResult[];
  try {
    results = await searchFileNames(q);
  } catch {
    container.innerHTML = '<div class="nav-empty">Search failed</div>';
    return;
  }
  const active = getActiveTab();
  container.innerHTML = "";
  if (results.length === 0) {
    container.innerHTML = '<div class="nav-empty">No matches</div>';
    return;
  }
  for (const r of results) {
    const el = makeFileRow(r.path, r.title, active?.path, null);
    const dir = r.path.includes("/") ? r.path.slice(0, r.path.lastIndexOf("/")) : "";
    if (dir) {
      const nameSpan = el.querySelector(".nav-file-name") as HTMLElement;
      const textWrapper = document.createElement("div");
      textWrapper.className = "nav-file-text";
      nameSpan.before(textWrapper);
      textWrapper.append(nameSpan);
      const dirLine = document.createElement("div");
      dirLine.className = "nav-file-dir";
      dirLine.textContent = dir;
      textWrapper.append(dirLine);
    }
    container.append(el);
  }
}

function getContainer(): HTMLElement | null {
  return document.querySelector("#sidebar-tree");
}

function makeFileRow(
  path: string,
  title: string,
  activePath: string | undefined,
  timeLabel: string | null,
): HTMLElement {
  const el = document.createElement("div");
  el.className = `nav-file${path === activePath ? " active" : ""}`;
  el.title = path;

  const nameSpan = document.createElement("span");
  nameSpan.className = "nav-file-name";
  nameSpan.textContent = title || stemFromPath(path);
  el.append(nameSpan);

  if (timeLabel) {
    const timeSpan = document.createElement("span");
    timeSpan.className = "nav-file-time";
    timeSpan.textContent = timeLabel;
    el.append(timeSpan);
  }

  el.addEventListener("click", () => openTab(path));
  el.addEventListener("contextmenu", (e) =>
    showNavContextMenu(e, path, title || stemFromPath(path)),
  );
  return el;
}
