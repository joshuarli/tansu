import { For, createEffect, createSignal, onMount } from "solid-js";

import { getPinnedFiles } from "./api.ts";
import { showContextMenu } from "./context-menu.ts";
import { buildFileContextMenuItems } from "./file-actions.ts";
import { showInputDialog } from "./input-dialog.tsx";
import { createNewNote as _createNewNote } from "./tab-actions.ts";
import { closeTab, getActiveIndex, getTabs, switchTab } from "./tab-state.ts";

export async function promptNewNote(): Promise<void> {
  const name = await showInputDialog("New note name...");
  if (!name) {
    return;
  }
  await _createNewNote(name);
}

export function TabBar() {
  const [hoveredIndex, setHoveredIndex] = createSignal(-1);
  const [tooltip, setTooltip] = createSignal<{
    label: string;
    top: number;
    left: number;
  } | null>(null);
  let rootEl: HTMLDivElement | null = null;

  // Reset hover state when the hovered tab is removed by any means.
  createEffect(() => {
    if (hoveredIndex() !== -1 && hoveredIndex() >= getTabs().length) {
      setHoveredIndex(-1);
      setTooltip(null);
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
      setTooltip(null);
      closeTab(idx);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  });

  // Scroll the active tab into view whenever the active index changes.
  createEffect(() => {
    getActiveIndex(); // track
    queueMicrotask(() => {
      rootEl?.querySelector<HTMLElement>(".tab.active")?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
    });
  });

  return (
    <>
      <div
        ref={(el) => {
          rootEl = el;
        }}
        style={{ display: "contents" }}
      >
        <For each={getTabs()}>
          {(tab, i) => (
            <div
              class={`tab${i() === getActiveIndex() ? " active" : ""}`}
              onMouseEnter={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setHoveredIndex(i());
                setTooltip({
                  label: `${tab.title} (space to close)`,
                  top: rect.bottom + 6,
                  left: rect.left + rect.width / 2,
                });
              }}
              onMouseLeave={() => {
                setHoveredIndex(-1);
                setTooltip(null);
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
              <button
                type="button"
                class="close"
                aria-label={`Close ${tab.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(i());
                }}
              >
                ×
              </button>
            </div>
          )}
        </For>
      </div>
      <div
        class="tab-tooltip"
        style={{
          display: tooltip() ? "block" : "none",
          top: tooltip() ? `${tooltip()!.top}px` : "0px",
          left: tooltip() ? `${tooltip()!.left}px` : "0px",
        }}
      >
        {tooltip()?.label ?? ""}
      </div>
    </>
  );
}

// Tab-new button rendered alongside TabBar but outside it to avoid being
// inside the <For> reactive scope.
export function TabBarShell() {
  return (
    <>
      <TabBar />
      <button
        type="button"
        class="tab tab-new"
        title="New note (Ctrl+N)"
        aria-label="New note"
        onClick={() => void promptNewNote()}
      >
        +
      </button>
    </>
  );
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
