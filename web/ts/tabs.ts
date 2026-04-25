/// Tab bar DOM rendering.

import { getPinnedFiles } from "./api.ts";
import { showContextMenu } from "./context-menu.ts";
import { on } from "./events.ts";
import { buildFileContextMenuItems } from "./file-actions.ts";
import { showInputDialog } from "./input-dialog.ts";
import {
  getTabs,
  getActiveIndex,
  switchTab,
  closeTab,
  createNewNote as _createNewNote,
} from "./tab-state.ts";

export async function promptNewNote(): Promise<void> {
  const name = await showInputDialog("New note name...");
  if (!name) {
    return;
  }
  await _createNewNote(name);
}

on("tab:render", render);

let hoveredTabIndex = -1;

const tabTooltip = document.createElement("div");
tabTooltip.className = "tab-tooltip";
document.body.append(tabTooltip);

function showTabTooltip(tabEl: HTMLElement, label: string) {
  tabTooltip.textContent = label;
  const rect = tabEl.getBoundingClientRect();
  tabTooltip.style.top = `${rect.bottom + 6}px`;
  tabTooltip.style.left = `${rect.left + rect.width / 2}px`;
  tabTooltip.style.display = "block";
}

function hideTabTooltip() {
  tabTooltip.style.display = "none";
}

document.addEventListener("keydown", (e) => {
  if (hoveredTabIndex === -1) {
    return;
  }
  if (e.key !== " ") {
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) {
    return;
  }
  const target = e.target as Element;
  // Allow space in text inputs but not in contenteditable — the editor is
  // always focused, so we must intercept there too and preventDefault stops
  // the character from being inserted.
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
    return;
  }
  e.preventDefault();
  closeTab(hoveredTabIndex);
});

function render() {
  const tabBar = document.querySelector("#tab-bar")!;
  const emptyState = document.querySelector<HTMLElement>("#empty-state");
  tabBar.innerHTML = "";
  hoveredTabIndex = -1;
  hideTabTooltip();
  const tabs = getTabs();
  const activeIndex = getActiveIndex();
  if (emptyState) {
    emptyState.style.display = tabs.length === 0 ? "flex" : "none";
  }

  for (const [i, tab] of tabs.entries()) {
    const el = document.createElement("div");
    el.className = `tab${i === activeIndex ? " active" : ""}`;

    if (tab.dirty) {
      const dot = document.createElement("span");
      dot.className = "dirty";
      dot.textContent = "\u25CF";
      el.append(dot);
    }

    const label = document.createElement("span");
    label.className = "tab-label";
    const labelText = document.createElement("span");
    labelText.className = "tab-label-text";
    labelText.textContent = tab.title;
    label.append(labelText);
    el.append(label);

    const closeBtn = document.createElement("span");
    closeBtn.className = "close";
    closeBtn.textContent = "\u00D7";
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      closeTab(i);
    };
    el.append(closeBtn);

    el.addEventListener("mouseenter", () => {
      hoveredTabIndex = i;
      showTabTooltip(el, `${tab.title} (space to close)`);
    });
    el.addEventListener("mouseleave", () => {
      hoveredTabIndex = -1;
      hideTabTooltip();
    });
    el.onclick = () => switchTab(i);
    el.oncontextmenu = (e) => showTabContextMenu(e, i);
    el.onauxclick = (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeTab(i);
      }
    };

    tabBar.append(el);
  }

  const addBtn = document.createElement("div");
  addBtn.className = "tab tab-new";
  addBtn.textContent = "+";
  addBtn.title = "New note (Ctrl+N)";
  addBtn.onclick = () => promptNewNote();
  tabBar.append(addBtn);

  tabBar
    .querySelector<HTMLElement>(".tab.active")
    ?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

async function showTabContextMenu(e: MouseEvent, index: number) {
  e.preventDefault();
  const tabs = getTabs();
  const tab = tabs[index];
  if (!tab) {
    return;
  }

  const pinned = await getPinnedFiles();
  const isPinned = pinned.some((f) => f.path === tab.path);

  showContextMenu(
    buildFileContextMenuItems({
      path: tab.path,
      title: tab.title,
      isPinned,
      onDeleted: () => closeTab(index),
      onClosed: () => closeTab(index),
    }),
    e.clientX,
    e.clientY,
  );
}
