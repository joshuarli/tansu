import { For, onMount } from "solid-js";

import styles from "./context-menu.module.css";

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
  onClose: () => void;
};

export function ContextMenu(props: Readonly<ContextMenuProps>) {
  const buttonRefs: HTMLButtonElement[] = [];

  onMount(() => {
    buttonRefs[0]?.focus();
  });

  function handleKeyDown(e: KeyboardEvent) {
    const focused = buttonRefs.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      buttonRefs[(focused + 1) % buttonRefs.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      buttonRefs[(focused - 1 + buttonRefs.length) % buttonRefs.length]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    }
  }

  return (
    <div
      role="menu"
      class={styles["menu"]}
      data-ui="context-menu"
      style={{ left: `${props.x}px`, top: `${props.y}px` }}
      onKeyDown={handleKeyDown}
    >
      <For each={props.items}>
        {(item, i) => (
          <button
            role="menuitem"
            type="button"
            tabIndex={-1}
            ref={(el) => {
              buttonRefs[i()] = el;
            }}
            class={`${styles["item"]}${item.danger ? ` ${styles["danger"]}` : ""}`}
            data-ui="context-menu-item"
            data-danger={item.danger ? "true" : undefined}
            onClick={() => props.onSelect(item.onclick)}
          >
            {item.label}
          </button>
        )}
      </For>
    </div>
  );
}
