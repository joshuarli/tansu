import { Show, createEffect, createSignal } from "solid-js";

import { createFocusRestorer, OverlayFrame } from "./overlay.tsx";

type AlertDialogState = {
  title: string;
  message: string;
};

let pendingResolve: (() => void) | null = null;
let buttonEl: HTMLButtonElement | null = null;
const focus = createFocusRestorer();
const [state, setState] = createSignal<AlertDialogState | null>(null);

function closeActive() {
  const resolve = pendingResolve;
  pendingResolve = null;
  setState(null);
  focus.restore();
  resolve?.();
}

export function AlertDialogHost() {
  createEffect(() => {
    if (state() && buttonEl) {
      buttonEl.focus();
    }
  });

  return (
    <OverlayFrame
      id="alert-dialog-overlay"
      isOpen={state() !== null}
      onClose={() => {
        closeActive();
      }}
    >
      <div
        class="input-dialog alert-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={state()?.title ?? "Alert"}
      >
        <Show when={state()}>
          {(current) => (
            <>
              <div class="alert-dialog-title">{current().title}</div>
              <div class="alert-dialog-message">{current().message}</div>
              <button
                type="button"
                ref={(el) => {
                  buttonEl = el;
                }}
                class="alert-dialog-button"
                onClick={() => closeActive()}
                onKeyDown={(e) => {
                  if (e.key === "Escape" || e.key === "Enter") {
                    e.preventDefault();
                    closeActive();
                  }
                }}
              >
                OK
              </button>
            </>
          )}
        </Show>
      </div>
    </OverlayFrame>
  );
}

export function showAlertDialog(title: string, message: string): Promise<void> {
  focus.remember();

  if (pendingResolve) {
    pendingResolve();
  }

  return new Promise((resolve) => {
    pendingResolve = resolve;
    setState({ title, message });
  });
}
