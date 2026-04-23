/// Floating selection format toolbar. Appears above non-collapsed selections
/// within the editor content element. Uses mousedown+preventDefault on buttons
/// to preserve editor focus and selection while applying formats.

import { dispatchEditorAction } from "./editor-events.ts";

export interface FormatToolbarOptions {
  contentEl: HTMLElement;
  applyIndent: (dedent: boolean) => void;
  onMutation: () => void;
}

export function initFormatToolbar(opts: FormatToolbarOptions): () => void {
  const { contentEl, applyIndent, onMutation } = opts;

  const toolbar = document.createElement("div");
  toolbar.className = "format-toolbar";
  document.body.appendChild(toolbar);

  let mouseIsDown = false;

  function updateVisibility() {
    if (mouseIsDown) return;
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

  function btn(innerHTML: string, title: string, action: () => void) {
    const el = document.createElement("button");
    el.className = "format-toolbar-btn";
    el.title = title;
    el.innerHTML = innerHTML;
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      action();
    });
    toolbar.appendChild(el);
  }

  function sep() {
    const el = document.createElement("div");
    el.className = "format-toolbar-sep";
    toolbar.appendChild(el);
  }

  function afterInline() {
    onMutation();
    requestAnimationFrame(updateVisibility);
  }

  function afterBlock() {
    onMutation();
    hideToolbar();
  }

  btn("<b>B</b>", "Bold", () => {
    document.execCommand("bold");
    dispatchEditorAction({ type: "format", kind: "bold" });
    afterInline();
  });

  btn("<i>I</i>", "Italic", () => {
    document.execCommand("italic");
    dispatchEditorAction({ type: "format", kind: "italic" });
    afterInline();
  });

  btn(`<span class="ftb-strike">S</span>`, "Strikethrough", () => {
    toggleInlineWrap(contentEl, "del");
    dispatchEditorAction({ type: "format", kind: "strikethrough" });
    afterInline();
  });

  btn(`<span class="ftb-highlight">A</span>`, "Highlight", () => {
    toggleInlineWrap(contentEl, "mark");
    dispatchEditorAction({ type: "format", kind: "highlight" });
    afterInline();
  });

  sep();

  for (const level of [1, 2, 3, 4] as const) {
    btn(`<span class="ftb-heading">H${level}</span>`, `Heading ${level}`, () => {
      applyBlockFormat(contentEl, `h${level}`);
      dispatchEditorAction({ type: "format", kind: "heading", detail: `h${level}` });
      afterBlock();
    });
  }

  sep();

  btn(
    `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><line x1="3" y1="4" x2="9" y2="4"/><line x1="3" y1="8" x2="13" y2="8"/><line x1="3" y1="12" x2="11" y2="12"/><polyline points="11,6 13,8 11,10" stroke-linejoin="round"/></svg>`,
    "Indent",
    () => {
      applyIndent(false);
      dispatchEditorAction({ type: "indent", direction: "in" });
      hideToolbar();
    },
  );

  btn(
    `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><line x1="3" y1="4" x2="9" y2="4"/><line x1="3" y1="8" x2="13" y2="8"/><line x1="3" y1="12" x2="11" y2="12"/><polyline points="5,6 3,8 5,10" stroke-linejoin="round"/></svg>`,
    "Dedent",
    () => {
      applyIndent(true);
      dispatchEditorAction({ type: "indent", direction: "out" });
      hideToolbar();
    },
  );

  sep();

  btn(
    `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="5,4 1,8 5,12"/><polyline points="11,4 15,8 11,12"/></svg>`,
    "Code block",
    () => {
      applyCodeBlock(contentEl);
      dispatchEditorAction({ type: "format", kind: "code-block" });
      afterBlock();
    },
  );

  const onSelectionChange = () => {
    if (!mouseIsDown) requestAnimationFrame(updateVisibility);
  };

  const onMouseDown = (e: MouseEvent) => {
    if (!toolbar.contains(e.target as Node)) mouseIsDown = true;
  };

  const onMouseUp = () => {
    mouseIsDown = false;
    requestAnimationFrame(updateVisibility);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") hideToolbar();
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
  const selRect = range.getBoundingClientRect();
  const tbRect = toolbar.getBoundingClientRect();
  const GAP = 8;

  let top = selRect.top - tbRect.height - GAP;
  if (top < 8) top = selRect.bottom + GAP;

  let left = selRect.left + selRect.width / 2 - tbRect.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tbRect.width - 8));

  toolbar.style.top = `${top}px`;
  toolbar.style.left = `${left}px`;
}

