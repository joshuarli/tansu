/// Singleton context menu — only one may be visible at a time.

interface MenuItem {
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
    el.className = `context-menu-item${item.danger ? " danger" : ""}`;
    el.textContent = item.label;
    el.onclick = () => {
      hide();
      // Defer so the click event finishes propagating before any DOM mutations
      // triggered by the action (e.g. tab re-renders, nested dispatchEvent).
      setTimeout(() => item.onclick(), 0);
    };
    menu.append(el);
  }

  document.body.append(menu);
  active = menu;

  const handler = () => hide();
  dismissHandler = handler;
  setTimeout(() => {
    // Only register if hide() hasn't been called since this menu was shown.
    if (dismissHandler === handler) {
      document.addEventListener("click", handler);
    }
  }, 0);
}

function hide(): void {
  if (active) {
    active.remove();
    active = null;
  }
  if (dismissHandler) {
    document.removeEventListener("click", dismissHandler);
    dismissHandler = null;
  }
}
