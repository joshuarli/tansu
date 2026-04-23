import {
  searchFileNames,
  getRecentFiles,
  getPinnedFiles,
  pinFile,
  unpinFile,
  deleteNote,
} from "./api.ts";
import { showContextMenu } from "./context-menu.ts";
import { on, emit } from "./events.ts";
import { showInputDialog } from "./input-dialog.ts";
import { openTab, getActiveTab, closeTabByPath } from "./tab-state.ts";
import { stemFromPath } from "./util.ts";

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
        onclick: () => {
          const action = isPinned ? unpinFile(path) : pinFile(path);
          action.then(async () => {
            await refreshPinned();
            render();
            emit("pinned:changed", undefined);
          });
        },
      },
      {
        label: "Delete",
        danger: true,
        onclick: () => {
          if (!confirm(`Delete ${title}?`)) return;
          deleteNote(path).then(() => {
            closeTabByPath(path);
            emit("files:changed", undefined);
          });
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

  const searchInput = document.getElementById("sidebar-search") as HTMLInputElement;

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
  const offFilesChanged = on<undefined>("files:changed", async () => {
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
  const offPinnedChanged = on<undefined>("pinned:changed", async () => {
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
  if (!container) return;

  const active = getActiveTab();
  for (const el of container.querySelectorAll<HTMLElement>(".nav-file")) {
    el.classList.toggle("active", el.title === active?.path);
  }
  container.querySelector<HTMLElement>(".nav-file.active")?.scrollIntoView({ block: "center" });
}

async function render(): Promise<void> {
  if (currentMode === "search" && currentQuery.trim()) {
    await renderSearch(currentQuery);
  } else {
    await renderRecent();
  }
}

async function renderRecent(): Promise<void> {
  const container = getContainer();
  if (!container) return;

  let pinned: { path: string; title: string }[] = [];
  let recent: { path: string; title: string; mtime: number }[] = [];
  try {
    [pinned, recent] = await Promise.all([getPinnedFiles(), getRecentFiles()]);
    pinnedPaths = new Set(pinned.map((f) => f.path));
  } catch {
    container.innerHTML = '<div class="nav-empty">Failed to load</div>';
    return;
  }

  const active = getActiveTab();
  container.innerHTML = "";

  const pinnedSet = new Set(pinned.map((f) => f.path));
  const recentNonPinned = recent.filter((f) => !pinnedSet.has(f.path));

  if (pinned.length === 0 && recentNonPinned.length === 0) {
    container.innerHTML = '<div class="nav-empty">No files</div>';
    return;
  }

  for (const file of pinned) {
    container.appendChild(makeFileRow(file.path, file.title, active?.path, null));
  }
  for (const file of recentNonPinned) {
    container.appendChild(makeFileRow(file.path, file.title, active?.path, timeAgo(file.mtime)));
  }
}

async function renderSearch(q: string): Promise<void> {
  const container = getContainer();
  if (!container) return;
  let results: { path: string; title: string }[];
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
    const dir = r.path.includes("/") ? r.path.substring(0, r.path.lastIndexOf("/")) : "";
    if (dir) {
      const nameSpan = el.querySelector(".nav-file-name") as HTMLElement;
      const textWrapper = document.createElement("div");
      textWrapper.className = "nav-file-text";
      el.insertBefore(textWrapper, nameSpan);
      textWrapper.appendChild(nameSpan);
      const dirLine = document.createElement("div");
      dirLine.className = "nav-file-dir";
      dirLine.textContent = dir;
      textWrapper.appendChild(dirLine);
    }
    container.appendChild(el);
  }
}

function getContainer(): HTMLElement | null {
  return document.getElementById("sidebar-tree");
}

function timeAgo(mtime: number): string {
  const seconds = Math.floor(Date.now() / 1000 - mtime);
  if (seconds < 60) return "<1m";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  return `${Math.floor(days / 30)}mo`;
}

function makeFileRow(
  path: string,
  title: string,
  activePath: string | undefined,
  timeLabel: string | null,
): HTMLElement {
  const el = document.createElement("div");
  el.className = "nav-file" + (path === activePath ? " active" : "");
  el.title = path;

  const nameSpan = document.createElement("span");
  nameSpan.className = "nav-file-name";
  nameSpan.textContent = title || stemFromPath(path);
  el.appendChild(nameSpan);

  if (timeLabel) {
    const timeSpan = document.createElement("span");
    timeSpan.className = "nav-file-time";
    timeSpan.textContent = timeLabel;
    el.appendChild(timeSpan);
  }

  el.addEventListener("click", () => openTab(path));
  el.addEventListener("contextmenu", (e) =>
    showNavContextMenu(e, path, title || stemFromPath(path)),
  );
  return el;
}
