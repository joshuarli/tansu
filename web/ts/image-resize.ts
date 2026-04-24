let resizeCallback: (() => void) | null = null;

export function initImageResize(editorContent: HTMLElement, onResize: () => void) {
  resizeCallback = onResize;

  editorContent.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) {
        return;
      }
      const target = e.target as HTMLElement;
      if (target.tagName !== "IMG" || !target.dataset["wikiImage"]) {
        return;
      }
      e.preventDefault();

      const img = target as HTMLImageElement;
      const currentWidth = img.getBoundingClientRect().width;
      const newWidth = Math.max(50, Math.round(currentWidth - e.deltaY * 1.5));
      img.setAttribute("width", String(newWidth));
      if (hoveredImg === img) positionOverlay(img);
      resizeCallback?.();
    },
    { passive: false },
  );

  const overlay = document.createElement("div");
  overlay.className = "img-resize-overlay";
  for (const dir of ["nw", "ne", "sw", "se"]) {
    const handle = document.createElement("div");
    handle.className = `img-resize-handle img-resize-${dir}`;
    handle.dataset["dir"] = dir;
    overlay.append(handle);
  }
  document.body.append(overlay);

  let hoveredImg: HTMLImageElement | null = null;
  let dragging = false;
  let dragDir = "";
  let dragStartX = 0;
  let dragStartWidth = 0;

  function positionOverlay(img: HTMLImageElement) {
    const rect = img.getBoundingClientRect();
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
  }

  function showOverlay(img: HTMLImageElement) {
    hoveredImg = img;
    positionOverlay(img);
    overlay.classList.add("visible");
  }

  function maybeHideOverlay() {
    if (!dragging) {
      hoveredImg = null;
      overlay.classList.remove("visible");
    }
  }

  editorContent.addEventListener("mouseover", (e) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "IMG" && target.dataset["wikiImage"]) {
      showOverlay(target as HTMLImageElement);
    }
  });

  editorContent.addEventListener("mouseout", (e) => {
    const target = e.target as HTMLElement;
    if (target.tagName !== "IMG" || !target.dataset["wikiImage"]) return;
    const rel = e.relatedTarget as Node | null;
    if (rel && overlay.contains(rel)) return;
    maybeHideOverlay();
  });

  overlay.addEventListener("mouseleave", (e) => {
    const rel = e.relatedTarget as Node | null;
    if (rel && hoveredImg && (rel === hoveredImg || hoveredImg.contains(rel as Node))) return;
    maybeHideOverlay();
  });

  overlay.addEventListener("mousedown", (e) => {
    const handle = (e.target as HTMLElement).closest("[data-dir]") as HTMLElement | null;
    if (!handle || !hoveredImg) return;
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    dragDir = handle.dataset["dir"] ?? "se";
    dragStartX = e.clientX;
    dragStartWidth = hoveredImg.getBoundingClientRect().width;
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging || !hoveredImg) return;
    const dx = e.clientX - dragStartX;
    // west handles: dragging left increases width (negative dx = bigger)
    const sign = dragDir.includes("w") ? -1 : 1;
    const newWidth = Math.max(50, Math.round(dragStartWidth + sign * dx));
    hoveredImg.setAttribute("width", String(newWidth));
    positionOverlay(hoveredImg);
    resizeCallback?.();
  });

  document.addEventListener("mouseup", () => {
    if (dragging) {
      dragging = false;
    }
  });

  // Reposition on scroll (e.g. long page)
  document.addEventListener(
    "scroll",
    () => {
      if (hoveredImg) positionOverlay(hoveredImg);
    },
    true,
  );
}
