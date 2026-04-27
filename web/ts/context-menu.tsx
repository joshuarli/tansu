import { render } from "solid-js/web";

export type MenuItem = {
  label: string;
  danger?: boolean;
  onclick: () => void;
};

type ContextMenuProps = {
  items: readonly MenuItem[];
  x: number;
  y: number;
  onSelect: (onclick: () => void) => void;
};

let activeHost: HTMLDivElement | null = null;
let disposeRoot: (() => void) | null = null;
let dismissHandler: (() => void) | null = null;

function ContextMenu(props: Readonly<ContextMenuProps>) {
  return (
    <div class="context-menu" style={{ left: `${props.x}px`, top: `${props.y}px` }}>
      {props.items.map((item) => (
        <div
          class={`context-menu-item${item.danger ? " danger" : ""}`}
          onClick={() => props.onSelect(item.onclick)}
        >
          {item.label}
        </div>
      ))}
    </div>
  );
}

export function showContextMenu(items: MenuItem[], x: number, y: number): void {
  hide();

  const host = document.createElement("div");
  document.body.append(host);
  activeHost = host;
  disposeRoot = render(
    () => (
      <ContextMenu
        items={items}
        x={x}
        y={y}
        onSelect={(onclick) => {
          hide();
          // Defer so the click event finishes propagating before any DOM mutations
          // triggered by the action (e.g. tab re-renders, nested dispatchEvent).
          setTimeout(() => onclick(), 0);
        }}
      />
    ),
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
