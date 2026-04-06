import { listNotes, searchFileNames, getRecentFiles } from "./api.ts";
import { on, emit } from "./events.ts";
import { openTab, getActiveTab } from "./tab-state.ts";
import { stemFromPath, debounce } from "./util.ts";

interface DirNode {
  type: "dir";
  name: string;
  dirPath: string;
  children: TreeNode[];
}

interface FileNode {
  type: "file";
  name: string;
  path: string;
  title: string;
}

type TreeNode = DirNode | FileNode;

const collapsed = new Set<string>();
let sortByName = true;
let currentMode: "tree" | "recent" | "search" = "tree";
let allNotes: { path: string; title: string }[] = [];
let currentQuery = "";

export async function initFileNav(): Promise<void> {
  await refreshNotes();
  render();

  const searchInput = document.getElementById("sidebar-search") as HTMLInputElement;
  const recentBtn = document.getElementById("sidebar-recent-btn") as HTMLButtonElement;
  const sortBtn = document.getElementById("sidebar-sort-btn") as HTMLButtonElement;

  const handleSearch = debounce((q: string) => {
    currentQuery = q;
    if (q.trim()) {
      currentMode = "search";
    } else if (currentMode === "search") {
      currentMode = "tree";
    }
    render();
  }, 150);

  searchInput.addEventListener("input", (e) => {
    handleSearch((e.target as HTMLInputElement).value);
  });

  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && currentMode === "search") {
      searchInput.value = "";
      currentQuery = "";
      currentMode = "tree";
      render();
    }
  });

  recentBtn.addEventListener("click", () => {
    if (currentMode === "recent") {
      currentMode = "tree";
    } else {
      currentMode = "recent";
      searchInput.value = "";
      currentQuery = "";
    }
    updateButtons(recentBtn, sortBtn);
    render();
  });

  sortBtn.addEventListener("click", () => {
    sortByName = !sortByName;
    updateButtons(recentBtn, sortBtn);
    if (currentMode === "tree") render();
  });

  updateButtons(recentBtn, sortBtn);

  // Re-render on tab changes to update active file highlight
  on("tab:change", () => renderTreeIfActive());

  // Refresh file list whenever files are mutated
  on<undefined>("files:changed", async () => {
    await refreshNotes();
    render();
  });
}

function updateButtons(recentBtn: HTMLButtonElement, sortBtn: HTMLButtonElement): void {
  recentBtn.classList.toggle("active", currentMode === "recent");
  sortBtn.classList.toggle("active", sortByName);
}

async function refreshNotes(): Promise<void> {
  try {
    allNotes = await listNotes();
  } catch {
    // keep stale data on failure
  }
}

// Only re-render tree synchronously (no network calls) — used for tab change events
function renderTreeIfActive(): void {
  if (currentMode === "tree") renderTree();
}

async function render(): Promise<void> {
  if (currentMode === "recent") {
    await renderRecent();
  } else if (currentMode === "search" && currentQuery.trim()) {
    await renderSearch(currentQuery);
  } else {
    renderTree();
  }
}

async function renderRecent(): Promise<void> {
  const container = getContainer();
  if (!container) return;
  let files: { path: string; title: string; mtime: number }[];
  try {
    files = await getRecentFiles();
  } catch {
    container.innerHTML = '<div class="nav-empty">Failed to load</div>';
    return;
  }
  const active = getActiveTab();
  container.innerHTML = "";
  if (files.length === 0) {
    container.innerHTML = '<div class="nav-empty">No files</div>';
    return;
  }
  for (const file of files) {
    container.appendChild(makeFileRow(file.path, file.title, 0, active?.path, false));
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
    const el = document.createElement("div");
    el.className = "nav-file" + (active?.path === r.path ? " active" : "");

    const nameLine = document.createElement("div");
    nameLine.className = "nav-file-name";
    nameLine.textContent = r.title;
    el.appendChild(nameLine);

    const dir = r.path.includes("/") ? r.path.substring(0, r.path.lastIndexOf("/")) : "";
    if (dir) {
      const dirLine = document.createElement("div");
      dirLine.className = "nav-file-dir";
      dirLine.textContent = dir;
      el.appendChild(dirLine);
    }

    el.title = r.path;
    el.addEventListener("click", () => openTab(r.path));
    container.appendChild(el);
  }
}

