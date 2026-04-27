import { createSignal, For } from "solid-js";
import { render } from "solid-js/web";

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
  if (k.meta && !meta) {
    return false;
  }
  if (!k.meta && meta) {
    return false;
  }
  if (k.shift && !e.shiftKey) {
    return false;
  }
  if (!k.shift && e.shiftKey) {
    return false;
  }
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
};

function PaletteView(props: Readonly<PaletteViewProps>) {
  return (
    <div class="palette-modal" role="dialog" aria-modal="true" aria-label="Command palette">
      <input
        id="palette-input"
        type="text"
        placeholder="Type a command..."
        aria-label="Command search"
        autocomplete="off"
        spellcheck={false}
      />
      <div id="palette-list">
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

export function createPalette(): Palette {
  const overlay = document.querySelector("#palette-overlay");
  if (!(overlay instanceof HTMLElement)) {
    throw new Error("missing #palette-overlay");
  }
  const overlayEl = overlay;
  overlayEl.textContent = "";

  let commands: Command[] = [];
  let inputEl: HTMLInputElement | null = null;
  let savedFocus: Element | null = null;
  const [state, setState] = createSignal<PaletteState>({
    isOpen: false,
    query: "",
    selectedIndex: 0,
  });

  function getFiltered(): Command[] {
    const q = state().query.trim().toLowerCase();
    if (!q) {
      return commands;
    }
    return commands.filter((c) => c.label.toLowerCase().includes(q));
  }

  function focusInput() {
    queueMicrotask(() => {
      inputEl = document.querySelector("#palette-input");
      if (inputEl) {
        inputEl.value = state().query;
      }
      inputEl?.focus();
    });
  }

  function open() {
    savedFocus = document.activeElement;
    setState({
      isOpen: true,
      query: "",
      selectedIndex: 0,
    });
    overlayEl.classList.remove("hidden");
    focusInput();
  }

  function close() {
    setState((prev) => ({ ...prev, isOpen: false }));
    overlayEl.classList.add("hidden");
    inputEl?.blur();
    if (savedFocus instanceof HTMLElement) {
      savedFocus.focus();
    }
    savedFocus = null;
  }

  function toggle() {
    if (state().isOpen) {
      close();
    } else {
      open();
    }
  }

  function updateSelection(delta: number) {
    const filtered = getFiltered();
    const len = Math.max(filtered.length, 1);
    setState((prev) => ({
      ...prev,
      selectedIndex: (prev.selectedIndex + delta + len) % len,
    }));
    queueMicrotask(() => {
      const items = document.querySelector("#palette-list")?.children;
      items?.[state().selectedIndex]?.scrollIntoView({ block: "nearest" });
    });
  }

  function selectCommand(cmd: Command) {
    close();
    cmd.action();
  }

  render(
    () => <PaletteView state={state} filtered={getFiltered} onSelect={selectCommand} />,
    overlayEl,
  );

  inputEl = document.querySelector("#palette-input");
  inputEl?.addEventListener("input", () => {
    setState((prev) => ({
      ...prev,
      query: inputEl?.value ?? "",
      selectedIndex: 0,
    }));
  });
  inputEl?.addEventListener("keydown", (e) => {
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
      if (cmd) {
        selectCommand(cmd);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });
  overlayEl.addEventListener("click", (e) => {
    if (e.target === overlayEl) {
      close();
    }
  });

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
