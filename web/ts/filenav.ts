import { stemFromPath } from "@joshuarli98/md-wysiwyg";

import {
  searchFileNames,
  getRecentFiles,
  getPinnedFiles,
  pinFile,
  unpinFile,
  deleteNote,
  type PinnedFileEntry,
  type RecentFileEntry,
  type FileSearchResult,
} from "./api.ts";
import { showContextMenu } from "./context-menu.ts";
import { on, emit } from "./events.ts";
import { showInputDialog } from "./input-dialog.ts";
import { openTab, getActiveTab, closeTabByPath } from "./tab-state.ts";

function showNavContextMenu(e: MouseEvent, path: string, title: string): void {
  e.preventDefault();
  const isPinned = pinnedPaths.has(path);

  showContextMenu(
    [
      {
        label: "Rename...",
        onclick: async () => {
          const newName = await showInputDialog("Rename to...", title);
          if (newName && newName !== title) {
            window.dispatchEvent(new CustomEvent("tansu:rename", { detail: { path, newName } }));
          }
        },
      },
      {
        label: isPinned ? "Unpin" : "Pin",
        onclick: async () => {
          const action = isPinned ? unpinFile(path) : pinFile(path);
          await action;
          await refreshPinned();
          render();
          emit("pinned:changed");
        },
      },
      {
        label: "Delete",
        danger: true,
        onclick: async () => {
          if (!confirm(`Delete ${title}?`)) {
            return;
          }
          await deleteNote(path);
          closeTabByPath(path);
          emit("files:changed");
        },
      },
    ],
    e.clientX,
    e.clientY,
  );
}

let currentMode: "recent" | "search" = "recent";
let pinnedPaths = new Set<string>();
let currentQuery = "";
// Prevents a queued files:changed render from being dropped when one is already in-flight.
let renderQueued = false;
let renderInFlight = false;

export async function initFileNav(): Promise<() => void> {
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

  // Refresh file list whenever files are mutated. Guard prevents stale double-renders
  // when both the local save and SSE fire files:changed within the same tick.
  const offFilesChanged = on("files:changed", async () => {
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
    render();
  });

  return () => {
    offTabChange();
    offFilesChanged();
    offPinnedChanged();
  };
}

async function refreshPinned(): Promise<void> {
  try {
    const files = await getPinnedFiles();
    pinnedPaths = new Set(files.map((f) => f.path));
  } catch {
    // keep stale data on failure
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

  let pinned: PinnedFileEntry[] = [];
  let recent: RecentFileEntry[] = [];
  try {
    [pinned, recent] = await Promise.all([getPinnedFiles(), getRecentFiles()]);
    pinnedPaths = new Set(pinned.map((f) => f.path));
  } catch {
    container.innerHTML = '<div class="nav-empty">Failed to load</div>';
    return;
  }

  const active = getActiveTab();
  container.innerHTML = "";

  const recentNonPinned = recent.filter((f) => !pinnedPaths.has(f.path));

  if (pinned.length === 0 && recentNonPinned.length === 0) {
    container.innerHTML = '<div class="nav-empty">No files</div>';
    return;
  }

  for (const file of pinned) {
    container.append(makeFileRow(file.path, file.title, active?.path, null));
  }
  for (const file of recentNonPinned) {
    container.append(makeFileRow(file.path, file.title, active?.path, timeAgo(file.mtime)));
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

function timeAgo(mtime: number): string {
  const seconds = Math.floor(Date.now() / 1000 - mtime);
  if (seconds < 60) {
    return "<1m";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d`;
  }
  const weeks = Math.floor(days / 7);
  if (weeks < 5) {
    return `${weeks}w`;
  }
  return `${Math.floor(days / 30)}mo`;
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
