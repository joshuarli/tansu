/// Floating selection format toolbar. Appears above non-collapsed selections
/// within the editor content element. Uses mousedown+preventDefault on buttons
/// to preserve editor focus and selection while applying formats.

import {
  FORMAT_TOOLBAR_EDGE_PADDING_PX,
  FORMAT_TOOLBAR_GAP_PX,
  FORMAT_TOOLBAR_HEADING_LEVELS,
  FORMAT_TOOLBAR_ICON_SIZE_PX,
  FORMAT_TOOLBAR_STROKE_WIDTH,
} from "./constants.ts";
import {
  toggleBold,
  toggleItalic,
  toggleStrikethrough,
  toggleHighlight,
  clearInlineFormats,
  toggleHeading,
  toggleCodeFence,
  type FormatResult,
} from "./format-ops.ts";

type FormatToolbarOptions = {
  contentEl: HTMLElement;
  applyIndent: (dedent: boolean) => void;
  onMutation: () => void;
  applySourceFormat: (transform: (md: string, start: number, end: number) => FormatResult) => void;
};

type FormatButtonsOpts = {
  applyIndent: (dedent: boolean) => void;
  afterInline: () => void;
  afterBlock: () => void;
  // Called after indent/dedent. Mutation is already handled by applyIndent, so this
  // is only needed for side-effects like hiding the floating toolbar.
  afterIndent?: () => void;
  applySourceFormat: (transform: (md: string, start: number, end: number) => FormatResult) => void;
};

export function populateFormatButtons(container: HTMLElement, opts: FormatButtonsOpts): void {
  const { applyIndent, afterInline, afterBlock, applySourceFormat } = opts;
  const afterIndent = opts.afterIndent ?? (() => void 0);
  const size = FORMAT_TOOLBAR_ICON_SIZE_PX;
  const strokeWidth = FORMAT_TOOLBAR_STROKE_WIDTH;

  function btn(innerHTML: string, title: string, action: () => void) {
    const el = document.createElement("button");
    el.className = "format-toolbar-btn";
    el.title = title;
    el.innerHTML = innerHTML;
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      action();
    });
    container.append(el);
  }

  function sep() {
    const el = document.createElement("div");
    el.className = "format-toolbar-sep";
    container.append(el);
  }

  btn("<b>B</b>", "Bold", () => {
    applySourceFormat(toggleBold);
    afterInline();
  });

  btn("<i>I</i>", "Italic", () => {
    applySourceFormat(toggleItalic);
    afterInline();
  });

  btn(`<span class="ftb-strike">S</span>`, "Strikethrough", () => {
    applySourceFormat(toggleStrikethrough);
    afterInline();
  });

  btn(`<span class="ftb-highlight">A</span>`, "Highlight", () => {
    applySourceFormat(toggleHighlight);
    afterInline();
  });

  btn(
    `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3L13 7L6.5 13.5H3V10L9 3Z"/><line x1="6" y1="7" x2="10" y2="11"/><line x1="3" y1="13.5" x2="14" y2="13.5"/></svg>`,
    "Clear formatting",
    () => {
      applySourceFormat(clearInlineFormats);
      afterInline();
    },
  );

  sep();

  for (const level of FORMAT_TOOLBAR_HEADING_LEVELS) {
    btn(`<span class="ftb-heading">H${level}</span>`, `Heading ${level}`, () => {
      applySourceFormat((md, start) => toggleHeading(md, start, level));
      afterBlock();
    });
  }

  sep();

  btn(
    `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round"><line x1="3" y1="4" x2="9" y2="4"/><line x1="3" y1="8" x2="13" y2="8"/><line x1="3" y1="12" x2="11" y2="12"/><polyline points="11,6 13,8 11,10" stroke-linejoin="round"/></svg>`,
    "Indent",
    () => {
      applyIndent(false);
      afterIndent();
    },
  );

  btn(
    `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round"><line x1="3" y1="4" x2="9" y2="4"/><line x1="3" y1="8" x2="13" y2="8"/><line x1="3" y1="12" x2="11" y2="12"/><polyline points="5,6 3,8 5,10" stroke-linejoin="round"/></svg>`,
    "Dedent",
    () => {
      applyIndent(true);
      afterIndent();
    },
  );

  sep();

  btn(
    `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"><polyline points="5,4 1,8 5,12"/><polyline points="11,4 15,8 11,12"/></svg>`,
    "Code block",
    () => {
      applySourceFormat(toggleCodeFence);
      afterBlock();
    },
  );
}

