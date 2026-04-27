import { createEffect, createSignal, Show } from "solid-js";
import { render } from "solid-js/web";

type DialogState = {
  placeholder: string;
  defaultValue: string;
};

let pendingResolve: ((val: string | null) => void) | null = null;
let setState: ((value: DialogState | null) => void) | null = null;
let overlayEl: HTMLElement | null = null;

function closeActive(value: string | null) {
  const resolve = pendingResolve;
  pendingResolve = null;
  setState?.(null);
  resolve?.(value);
}

function InputDialog() {
  const [state, updateState] = createSignal<DialogState | null>(null);
  setState = updateState;

  createEffect(() => {
    const current = state();
    if (overlayEl) {
      overlayEl.classList.toggle("hidden", current === null);
    }
    const inputEl = overlayEl?.querySelector("#input-dialog-input");
    if (!current || !(inputEl instanceof HTMLInputElement)) {
      return;
    }
    inputEl.value = current.defaultValue;
    inputEl.focus();
    inputEl.select();
  });

  return (
    <div id="input-dialog">
      <Show when={state()}>
        {(current) => (
          <input
            id="input-dialog-input"
            type="text"
            placeholder={current().placeholder}
            autocomplete="off"
            spellcheck={false}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                closeActive(e.currentTarget.value.trim() || null);
              } else if (e.key === "Escape") {
                e.preventDefault();
                closeActive(null);
              }
            }}
          />
        )}
      </Show>
    </div>
  );
}

function ensureMounted() {
  if (setState) {
    return;
  }
  const overlay = document.querySelector("#input-dialog-overlay");
  if (!(overlay instanceof HTMLElement)) {
    throw new Error("missing #input-dialog-overlay");
  }
  overlayEl = overlay;
  overlay.textContent = "";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      closeActive(null);
    }
  });
  render(() => <InputDialog />, overlay);
}

export function showInputDialog(placeholder: string, defaultValue = ""): Promise<string | null> {
  ensureMounted();

  if (pendingResolve) {
    pendingResolve(null);
  }

  return new Promise((resolve) => {
    pendingResolve = resolve;
    setState?.({ placeholder, defaultValue });
  });
}
