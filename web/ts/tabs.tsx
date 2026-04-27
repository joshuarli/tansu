import { For } from "solid-js";
import { render } from "solid-js/web";

import { getPinnedFiles } from "./api.ts";
import { showContextMenu } from "./context-menu.ts";
import { on } from "./events.ts";
import { buildFileContextMenuItems } from "./file-actions.ts";
import { showInputDialog } from "./input-dialog.ts";
import {
  closeTab,
  createNewNote as _createNewNote,
  getActiveIndex,
  getTabs,
  switchTab,
} from "./tab-state.ts";

export async function promptNewNote(): Promise<void> {
  const name = await showInputDialog("New note name...");
  if (!name) {
    return;
  }
  await _createNewNote(name);
}

let hoveredTabIndex = -1;
let tabBarDispose: (() => void) | null = null;

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
  if (hoveredTabIndex === -1 || e.key !== " " || e.metaKey || e.ctrlKey || e.altKey) {
    return;
  }
  const target = e.target as Element;
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
    return;
  }
  e.preventDefault();
  closeTab(hoveredTabIndex);
});

function TabBarView() {
  const tabs = getTabs();
  const activeIndex = getActiveIndex();
  return (
    <>
      <For each={tabs}>
        {(tab, i) => (
          <div
            class={`tab${i() === activeIndex ? " active" : ""}`}
            onMouseEnter={(e) => {
              hoveredTabIndex = i();
              showTabTooltip(e.currentTarget, `${tab.title} (space to close)`);
            }}
            onMouseLeave={() => {
              hoveredTabIndex = -1;
              hideTabTooltip();
            }}
            onClick={() => switchTab(i())}
            onContextMenu={(e) => void showTabContextMenu(e, i())}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                closeTab(i());
              }
            }}
          >
            {tab.dirty ? <span class="dirty">●</span> : null}
            <span class="tab-label">
              <span class="tab-label-text">{tab.title}</span>
            </span>
            <span
              class="close"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(i());
              }}
            >
              ×
            </span>
          </div>
        )}
      </For>
      <div class="tab tab-new" title="New note (Ctrl+N)" onClick={() => void promptNewNote()}>
        +
      </div>
    </>
  );
}

function renderTabs() {
  const tabBar = document.querySelector("#tab-bar");
  const emptyState = document.querySelector<HTMLElement>("#empty-state");
  if (!(tabBar instanceof HTMLElement)) {
    return;
  }
  tabBarDispose?.();
  tabBar.textContent = "";
  hoveredTabIndex = -1;
  hideTabTooltip();
  const tabs = getTabs();
  if (emptyState) {
    emptyState.style.display = tabs.length === 0 ? "flex" : "none";
  }
  tabBarDispose = render(() => <TabBarView />, tabBar);
  tabBar
    .querySelector<HTMLElement>(".tab.active")
    ?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

on("tab:render", renderTabs);

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
