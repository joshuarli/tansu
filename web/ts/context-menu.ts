/// Singleton context menu — only one may be visible at a time.

export interface MenuItem {
  label: string;
  danger?: boolean;
  onclick: () => void;
}

let active: HTMLElement | null = null;
let dismissHandler: (() => void) | null = null;

export function showContextMenu(items: MenuItem[], x: number, y: number): void {
  hide();

  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  for (const item of items) {
    const el = document.createElement("div");
    el.className = "context-menu-item" + (item.danger ? " danger" : "");
    el.textContent = item.label;
    el.onclick = () => {
      hide();
      item.onclick();
    };
    menu.appendChild(el);
  }

  document.body.appendChild(menu);
  active = menu;

  dismissHandler = () => {
    hide();
    document.removeEventListener("click", dismissHandler!);
  };
  setTimeout(() => document.addEventListener("click", dismissHandler!), 0);
}

export function hide(): void {
  if (active) {
    active.remove();
    active = null;
  }
  if (dismissHandler) {
    document.removeEventListener("click", dismissHandler);
    dismissHandler = null;
  }
}
