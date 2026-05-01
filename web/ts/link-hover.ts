/// Hover tooltip and Ctrl/Cmd+click handler for external links in the editor.

import styles from "./editor-floating.module.css";

const isMac = navigator.platform.startsWith("Mac");
const hint = isMac ? "⌘+click to open" : "Ctrl+click to open";

export function registerLinkHover(): () => void {
  const tooltip = document.createElement("div");
  tooltip.className = styles["linkHoverTooltip"]!;
  tooltip.dataset["ui"] = "link-hover-tooltip";
  tooltip.textContent = hint;
  tooltip.style.display = "none";
  document.body.append(tooltip);

  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  const onMouseOver = (e: MouseEvent) => {
    const anchor = (e.target as HTMLElement).closest<HTMLAnchorElement>(".editor-content a[href]");
    if (!anchor) {
      return;
    }
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    const rect = anchor.getBoundingClientRect();
    tooltip.style.display = "block";
    tooltip.style.top = `${rect.bottom + window.scrollY + 4}px`;
    tooltip.style.left = `${rect.left + window.scrollX}px`;
  };

  const onMouseOut = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest(".editor-content a[href]")) {
      hideTimer = setTimeout(() => {
        tooltip.style.display = "none";
      }, 100);
    }
  };

  const onClick = (e: MouseEvent) => {
    const anchor = (e.target as HTMLElement).closest<HTMLAnchorElement>(".editor-content a[href]");
    if (!anchor) {
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      window.open(anchor.getAttribute("href")!, "_blank", "noopener,noreferrer");
    }
  };

  document.addEventListener("mouseover", onMouseOver);
  document.addEventListener("mouseout", onMouseOut);
  document.addEventListener("click", onClick);

  return () => {
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
    }
    document.removeEventListener("mouseover", onMouseOver);
    document.removeEventListener("mouseout", onMouseOut);
    document.removeEventListener("click", onClick);
    tooltip.remove();
  };
}
