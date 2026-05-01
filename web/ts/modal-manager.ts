import { createEffect, createSignal, on, type Accessor } from "solid-js";

export type ExclusiveModalId =
  | "palette"
  | "search"
  | "settings"
  | "vault-settings"
  | "app-settings";
export type StackableModalId = "alert-dialog" | "input-dialog";
export type ModalId = ExclusiveModalId | StackableModalId;
export type ModalOpenMode = "replace" | "stack";

type ManagedModalOptions = {
  id: ModalId;
  isRequestedOpen: Accessor<boolean>;
  onOpen?: () => void;
  onClose: () => void;
};

type ModalEntry = {
  id: ModalId;
  onDismiss: (() => void) | null;
  restoreFocusTo: HTMLElement | null;
};

type CloseModalOptions = {
  skipDismiss?: boolean;
  skipRestoreFocus?: boolean;
};

function captureFocusTarget(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

function restoreFocus(target: HTMLElement | null) {
  target?.focus();
}

export function createModalManager() {
  const [stack, setStack] = createSignal<readonly ModalEntry[]>([]);

  function dismissEntries(entries: readonly ModalEntry[], skipDismiss = false) {
    if (skipDismiss) {
      return;
    }
    for (let i = entries.length - 1; i >= 0; i--) {
      entries[i]!.onDismiss?.();
    }
  }

  function replace(id: ExclusiveModalId, onDismiss: (() => void) | null = null) {
    const prev = stack();
    const restoreFocusTo = prev[0]?.restoreFocusTo ?? captureFocusTarget();
    setStack([{ id, onDismiss, restoreFocusTo }]);
    dismissEntries(prev);
  }

  function push(id: StackableModalId, onDismiss: (() => void) | null = null) {
    const prev = stack();
    setStack([
      ...prev,
      {
        id,
        onDismiss,
        restoreFocusTo: captureFocusTarget(),
      },
    ]);
  }

  function close(id: ModalId, opts: Readonly<CloseModalOptions> = {}) {
    const prev = stack();
    const index = prev.findLastIndex((entry) => entry.id === id);
    if (index < 0) {
      return;
    }

    const removed = prev[index]!;
    const next = prev.toSpliced(index, 1);
    setStack(next);

    if (!opts.skipDismiss) {
      removed.onDismiss?.();
    }
    if (!opts.skipRestoreFocus && index === prev.length - 1) {
      restoreFocus(removed.restoreFocusTo);
    }
  }

  function closeTop(opts: Readonly<CloseModalOptions> = {}) {
    const top = stack()[stack().length - 1];
    if (!top) {
      return;
    }
    close(top.id, opts);
  }

  return {
    activeModal: () => stack()[stack().length - 1]?.id ?? null,
    has(id: ModalId) {
      return stack().some((entry) => entry.id === id);
    },
    isActive(id: ModalId) {
      return stack()[stack().length - 1]?.id === id;
    },
    replace,
    push,
    close,
    closeTop,
  };
}

export function createManagedModal(opts: Readonly<ManagedModalOptions>) {
  const shouldRender = () => opts.isRequestedOpen();
  const isOpen = () => opts.isRequestedOpen() && modalManager.isActive(opts.id);

  createEffect(
    on(opts.isRequestedOpen, (requestedOpen, wasOpen) => {
      if (requestedOpen && !wasOpen) {
        opts.onOpen?.();
      }
    }),
  );

  return {
    shouldRender,
    isOpen,
    close: opts.onClose,
  };
}

export const modalManager = createModalManager();
