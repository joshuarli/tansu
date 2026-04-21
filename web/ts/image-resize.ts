let resizeCallback: (() => void) | null = null;

export function initImageResize(editorContent: HTMLElement, onResize: () => void) {
  resizeCallback = onResize;

  editorContent.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      const target = e.target as HTMLElement;
      if (target.tagName !== "IMG" || !target.getAttribute("data-wiki-image")) return;
      e.preventDefault();

      const img = target as HTMLImageElement;
      const currentWidth = img.getBoundingClientRect().width;
      const newWidth = Math.max(50, Math.round(currentWidth - e.deltaY * 1.5));
      img.setAttribute("width", String(newWidth));
      resizeCallback?.();
    },
    { passive: false },
  );
}
