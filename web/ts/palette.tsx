import { For, createSignal } from "solid-js";

import type { Command } from "./commands.ts";
export { matchesKey, type Command } from "./commands.ts";
import { scrollSelectedIndexIntoView, wrapSelectionIndex } from "./listbox.ts";
import { createOverlayLifecycle } from "./overlay-lifecycle.ts";
import { OverlayFrame } from "./overlay.tsx";
import { uiStore } from "./ui-store.ts";

type PaletteProps = {
  commands: () => readonly Command[];
};

export function PaletteModal(props: Readonly<PaletteProps>) {
  let inputEl: HTMLInputElement | null = null;
  let listEl: HTMLDivElement | null = null;
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);

  function filtered() {
    const trimmed = query().trim().toLowerCase();
    if (!trimmed) {
      return props.commands();
    }
    return props.commands().filter((command) => command.label.toLowerCase().includes(trimmed));
  }

  function open() {
    setQuery("");
    setSelectedIndex(0);
    queueMicrotask(() => {
      if (inputEl) {
        inputEl.value = "";
        inputEl.focus();
      }
    });
  }

  function close() {
    uiStore.closePalette();
    inputEl?.blur();
  }

  function selectCommand(command: Command) {
    close();
    command.action();
  }

  function updateSelection(delta: number) {
    const items = filtered();
    setSelectedIndex((index) => wrapSelectionIndex(index, delta, items.length));
    scrollSelectedIndexIntoView(listEl, selectedIndex());
  }

  function handleKeyDown(e: KeyboardEvent) {
    const items = filtered();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      updateSelection(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      updateSelection(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const command = items[selectedIndex()];
      if (command) {
        selectCommand(command);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  const overlay = createOverlayLifecycle({
    isOpen: uiStore.paletteOpen,
    onOpen: open,
    onClose: close,
  });

  return (
    <OverlayFrame id="palette-overlay" isOpen={uiStore.paletteOpen()} onClose={overlay.close}>
      <div class="palette-modal" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          id="palette-input"
          ref={(el) => {
            inputEl = el;
          }}
          type="text"
          placeholder="Type a command..."
          aria-label="Command search"
          autocomplete="off"
          spellcheck={false}
          on:input={(e) => {
            setQuery(e.currentTarget.value);
            setSelectedIndex(0);
          }}
          on:keydown={handleKeyDown}
        />
        <div
          id="palette-list"
          ref={(el) => {
            listEl = el;
          }}
        >
          <For each={filtered()}>
            {(command, index) => (
              <button
                type="button"
                class={`palette-item${index() === selectedIndex() ? " selected" : ""}`}
                onClick={() => selectCommand(command)}
              >
                <span class="palette-label">{command.label}</span>
                <span class="palette-shortcut">{command.shortcut}</span>
              </button>
            )}
          </For>
        </div>
      </div>
    </OverlayFrame>
  );
}
