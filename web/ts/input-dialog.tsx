import { Show, createEffect } from "solid-js";

import { OverlayFrame } from "./overlay.tsx";
import { createPromiseModalController } from "./promise-modal.ts";

import styles from "./dialog.module.css";

type DialogState = {
  placeholder: string;
  defaultValue: string;
};

let inputEl: HTMLInputElement | null = null;
const dialog = createPromiseModalController<DialogState, string | null>("input-dialog", null);

export function InputDialogHost() {
  createEffect(() => {
    const current = dialog.current();
    if (!current || !dialog.isOpen() || !inputEl) {
      return;
    }
    inputEl.value = current.defaultValue;
    inputEl.focus();
    inputEl.select();
  });

  return (
    <OverlayFrame
      id="input-dialog-overlay"
      class={styles["overlay"]}
      isOpen={dialog.isOpen()}
      onClose={() => {
        dialog.cancel();
      }}
    >
      <div
        class={styles["panel"]}
        role="dialog"
        aria-modal="true"
        aria-label={dialog.current()?.placeholder ?? "Enter text"}
      >
        <Show when={dialog.current()}>
          {(current) => (
            <input
              id="input-dialog-input"
              ref={(el) => {
                inputEl = el;
              }}
              class={styles["input"]}
              type="text"
              placeholder={current().placeholder}
              autocomplete="off"
              spellcheck={false}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  dialog.closeWithResult(e.currentTarget.value.trim() || null);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  dialog.cancel();
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
  return dialog.open({ placeholder, defaultValue });
}
