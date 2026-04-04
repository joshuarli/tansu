const overlay = document.getElementById('palette-overlay')!;
const input = document.getElementById('palette-input')! as HTMLInputElement;
const listEl = document.getElementById('palette-list')!;

let isOpen = false;
let selectedIndex = 0;

interface Command {
  label: string;
  shortcut: string;
  action: () => void;
}

let commands: Command[] = [];

export function registerCommands(cmds: Command[]) {
  commands = cmds;
}

export function togglePalette() {
  if (isOpen) closePalette();
  else openPalette();
}

export function openPalette() {
  isOpen = true;
  overlay.classList.remove('hidden');
  input.value = '';
  selectedIndex = 0;
  renderList();
  input.focus();
}

export function closePalette() {
  isOpen = false;
  overlay.classList.add('hidden');
  input.blur();
}

export function isPaletteOpen(): boolean {
  return isOpen;
}

input.addEventListener('input', () => {
  selectedIndex = 0;
  renderList();
});

input.addEventListener('keydown', (e) => {
  const filtered = getFiltered();
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectedIndex = (selectedIndex + 1) % Math.max(filtered.length, 1);
    updateSelection();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    selectedIndex = (selectedIndex - 1 + Math.max(filtered.length, 1)) % Math.max(filtered.length, 1);
    updateSelection();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const cmd = filtered[selectedIndex];
    if (cmd) {
      closePalette();
      cmd.action();
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closePalette();
  }
});

overlay.addEventListener('click', (e) => {
  if (e.target === overlay) closePalette();
});

function getFiltered(): Command[] {
  const q = input.value.trim().toLowerCase();
  if (!q) return commands;
  return commands.filter(c => c.label.toLowerCase().includes(q));
}

function renderList() {
  const filtered = getFiltered();
  listEl.innerHTML = '';
  filtered.forEach((cmd, i) => {
    const el = document.createElement('div');
    el.className = 'palette-item' + (i === selectedIndex ? ' selected' : '');

    const label = document.createElement('span');
    label.className = 'palette-label';
    label.textContent = cmd.label;

    const shortcut = document.createElement('span');
    shortcut.className = 'palette-shortcut';
    shortcut.textContent = cmd.shortcut;

    el.append(label, shortcut);
    el.onclick = () => {
      closePalette();
      cmd.action();
    };
    listEl.appendChild(el);
  });
}

function updateSelection() {
  const items = listEl.children;
  for (let i = 0; i < items.length; i++) {
    items[i]!.classList.toggle('selected', i === selectedIndex);
  }
  items[selectedIndex]?.scrollIntoView({ block: 'nearest' });
}