function renderTree(): void {
  const container = getContainer();
  if (!container) return;
  const root = buildTree(allNotes);
  if (sortByName) sortNode(root);
  const active = getActiveTab();
  container.innerHTML = "";
  if (root.children.length === 0) {
    container.innerHTML = '<div class="nav-empty">No notes</div>';
    return;
  }
  renderChildren(container, root.children, 0, active?.path);
}

function getContainer(): HTMLElement | null {
  return document.getElementById("sidebar-tree");
}

function buildTree(notes: { path: string; title: string }[]): DirNode {
  const root: DirNode = { type: "dir", name: "", dirPath: "", children: [] };
  for (const note of notes) {
    const parts = note.path.split("/");
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      const dirPath = parts.slice(0, i + 1).join("/");
      let dir = cur.children.find((c) => c.type === "dir" && c.name === part) as
        | DirNode
        | undefined;
      if (!dir) {
        dir = { type: "dir", name: part, dirPath, children: [] };
        cur.children.push(dir);
      }
      cur = dir;
    }
    cur.children.push({
      type: "file",
      name: parts[parts.length - 1]!,
      path: note.path,
      title: note.title,
    });
  }
  return root;
}

function sortNode(node: DirNode): void {
  node.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  for (const child of node.children) {
    if (child.type === "dir") sortNode(child);
  }
}

function renderChildren(
  container: HTMLElement,
  nodes: TreeNode[],
  depth: number,
  activePath: string | undefined,
): void {
  for (const node of nodes) {
    if (node.type === "dir") {
      renderDir(container, node, depth, activePath);
    } else {
      container.appendChild(makeFileRow(node.path, node.title, depth, activePath, true));
    }
  }
}

function renderDir(
  container: HTMLElement,
  node: DirNode,
  depth: number,
  activePath: string | undefined,
): void {
  const isCollapsed = collapsed.has(node.dirPath);

  const wrapper = document.createElement("div");
  wrapper.className = "nav-dir";

  const label = document.createElement("div");
  label.className = "nav-dir-label";
  label.style.paddingLeft = `${8 + depth * 14}px`;

  const arrow = document.createElement("span");
  arrow.className = "nav-dir-arrow";
  arrow.textContent = isCollapsed ? "▶" : "▼";
  label.appendChild(arrow);
  label.appendChild(document.createTextNode(node.name));

  const childContainer = document.createElement("div");
  childContainer.className = "nav-dir-children";
  if (isCollapsed) childContainer.style.display = "none";

  label.addEventListener("click", () => {
    const nowCollapsed = !collapsed.has(node.dirPath);
    if (nowCollapsed) collapsed.add(node.dirPath);
    else collapsed.delete(node.dirPath);
    arrow.textContent = nowCollapsed ? "▶" : "▼";
    childContainer.style.display = nowCollapsed ? "none" : "";
  });

  renderChildren(childContainer, node.children, depth + 1, activePath);
  wrapper.appendChild(label);
  wrapper.appendChild(childContainer);
  container.appendChild(wrapper);
}

function makeFileRow(
  path: string,
  title: string,
  depth: number,
  activePath: string | undefined,
  indent: boolean,
): HTMLElement {
  const el = document.createElement("div");
  el.className = "nav-file" + (path === activePath ? " active" : "");
  // depth * 14 for nesting, +14 for arrow gutter when in tree, +8 base padding
  el.style.paddingLeft = indent ? `${8 + depth * 14 + 14}px` : "8px";
  el.textContent = title || stemFromPath(path);
  el.title = path;
  el.addEventListener("click", () => openTab(path));
  return el;
}

// Exported so main.ts can emit on creates/deletes that don't go through SSE
export function notifyFilesChanged(): void {
  emit("files:changed", undefined);
}
