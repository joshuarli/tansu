/// Hover tooltip and Ctrl/Cmd+click handler for external links in the editor.

const isMac = navigator.platform.startsWith("Mac");
const hint = isMac ? "⌘+click to open" : "Ctrl+click to open";

export function registerLinkHover() {
  const tooltip = document.createElement("div");
  tooltip.className = "link-hover-tooltip";
  tooltip.textContent = hint;
  tooltip.style.display = "none";
  document.body.appendChild(tooltip);

  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  document.addEventListener("mouseover", (e) => {
    const anchor = (e.target as HTMLElement).closest<HTMLAnchorElement>(".editor-content a[href]");
    if (!anchor) return;
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    const rect = anchor.getBoundingClientRect();
    tooltip.style.display = "block";
    tooltip.style.top = `${rect.bottom + window.scrollY + 4}px`;
    tooltip.style.left = `${rect.left + window.scrollX}px`;
  });

  document.addEventListener("mouseout", (e) => {
    if ((e.target as HTMLElement).closest(".editor-content a[href]")) {
      hideTimer = setTimeout(() => {
        tooltip.style.display = "none";
      }, 100);
    }
  });

  document.addEventListener("click", (e) => {
    const anchor = (e.target as HTMLElement).closest<HTMLAnchorElement>(".editor-content a[href]");
    if (!anchor) return;
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      window.open(anchor.getAttribute("href")!, "_blank", "noopener,noreferrer");
    }
  });
}