// Toggle an inline format (e.g. del, mark) on the selection.
// If the selection is already inside a matching element, removes it; otherwise wraps it.
// Uses execCommand('insertHTML') so the operation joins the browser undo stack.
function toggleInlineWrap(contentEl: HTMLElement, tag: string): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  if (!contentEl.contains(range.startContainer) || !contentEl.contains(range.endContainer)) return;

  // Walk up from commonAncestor to find an enclosing wrapper of the same tag
  let ancestor: Node | null = range.commonAncestorContainer;
  if (ancestor.nodeType === Node.TEXT_NODE) ancestor = ancestor.parentNode;
  let wrapper: HTMLElement | null = null;
  while (ancestor && ancestor !== contentEl) {
    if (ancestor instanceof HTMLElement && ancestor.tagName.toLowerCase() === tag) {
      wrapper = ancestor;
      break;
    }
    ancestor = ancestor.parentNode;
  }

  const uid = Math.random().toString(36).slice(2);

  if (wrapper) {
    // Unwrap: select the entire wrapper element, replace it with its inner content
    // wrapped in a sentinel span so we can restore selection afterward.
    const innerHtml = wrapper.innerHTML;
    const wrapperRange = document.createRange();
    wrapperRange.selectNode(wrapper);
    sel.removeAllRanges();
    sel.addRange(wrapperRange);
    document.execCommand("insertHTML", false, `<span data-ftb="${uid}">${innerHtml}</span>`);

    const sentinel = contentEl.querySelector(`[data-ftb="${uid}"]`);
    if (sentinel) {
      const start = document.createElement("span");
      const end = document.createElement("span");
      sentinel.insertBefore(start, sentinel.firstChild);
      sentinel.appendChild(end);

      const parent = sentinel.parentNode!;
      while (sentinel.firstChild) parent.insertBefore(sentinel.firstChild, sentinel);
      sentinel.remove();

      const r = document.createRange();
      r.setStartAfter(start);
      r.setEndBefore(end);
      sel.removeAllRanges();
      sel.addRange(r);
      start.remove();
      end.remove();
    }
    return;
  }

  // Wrap: clone selection HTML, replace selection with wrapped version via execCommand
  const div = document.createElement("div");
  div.appendChild(range.cloneContents());
  document.execCommand("insertHTML", false, `<${tag} data-ftb="${uid}">${div.innerHTML}</${tag}>`);

  const newEl = contentEl.querySelector(`[data-ftb="${uid}"]`);
  if (newEl) {
    newEl.removeAttribute("data-ftb");
    const r = document.createRange();
    r.selectNodeContents(newEl);
    sel.removeAllRanges();
    sel.addRange(r);
  }
}

function getDirectChild(contentEl: HTMLElement, node: Node): HTMLElement | null {
  let cur: Node | null = node;
  while (cur && cur.parentNode !== contentEl) cur = cur.parentNode;
  return cur instanceof HTMLElement ? cur : null;
}

// Convert the current block to a heading (or back to p if already that level).
// Uses execCommand('formatBlock') so the operation joins the browser undo stack.
function applyBlockFormat(contentEl: HTMLElement, tag: string) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);

  const block = getDirectChild(contentEl, range.startContainer);
  if (!block) return;

  const currentTag = block.tagName.toLowerCase();
  if (!/^(p|div|h[1-6])$/.test(currentTag)) return;

  const targetTag = currentTag === tag ? "p" : tag;
  document.execCommand("formatBlock", false, targetTag);
}

// Convert the current block to a code block (pre), or back to p if already pre.
// Uses execCommand('formatBlock') so the operation joins the browser undo stack.
function applyCodeBlock(contentEl: HTMLElement) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);

  const block = getDirectChild(contentEl, range.startContainer);
  if (!block) return;

  const currentTag = block.tagName.toLowerCase();
  if (!/^(p|div|h[1-6]|pre)$/.test(currentTag)) return;

  const targetTag = currentTag === "pre" ? "p" : "pre";
  document.execCommand("formatBlock", false, targetTag);
}
