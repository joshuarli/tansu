import { createComponent } from "solid-js";
import { render } from "solid-js/web";

import { ContextMenu, type MenuItem } from "./context-menu-view.tsx";

export type { MenuItem } from "./context-menu-view.tsx";

let activeHost: HTMLDivElement | null = null;
let disposeRoot: (() => void) | null = null;
let dismissHandler: (() => void) | null = null;

export function showContextMenu(items: MenuItem[], x: number, y: number): void {
  hide();

  const host = document.createElement("div");
  document.body.append(host);
  activeHost = host;
  disposeRoot = render(
    () =>
      createComponent(ContextMenu, {
        items,
        x,
        y,
        onSelect: (onclick) => {
          hide();
          // Defer so the click event finishes propagating before any DOM mutations
          // triggered by the action (e.g. tab re-renders, nested dispatchEvent).
          setTimeout(() => onclick(), 0);
        },
        onClose: hide,
      }),
    host,
  );

  const handler = () => hide();
  dismissHandler = handler;
  setTimeout(() => {
    if (dismissHandler === handler) {
      document.addEventListener("click", handler);
    }
  }, 0);
}

function hide(): void {
  if (dismissHandler) {
    document.removeEventListener("click", dismissHandler);
    dismissHandler = null;
  }
  if (disposeRoot) {
    disposeRoot();
    disposeRoot = null;
  }
  if (activeHost) {
    activeHost.remove();
    activeHost = null;
  }
}
