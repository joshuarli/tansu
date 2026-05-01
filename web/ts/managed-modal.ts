import { createEffect, on, type Accessor } from "solid-js";

import { modalManager, type ModalId } from "./modal-manager.ts";

type ManagedModalOptions = {
  id: ModalId;
  isRequestedOpen: Accessor<boolean>;
  onOpen?: () => void;
  onClose: () => void;
};

export function createManagedModal(opts: Readonly<ManagedModalOptions>) {
  const isOpen = () => opts.isRequestedOpen() && modalManager.isActive(opts.id);

  createEffect(
    on(opts.isRequestedOpen, (requestedOpen, wasOpen) => {
      if (requestedOpen && !wasOpen) {
        opts.onOpen?.();
      }
    }),
  );

  return {
    isOpen,
    close: opts.onClose,
  };
}
