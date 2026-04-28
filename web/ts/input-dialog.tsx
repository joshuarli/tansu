import { createEffect, createSignal, Show } from "solid-js";
import { render } from "solid-js/web";

import { createFocusRestorer } from "./overlay.tsx";

type DialogState = {
  placeholder: string;
  defaultValue: string;
};

let pendingResolve: ((val: string | null) => void) | null = null;
let setState: ((value: DialogState | null) => void) | null = null;
let overlayEl: HTMLElement | null = null;
let inputEl: HTMLInputElement | null = null;
const focus = createFocusRestorer();

function closeActive(value: string | null) {
  const resolve = pendingResolve;
  pendingResolve = null;
  setState?.(null);
  focus.restore();
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
    if (!current || !inputEl) {
      return;
    }
    inputEl.value = current.defaultValue;
    inputEl.focus();
    inputEl.select();
  });

  return (
    <div
      class="input-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={state()?.placeholder ?? "Enter text"}
    >
      <Show when={state()}>
        {(current) => (
          <input
            id="input-dialog-input"
            ref={(el) => {
              inputEl = el;
            }}
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

export function initInputDialog(overlay: HTMLElement) {
  if (setState) {
    return;
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
  if (!overlayEl) {
    throw new Error("input dialog not initialized");
  }

  focus.remember();

  if (pendingResolve) {
    pendingResolve(null);
  }

  return new Promise((resolve) => {
    pendingResolve = resolve;
    setState?.({ placeholder, defaultValue });
  });
}
