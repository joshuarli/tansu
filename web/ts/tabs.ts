/// Tab bar DOM rendering. Re-exports all tab state for backwards compatibility.

import { deleteNote } from "./api.ts";
import { on } from "./events.ts";
import { getTabs, getActiveIndex, switchTab, closeTab, createNewNote } from "./tab-state.ts";

export {
  type Tab,
  getTabs,
  getActiveTab,
  getActiveIndex,
  openTab,
  switchTab,
  closeTab,
  closeActiveTab,
  nextTab,
  prevTab,
  markDirty,
  markClean,
  updateTabContent,
  updateTabPath,
  deleteActiveTab,
  createNewNote,
  restoreSession,
} from "./tab-state.ts";

let contextMenuEl: HTMLElement | null = null;

on("tab:render", render);

function render() {
  const tabBar = document.getElementById("tab-bar")!;
  const emptyState = document.getElementById("empty-state")!;
  tabBar.innerHTML = "";
  const tabs = getTabs();
  const activeIndex = getActiveIndex();
  emptyState.style.display = tabs.length === 0 ? "flex" : "none";

  tabs.forEach((tab, i) => {
    const el = document.createElement("div");
    el.className = "tab" + (i === activeIndex ? " active" : "");

    if (tab.dirty) {
      const dot = document.createElement("span");
      dot.className = "dirty";
      dot.textContent = "\u25cf";
      el.appendChild(dot);
    }

    const label = document.createElement("span");
    label.textContent = tab.title;
    el.appendChild(label);

    const closeBtn = document.createElement("span");
    closeBtn.className = "close";
    closeBtn.textContent = "\u00d7";
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      closeTab(i);
    };
    el.appendChild(closeBtn);

    el.onclick = () => switchTab(i);
    el.oncontextmenu = (e) => showContextMenu(e, i);
    el.onauxclick = (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeTab(i);
      }
    };

    tabBar.appendChild(el);
  });

  const addBtn = document.createElement("div");
  addBtn.className = "tab tab-new";
  addBtn.textContent = "+";
  addBtn.title = "New note (Cmd+T)";
  addBtn.onclick = () => createNewNote();
  tabBar.appendChild(addBtn);
}

function showContextMenu(e: MouseEvent, index: number) {
  e.preventDefault();
  hideContextMenu();

  const tabs = getTabs();
  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;

  const rename = document.createElement("div");
  rename.className = "context-menu-item";
  rename.textContent = "Rename...";
  rename.onclick = () => {
    hideContextMenu();
    const tab = tabs[index];
    if (!tab) return;
    const newName = prompt("New name:", tab.title);
    if (newName && newName !== tab.title) {
      window.dispatchEvent(
        new CustomEvent("tansu:rename", {
          detail: { path: tab.path, newName },
        }),
      );
    }
  };

  const del = document.createElement("div");
  del.className = "context-menu-item danger";
  del.textContent = "Delete";
  del.onclick = () => {
    hideContextMenu();
    const tab = tabs[index];
    if (!tab) return;
    if (!confirm(`Delete ${tab.title}?`)) return;
    deleteNote(tab.path).then(() => {
      closeTab(index);
    });
  };

  const close = document.createElement("div");
  close.className = "context-menu-item";
  close.textContent = "Close";
  close.onclick = () => {
    hideContextMenu();
    closeTab(index);
  };

  menu.append(rename, del, close);
  document.body.appendChild(menu);
  contextMenuEl = menu;

  const dismiss = () => {
    hideContextMenu();
    document.removeEventListener("click", dismiss);
  };
  setTimeout(() => document.addEventListener("click", dismiss), 0);
}

function hideContextMenu() {
  if (contextMenuEl) {
    contextMenuEl.remove();
    contextMenuEl = null;
  }
}
