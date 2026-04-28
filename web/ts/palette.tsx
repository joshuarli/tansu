import { For, createSignal } from "solid-js";
import { render } from "solid-js/web";

import { scrollSelectedIndexIntoView, wrapSelectionIndex } from "./listbox.ts";
import { createFocusRestorer, OverlayFrame } from "./overlay.tsx";

type KeyBinding = {
  key: string;
  meta?: boolean;
  shift?: boolean;
};

type Command = {
  label: string;
  shortcut: string;
  keys?: KeyBinding;
  action: () => void;
};

/// Check if a keyboard event matches a key binding.
export function matchesKey(e: KeyboardEvent, k: KeyBinding): boolean {
  const meta = e.metaKey || e.ctrlKey;
  if (k.meta && !meta) return false;
  if (!k.meta && meta) return false;
  if (k.shift && !e.shiftKey) return false;
  if (!k.shift && e.shiftKey) return false;
  return e.key === k.key;
}

type Palette = {
  toggle(): void;
  open(): void;
  close(): void;
  isOpen(): boolean;
  registerCommands(cmds: Command[]): void;
  getCommands(): Command[];
};

type PaletteState = {
  isOpen: boolean;
  query: string;
  selectedIndex: number;
};

type PaletteViewProps = {
  state: () => PaletteState;
  filtered: () => readonly Command[];
  onSelect: (cmd: Command) => void;
  inputRef: (el: HTMLInputElement) => void;
  listRef: (el: HTMLDivElement) => void;
  onInput: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
};

function PaletteView(props: Readonly<PaletteViewProps>) {
  return (
    <div class="palette-modal" role="dialog" aria-modal="true" aria-label="Command palette">
      <input
        id="palette-input"
        ref={props.inputRef}
        type="text"
        placeholder="Type a command..."
        aria-label="Command search"
        autocomplete="off"
        spellcheck={false}
        on:input={props.onInput}
        on:keydown={props.onKeyDown}
      />
      <div id="palette-list" ref={props.listRef}>
        <For each={props.filtered()}>
          {(cmd, i) => (
            <button
              type="button"
              class={`palette-item${i() === props.state().selectedIndex ? " selected" : ""}`}
              onClick={() => props.onSelect(cmd)}
            >
              <span class="palette-label">{cmd.label}</span>
              <span class="palette-shortcut">{cmd.shortcut}</span>
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

export function createPalette(container: HTMLElement): Palette {
  let commands: Command[] = [];
  let inputEl: HTMLInputElement | null = null;
  let listEl: HTMLDivElement | null = null;
  const focus = createFocusRestorer();
  const [state, setState] = createSignal<PaletteState>({
    isOpen: false,
    query: "",
    selectedIndex: 0,
  });

  function getFiltered(): Command[] {
    const q = state().query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q));
  }

  function open() {
    focus.remember();
    setState({ isOpen: true, query: "", selectedIndex: 0 });
    queueMicrotask(() => {
      if (inputEl) inputEl.value = "";
      inputEl?.focus();
    });
  }

  function close() {
    setState((prev) => ({ ...prev, isOpen: false }));
    inputEl?.blur();
    focus.restore();
  }

  function toggle() {
    if (state().isOpen) close();
    else open();
  }

  function updateSelection(delta: number) {
    const filtered = getFiltered();
    setState((prev) => ({
      ...prev,
      selectedIndex: wrapSelectionIndex(prev.selectedIndex, delta, filtered.length),
    }));
    scrollSelectedIndexIntoView(listEl, state().selectedIndex);
  }

  function selectCommand(cmd: Command) {
    close();
    cmd.action();
  }

  function handleKeyDown(e: KeyboardEvent) {
    const filtered = getFiltered();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      updateSelection(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      updateSelection(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = filtered[state().selectedIndex];
      if (cmd) selectCommand(cmd);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  render(
    () => (
      <OverlayFrame id="palette-overlay" isOpen={state().isOpen} onClose={close}>
        <PaletteView
          state={state}
          filtered={getFiltered}
          onSelect={selectCommand}
          inputRef={(el) => {
            inputEl = el;
          }}
          listRef={(el) => {
            listEl = el;
          }}
          onInput={() => {
            setState((prev) => ({
              ...prev,
              query: inputEl?.value ?? "",
              selectedIndex: 0,
            }));
          }}
          onKeyDown={handleKeyDown}
        />
      </OverlayFrame>
    ),
    container,
  );

  return {
    toggle,
    open,
    close,
    isOpen: () => state().isOpen,
    registerCommands(cmds: Command[]) {
      commands = cmds;
      setState((prev) => ({ ...prev, selectedIndex: 0 }));
    },
    getCommands: () => commands,
  };
}
