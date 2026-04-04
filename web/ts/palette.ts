export interface KeyBinding {
  key: string;
  meta?: boolean;
  shift?: boolean;
}

export interface Command {
  label: string;
  shortcut: string;
  keys?: KeyBinding;
  action: () => void;
}

/// Check if a keyboard event matches a key binding.
export function matchesKey(e: KeyboardEvent, k: KeyBinding): boolean {
  const meta = e.metaKey || e.ctrlKey;
  if (k.meta && !meta) return false;
  if (!k.meta && meta) return false;
  if (k.shift && !e.shiftKey) return false;
  if (!k.shift && e.shiftKey) return false;
  return e.key === k.key;
}

export interface Palette {
  toggle(): void;
  open(): void;
  close(): void;
  isOpen(): boolean;
  registerCommands(cmds: Command[]): void;
  getCommands(): Command[];
}

export function createPalette(): Palette {
  const overlay = document.getElementById("palette-overlay")!;
  const input = document.getElementById("palette-input")! as HTMLInputElement;
  const listEl = document.getElementById("palette-list")!;

  let isOpen = false;
  let selectedIndex = 0;
  let commands: Command[] = [];

  function getFiltered(): Command[] {
    const q = input.value.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q));
  }

  function updateSelection() {
    const items = listEl.children;
    for (let i = 0; i < items.length; i++) {
      items[i]!.classList.toggle("selected", i === selectedIndex);
    }
    items[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }

  function renderList() {
    const filtered = getFiltered();
    listEl.innerHTML = "";
    filtered.forEach((cmd, i) => {
      const el = document.createElement("div");
      el.className = "palette-item" + (i === selectedIndex ? " selected" : "");

      const label = document.createElement("span");
      label.className = "palette-label";
      label.textContent = cmd.label;

      const shortcut = document.createElement("span");
      shortcut.className = "palette-shortcut";
      shortcut.textContent = cmd.shortcut;

      el.append(label, shortcut);
      el.onclick = () => {
        close();
        cmd.action();
      };
      listEl.appendChild(el);
    });
  }

  function open() {
    isOpen = true;
    overlay.classList.remove("hidden");
    input.value = "";
    selectedIndex = 0;
    renderList();
    input.focus();
  }

  function close() {
    isOpen = false;
    overlay.classList.add("hidden");
    input.blur();
  }

  function toggle() {
    if (isOpen) close();
    else open();
  }

  input.addEventListener("input", () => {
    selectedIndex = 0;
    renderList();
  });

  input.addEventListener("keydown", (e) => {
    const filtered = getFiltered();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % Math.max(filtered.length, 1);
      updateSelection();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex =
        (selectedIndex - 1 + Math.max(filtered.length, 1)) % Math.max(filtered.length, 1);
      updateSelection();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = filtered[selectedIndex];
      if (cmd) {
        close();
        cmd.action();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  return {
    toggle,
    open,
    close,
    isOpen: () => isOpen,
    registerCommands(cmds: Command[]) {
      commands = cmds;
    },
    getCommands: () => commands,
  };
}
