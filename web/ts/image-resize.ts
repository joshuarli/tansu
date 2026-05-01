import { getAppSettings } from "./settings.ts";

import styles from "./editor-floating.module.css";

export function initImageResize(editorContent: HTMLElement, onResize: () => void): () => void {
  let hoveredImg: HTMLImageElement | null = null;
  let dragging = false;
  let dragDir = "";
  let dragStartX = 0;
  let dragStartWidth = 0;

  const onWheel = (e: WheelEvent) => {
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
    const newWidth = Math.max(
      getAppSettings().imageResizeMinWidthPx,
      Math.round(currentWidth - e.deltaY * getAppSettings().imageResizeWheelScale),
    );
    img.setAttribute("width", String(newWidth));
    if (hoveredImg === img) {
      positionOverlay(img);
    }
    onResize();
  };

  const overlay = document.createElement("div");
  overlay.className = styles["imageResizeOverlay"]!;
  overlay.dataset["ui"] = "image-resize-overlay";
  for (const dir of ["nw", "ne", "sw", "se"]) {
    const handle = document.createElement("div");
    handle.className = styles["imageResizeHandle"]!;
    handle.dataset["ui"] = "image-resize-handle";
    handle.dataset["dir"] = dir;
    overlay.append(handle);
  }
  document.body.append(overlay);

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
    overlay.dataset["visible"] = "true";
  }

  function maybeHideOverlay() {
    if (!dragging) {
      hoveredImg = null;
      delete overlay.dataset["visible"];
    }
  }

  const onMouseOver = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "IMG" && target.dataset["wikiImage"]) {
      showOverlay(target as HTMLImageElement);
    }
  };

  const onMouseOut = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName !== "IMG" || !target.dataset["wikiImage"]) {
      return;
    }
    const rel = e.relatedTarget as Node | null;
    if (rel && overlay.contains(rel)) {
      return;
    }
    maybeHideOverlay();
  };

  const onOverlayMouseLeave = (e: MouseEvent) => {
    const rel = e.relatedTarget as Node | null;
    if (rel && hoveredImg && (rel === hoveredImg || hoveredImg.contains(rel))) {
      return;
    }
    maybeHideOverlay();
  };

  const onOverlayMouseDown = (e: MouseEvent) => {
    const handle = (e.target as HTMLElement).closest("[data-dir]") as HTMLElement | null;
    if (!handle || !hoveredImg) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    dragDir = handle.dataset["dir"] ?? "se";
    dragStartX = e.clientX;
    dragStartWidth = hoveredImg.getBoundingClientRect().width;
  };

  const onDocumentMouseMove = (e: MouseEvent) => {
    if (!dragging || !hoveredImg) {
      return;
    }
    const dx = e.clientX - dragStartX;
    // west handles: dragging left increases width (negative dx = bigger)
    const sign = dragDir.includes("w") ? -1 : 1;
    const newWidth = Math.max(
      getAppSettings().imageResizeMinWidthPx,
      Math.round(dragStartWidth + sign * dx),
    );
    hoveredImg.setAttribute("width", String(newWidth));
    positionOverlay(hoveredImg);
    onResize();
  };

  const onDocumentMouseUp = () => {
    if (dragging) {
      dragging = false;
    }
  };

  const onDocumentScroll = () => {
    if (hoveredImg) {
      positionOverlay(hoveredImg);
    }
  };

  editorContent.addEventListener("wheel", onWheel, { passive: false });
  editorContent.addEventListener("mouseover", onMouseOver);
  editorContent.addEventListener("mouseout", onMouseOut);
  overlay.addEventListener("mouseleave", onOverlayMouseLeave);
  overlay.addEventListener("mousedown", onOverlayMouseDown);
  document.addEventListener("mousemove", onDocumentMouseMove);
  document.addEventListener("mouseup", onDocumentMouseUp);
  document.addEventListener("scroll", onDocumentScroll, true);

  return () => {
    hoveredImg = null;
    dragging = false;
    editorContent.removeEventListener("wheel", onWheel);
    editorContent.removeEventListener("mouseover", onMouseOver);
    editorContent.removeEventListener("mouseout", onMouseOut);
    overlay.removeEventListener("mouseleave", onOverlayMouseLeave);
    overlay.removeEventListener("mousedown", onOverlayMouseDown);
    document.removeEventListener("mousemove", onDocumentMouseMove);
    document.removeEventListener("mouseup", onDocumentMouseUp);
    document.removeEventListener("scroll", onDocumentScroll, true);
    overlay.remove();
  };
}
