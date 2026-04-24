/// Lightweight in-app text input dialog — replaces native prompt().
/// Returns a Promise that resolves to the trimmed value, or null on cancel.

let pendingResolve: ((val: string | null) => void) | null = null;

export function showInputDialog(placeholder: string, defaultValue = ""): Promise<string | null> {
  // Cancel any in-flight dialog (shouldn't happen, but be safe)
  if (pendingResolve) {
    pendingResolve(null);
  }

  return new Promise((resolve) => {
    const overlay = document.querySelector("#input-dialog-overlay")!;
    const input = document.querySelector("#input-dialog-input")! as HTMLInputElement;

    pendingResolve = resolve;
    input.placeholder = placeholder;
    input.value = defaultValue;
    overlay.classList.remove("hidden");
    input.focus();
    input.select();

    function submit() {
      const val = input.value.trim();
      close();
      resolve(val || null);
    }

    function cancel() {
      close();
      resolve(null);
    }

    function close() {
      overlay.classList.add("hidden");
      pendingResolve = null;
      input.removeEventListener("keydown", onKeydown);
      overlay.removeEventListener("click", onBackdrop);
    }

    function onKeydown(e: KeyboardEvent) {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    }

    function onBackdrop(e: Event) {
      if (e.target === overlay) {
        cancel();
      }
    }

    input.addEventListener("keydown", onKeydown);
    overlay.addEventListener("click", onBackdrop);
  });
}
