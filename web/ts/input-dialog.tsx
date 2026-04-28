import { Show, createEffect, createSignal } from "solid-js";

import { createFocusRestorer, OverlayFrame } from "./overlay.tsx";

type DialogState = {
  placeholder: string;
  defaultValue: string;
};

let pendingResolve: ((val: string | null) => void) | null = null;
let inputEl: HTMLInputElement | null = null;
const focus = createFocusRestorer();
const [state, setState] = createSignal<DialogState | null>(null);

function closeActive(value: string | null) {
  const resolve = pendingResolve;
  pendingResolve = null;
  setState(null);
  focus.restore();
  resolve?.(value);
}

export function InputDialogHost() {
  createEffect(() => {
    const current = state();
    if (!current || !inputEl) {
      return;
    }
    inputEl.value = current.defaultValue;
    inputEl.focus();
    inputEl.select();
  });

  return (
    <OverlayFrame
      id="input-dialog-overlay"
      isOpen={state() !== null}
      onClose={() => {
        closeActive(null);
      }}
    >
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
    </OverlayFrame>
  );
}

export function showInputDialog(placeholder: string, defaultValue = ""): Promise<string | null> {
  focus.remember();

  if (pendingResolve) {
    pendingResolve(null);
  }

  return new Promise((resolve) => {
    pendingResolve = resolve;
    setState({ placeholder, defaultValue });
  });
}