function isImageOnlySelection(sel: Selection): boolean {
  const range = sel.getRangeAt(0);
  const container = range.commonAncestorContainer;
  if (container.nodeType !== Node.ELEMENT_NODE) return false;
  if (range.endOffset - range.startOffset !== 1) return false;
  const node = (container as Element).childNodes[range.startOffset];
  return node?.nodeName === "IMG";
}

export function initFormatToolbar(opts: FormatToolbarOptions): () => void {
  const { contentEl, applyIndent, onMutation, applySourceFormat } = opts;

  const toolbar = document.createElement("div");
  toolbar.className = "format-toolbar";
  document.body.append(toolbar);

  let mouseIsDown = false;

  function updateVisibility() {
    if (mouseIsDown) {
      return;
    }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      hideToolbar();
      return;
    }
    const range = sel.getRangeAt(0);
    if (!contentEl.contains(range.startContainer) || !contentEl.contains(range.endContainer)) {
      hideToolbar();
      return;
    }
    if (isImageOnlySelection(sel)) {
      hideToolbar();
      return;
    }
    showToolbar(range);
  }

  function showToolbar(range: Range) {
    toolbar.style.visibility = "hidden";
    toolbar.style.display = "flex";
    positionToolbar(toolbar, range);
    toolbar.style.visibility = "visible";
  }

  function hideToolbar() {
    toolbar.style.display = "none";
  }

  populateFormatButtons(toolbar, {
    applyIndent,
    applySourceFormat,
    afterInline: () => {
      onMutation();
      requestAnimationFrame(updateVisibility);
    },
    afterBlock: () => {
      onMutation();
      hideToolbar();
    },
    afterIndent: hideToolbar,
  });

  const onSelectionChange = () => {
    if (!mouseIsDown) {
      requestAnimationFrame(updateVisibility);
    }
  };

  const onMouseDown = (e: MouseEvent) => {
    if (!toolbar.contains(e.target as Node)) {
      mouseIsDown = true;
    }
  };

  const onMouseUp = () => {
    mouseIsDown = false;
    requestAnimationFrame(updateVisibility);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      hideToolbar();
    }
  };

  document.addEventListener("selectionchange", onSelectionChange);
  document.addEventListener("mousedown", onMouseDown);
  document.addEventListener("mouseup", onMouseUp);
  document.addEventListener("keydown", onKeyDown);

  return () => {
    document.removeEventListener("selectionchange", onSelectionChange);
    document.removeEventListener("mousedown", onMouseDown);
    document.removeEventListener("mouseup", onMouseUp);
    document.removeEventListener("keydown", onKeyDown);
    toolbar.remove();
  };
}

function positionToolbar(toolbar: HTMLElement, range: Range) {
  // Prefer positioning above the caret's focus point (where the cursor landed after selection)
  // rather than centering over the entire selection rect.
  let refRect: DOMRect | null = null;
  const sel = window.getSelection();
  if (sel && sel.focusNode) {
    try {
      const r = document.createRange();
      r.setStart(sel.focusNode, sel.focusOffset);
      r.collapse(true);
      const rect = r.getBoundingClientRect();
      if (rect.height > 0) {
        refRect = rect;
      }
    } catch {
      // focusNode may be in an edge-case state
    }
  }
  if (!refRect) {
    refRect = range.getBoundingClientRect();
  }

  const tbRect = toolbar.getBoundingClientRect();
  const GAP = FORMAT_TOOLBAR_GAP_PX;

  let top = refRect.top - tbRect.height - GAP;
  if (top < FORMAT_TOOLBAR_EDGE_PADDING_PX) {
    top = refRect.bottom + GAP;
  }

  let left = refRect.left - tbRect.width / 2;
  left = Math.max(
    FORMAT_TOOLBAR_EDGE_PADDING_PX,
    Math.min(left, window.innerWidth - tbRect.width - FORMAT_TOOLBAR_EDGE_PADDING_PX),
  );

  toolbar.style.top = `${top}px`;
  toolbar.style.left = `${left}px`;
}
