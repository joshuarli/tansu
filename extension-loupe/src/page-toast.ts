const TOAST_STYLES = `
  .toast {
    align-items: center;
    background: #202124;
    border-radius: 8px;
    box-shadow: 0 4px 16px rgb(0 0 0 / 30%);
    color: #fff;
    display: flex;
    font: 14px system-ui, sans-serif;
    gap: 12px;
    inset-block-end: 24px;
    inset-inline-end: 24px;
    max-inline-size: min(420px, calc(100vw - 48px));
    padding: 10px 14px;
    position: fixed;
  }
  button {
    background: transparent;
    border: 1px solid rgb(255 255 255 / 50%);
    border-radius: 6px;
    color: inherit;
    cursor: pointer;
    font: inherit;
    padding: 4px 10px;
  }
`;

export interface PageToastAction {
  label: string;
  run: () => void;
}

export interface PageToast {
  show(text: string, action?: PageToastAction, durationMs?: number): void;
}

export function createPageToast(): PageToast {
  let host: HTMLDivElement | undefined, dismissTimeout: ReturnType<typeof setTimeout> | undefined;

  const dismiss = (): void => {
    clearTimeout(dismissTimeout);
    host?.remove();
    host = undefined;
  };

  return {
    show(text, action, durationMs = 4_000) {
      dismiss();
      host = document.createElement("div");
      host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
      const shadowRoot = host.attachShadow({ mode: "closed" }),
        style = document.createElement("style"),
        toast = document.createElement("div"),
        message = document.createElement("span");
      style.textContent = TOAST_STYLES;
      toast.className = "toast";
      toast.style.pointerEvents = "auto";
      toast.setAttribute("role", "status");
      message.textContent = text;
      toast.append(message);
      if (action) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = action.label;
        button.addEventListener("click", () => {
          action.run();
          dismiss();
        });
        toast.append(button);
      }
      shadowRoot.append(style, toast);
      document.documentElement.append(host);
      dismissTimeout = setTimeout(dismiss, durationMs);
    },
  };
}
