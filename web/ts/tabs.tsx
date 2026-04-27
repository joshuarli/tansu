import { For, createEffect, createSignal, onCleanup, onMount } from "solid-js";
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

function TabBar() {
  const [hoveredIndex, setHoveredIndex] = createSignal(-1);

  // Tooltip lives in document.body for viewport-relative positioning.
  const tooltipEl = document.createElement("div");
  tooltipEl.className = "tab-tooltip";
  document.body.append(tooltipEl);
  onCleanup(() => tooltipEl.remove());

  function showTooltip(tabEl: HTMLElement, label: string) {
    const rect = tabEl.getBoundingClientRect();
    tooltipEl.textContent = label;
    tooltipEl.style.top = `${rect.bottom + 6}px`;
    tooltipEl.style.left = `${rect.left + rect.width / 2}px`;
    tooltipEl.style.display = "block";
  }

  function hideTooltip() {
    tooltipEl.style.display = "none";
  }

  // Reset hover state when the hovered tab is removed by any means.
  createEffect(() => {
    if (hoveredIndex() !== -1 && hoveredIndex() >= getTabs().length) {
      setHoveredIndex(-1);
      hideTooltip();
    }
  });

  onMount(() => {
    const handler = (e: KeyboardEvent) => {
      if (hoveredIndex() === -1 || e.key !== " " || e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }
      const target = e.target as Element;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
        return;
      }
      e.preventDefault();
      const idx = hoveredIndex();
      setHoveredIndex(-1);
      hideTooltip();
      closeTab(idx);
    };
    document.addEventListener("keydown", handler);
    onCleanup(() => document.removeEventListener("keydown", handler));
  });

  // Keep #empty-state visibility in sync with the tab list.
  createEffect(() => {
    const emptyState = document.querySelector<HTMLElement>("#empty-state");
    if (emptyState) {
      emptyState.style.display = getTabs().length === 0 ? "flex" : "none";
    }
  });

  // Scroll the active tab into view whenever the active index changes.
  createEffect(() => {
    getActiveIndex(); // track
    queueMicrotask(() => {
      document.querySelector<HTMLElement>("#tab-bar .tab.active")?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
    });
  });

  return (
    <For each={getTabs()}>
      {(tab, i) => (
        <div
          class={`tab${i() === getActiveIndex() ? " active" : ""}`}
          onMouseEnter={(e) => {
            setHoveredIndex(i());
            showTooltip(e.currentTarget, `${tab.title} (space to close)`);
          }}
          onMouseLeave={() => {
            setHoveredIndex(-1);
            hideTooltip();
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
  );
}

// Tab-new button rendered alongside TabBar but outside it to avoid being
// inside the <For> reactive scope.
function TabBarShell() {
  return (
    <>
      <TabBar />
      <div class="tab tab-new" title="New note (Ctrl+N)" onClick={() => void promptNewNote()}>
        +
      </div>
    </>
  );
}

let tabBarMounted = false;

function renderTabs() {
  if (tabBarMounted) return;
  const tabBar = document.querySelector("#tab-bar");
  if (!(tabBar instanceof HTMLElement)) return;
  tabBarMounted = true;
  render(() => <TabBarShell />, tabBar);
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
