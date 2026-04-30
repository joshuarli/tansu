import { createEffect, type Accessor } from "solid-js";

import { createFocusRestorer } from "./overlay.tsx";

type OverlayLifecycleOptions = {
  isOpen: Accessor<boolean>;
  onOpen: () => void;
  onClose: () => void;
};

export function createOverlayLifecycle(opts: Readonly<OverlayLifecycleOptions>) {
  const focus = createFocusRestorer();

  function close() {
    opts.onClose();
    focus.restore();
  }

  createEffect(() => {
    if (opts.isOpen()) {
      focus.remember();
      opts.onOpen();
    }
  });

  return {
    close,
  };
}
