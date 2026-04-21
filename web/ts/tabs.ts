/// Tab bar DOM rendering.

import { deleteNote, pinFile, unpinFile, getPinnedFiles } from "./api.ts";
import { showContextMenu } from "./context-menu.ts";
import { emit, on } from "./events.ts";
import { showInputDialog } from "./input-dialog.ts";
import {
  getTabs,
  getActiveIndex,
  switchTab,
  closeTab,
  createNewNote as _createNewNote,
} from "./tab-state.ts";

export {
  type Tab,
  getTabs,
  getActiveTab,
  openTab,
  closeTab,
  closeActiveTab,
  nextTab,
  prevTab,
  markDirty,
  markClean,
  updateTabContent,
  updateTabPath,
  restoreSession,
  reopenClosedTab,
  syncToServer,
} from "./tab-state.ts";

export async function createNewNote(): Promise<void> {
  const name = await showInputDialog("New note name...");
  if (!name) return;
  await _createNewNote(name);
}

on("tab:render", render);

let hoveredTabIndex = -1;

document.addEventListener("keydown", (e) => {
  if (hoveredTabIndex === -1) return;
  if (e.key !== "x" && e.key !== "X") return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const target = e.target as Element;
  if (
    target.closest("[contenteditable]") ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA"
  )
    return;
  e.preventDefault();
  closeTab(hoveredTabIndex);
});

function render() {
  const tabBar = document.getElementById("tab-bar")!;
  const emptyState = document.getElementById("empty-state")!;
  tabBar.innerHTML = "";
  hoveredTabIndex = -1;
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

    el.addEventListener("mouseenter", () => {
      hoveredTabIndex = i;
    });
    el.addEventListener("mouseleave", () => {
      hoveredTabIndex = -1;
    });
    el.onclick = () => switchTab(i);
    el.oncontextmenu = (e) => showTabContextMenu(e, i);
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

async function showTabContextMenu(e: MouseEvent, index: number) {
  e.preventDefault();
  const tabs = getTabs();
  const tab = tabs[index];
  if (!tab) return;

  const pinned = await getPinnedFiles();
  const isPinned = pinned.some((f) => f.path === tab.path);

  showContextMenu(
    [
      {
        label: "Rename...",
        onclick: async () => {
          const newName = await showInputDialog("Rename to...", tab.title);
          if (newName && newName !== tab.title) {
            window.dispatchEvent(
              new CustomEvent("tansu:rename", { detail: { path: tab.path, newName } }),
            );
          }
        },
      },
      {
        label: isPinned ? "Unpin" : "Pin",
        onclick: () => {
          const action = isPinned ? unpinFile(tab.path) : pinFile(tab.path);
          action.then(() => emit("pinned:changed", undefined));
        },
      },
      {
        label: "Delete",
        danger: true,
        onclick: () => {
          if (!confirm(`Delete ${tab.title}?`)) return;
          deleteNote(tab.path).then(() => {
            closeTab(index);
            emit("files:changed", undefined);
          });
        },
      },
      {
        label: "Close",
        onclick: () => closeTab(index),
      },
    ],
    e.clientX,
    e.clientY,
  );
}
