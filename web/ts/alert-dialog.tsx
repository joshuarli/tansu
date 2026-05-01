import { Show, createEffect } from "solid-js";

import { OverlayFrame } from "./overlay.tsx";
import { createPromiseModalController } from "./promise-modal.ts";

type AlertDialogState = {
  title: string;
  message: string;
};

let buttonEl: HTMLButtonElement | null = null;
const dialog = createPromiseModalController<AlertDialogState, void>("alert-dialog", undefined);

export function AlertDialogHost() {
  createEffect(() => {
    if (dialog.current() && dialog.isOpen() && buttonEl) {
      buttonEl.focus();
    }
  });

  return (
    <OverlayFrame
      id="alert-dialog-overlay"
      isOpen={dialog.isOpen()}
      onClose={() => {
        dialog.cancel();
      }}
    >
      <div
        class="input-dialog alert-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={dialog.current()?.title ?? "Alert"}
      >
        <Show when={dialog.current()}>
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
                onClick={() => dialog.closeWithResult(undefined)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" || e.key === "Enter") {
                    e.preventDefault();
                    dialog.closeWithResult(undefined);
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
  return dialog.open({ title, message });
}
