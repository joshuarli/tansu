import { createSignal } from "solid-js";

import { modalManager, type StackableModalId } from "./modal-manager.ts";

type PromiseModalController<State, Result> = {
  current: () => State | null;
  isOpen: () => boolean;
  open: (state: State) => Promise<Result>;
  closeWithResult: (result: Result) => void;
  cancel: () => void;
};

export function createPromiseModalController<State, Result>(
  id: StackableModalId,
  cancelValue: Result,
): PromiseModalController<State, Result> {
  let pendingResolve: ((value: Result) => void) | null = null;
  const [state, setState] = createSignal<State | null>(null);

  function finish(result: Result, skipManager = false, skipRestoreFocus = false) {
    const resolve = pendingResolve;
    pendingResolve = null;
    setState(null);
    if (!skipManager) {
      modalManager.close(id, { skipDismiss: true, skipRestoreFocus });
    }
    resolve?.(result);
  }

  function cancelFromManager() {
    finish(cancelValue, true);
  }

  function open(nextState: State) {
    if (pendingResolve) {
      finish(cancelValue, false, true);
    }

    return new Promise<Result>((resolve) => {
      pendingResolve = resolve;
      setState(() => nextState);
      modalManager.push(id, cancelFromManager);
    });
  }

  return {
    current: state,
    isOpen: () => state() !== null && modalManager.isActive(id),
    open,
    closeWithResult(result: Result) {
      finish(result);
    },
    cancel() {
      finish(cancelValue);
    },
  };
}
