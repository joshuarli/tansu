/// DOM-rendering wrappers for md-wysiwyg render functions.
/// These own the `el.innerHTML = ...` mutation so callers don't touch innerHTML directly.

import {
  renderMarkdown,
  renderMarkdownWithCursor,
  renderMarkdownWithSelection,
} from "@joshuarli98/md-wysiwyg";

export function setContent(el: HTMLElement, md: string): void {
  el.innerHTML = renderMarkdown(md);
}

export function setContentWithCursor(el: HTMLElement, md: string, offset: number): void {
  el.innerHTML = renderMarkdownWithCursor(md, offset);
}

export function setContentWithSelection(
  el: HTMLElement,
  md: string,
  selStart: number,
  selEnd: number,
): void {
  el.innerHTML = renderMarkdownWithSelection(md, selStart, selEnd);
}

/// Restore the DOM selection from [data-md-sel-start] and [data-md-sel-end] marker spans.
/// After setContentWithSelection re-renders, call this to place the cursor/selection
/// at the markers and then remove them.
export function restoreSelectionFromRenderedMarkers(el: HTMLElement): void {
  const startSpan = el.querySelector("[data-md-sel-start]");
  const endSpan = el.querySelector("[data-md-sel-end]");
  if (!(startSpan instanceof HTMLElement) || !(endSpan instanceof HTMLElement)) {
    return;
  }

  const sel = window.getSelection();
  if (!sel) {
    startSpan.remove();
    endSpan.remove();
    return;
  }

  try {
    const r = document.createRange();
    r.setStartAfter(startSpan);
    r.setEndBefore(endSpan);
    sel.removeAllRanges();
    sel.addRange(r);
  } catch {
    // If the range is invalid (e.g. markers in wrong order), degrade gracefully
  }

  startSpan.remove();
  endSpan.remove();
}
