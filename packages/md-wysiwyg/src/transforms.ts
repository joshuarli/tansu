/// Block-level markdown transforms for the WYSIWYG editor.
/// Handles input like "## " → H2, "- " → UL, "```" → code block, etc.
///
/// All DOM replacements go through document.execCommand("insertHTML") so they
/// participate in the browser's native undo stack, matching the approach used
/// by inline-transforms.ts. A direct-DOM fallback handles test environments
/// where execCommand is not implemented.

import { escapeHtml } from "./util.js";

type TransformFn = (block: HTMLElement, text: string) => boolean;

// contentEditable inserts   (nbsp) instead of regular spaces in many cases
const SP = "[ \\u00A0]";

// Attribute placed on the element where the cursor should land after transform.
// Removed immediately after the element is located.
const CURSOR_ATTR = "data-block-cursor";

// Space-triggered: fire on input when user completes a block-start pattern
const inputTransforms: [RegExp, TransformFn][] = [
  [
    new RegExp(`^#{1,6}${SP}$`),
    (block, text) => {
      const level = text.trimEnd().length;
      const el = replaceBlock(block, `<h${level} ${CURSOR_ATTR}="1"><br></h${level}>`);
      if (!el) return false;
      setCursorStart(el);
      return true;
    },
  ],

  [
    new RegExp(`^[-*]${SP}$`),
    (block) => {
      const el = replaceBlock(block, `<ul><li ${CURSOR_ATTR}="1"><br></li></ul>`);
      if (!el) return false;
      setCursorStart(el);
      return true;
    },
  ],

  [
    new RegExp(`^\\d+\\.${SP}$`),
    (block) => {
      const el = replaceBlock(block, `<ol><li ${CURSOR_ATTR}="1"><br></li></ol>`);
      if (!el) return false;
      setCursorStart(el);
      return true;
    },
  ],

  [
    new RegExp(`^>${SP}$`),
    (block) => {
      const el = replaceBlock(block, `<blockquote><p ${CURSOR_ATTR}="1"><br></p></blockquote>`);
      if (!el) return false;
      setCursorStart(el);
      return true;
    },
  ],

  [
    new RegExp(`^\`{3}\\S*${SP}$`),
    (block, text) => {
      const lang = text.slice(3).replace(/[  ]+$/, "");
      const cls = lang ? ` class="language-${lang}"` : "";
      const el = replaceBlock(block, `<pre><code${cls} ${CURSOR_ATTR}="1">\n</code></pre>`);
      if (!el) return false;
      setCursorStart(el);
      return true;
    },
  ],
];

// Enter-triggered: fire when user presses Enter with content already typed
const transforms: [RegExp, TransformFn][] = [
  [
    /^(#{1,6})\s(.*)$/,
    (block, text) => {
      const match = text.match(/^(#{1,6})\s(.*)$/);
      if (!match) return false;
      const level = match[1]!.length;
      const el = replaceBlock(
        block,
        `<h${level}>${escapeHtml(match[2] ?? "")}</h${level}><p ${CURSOR_ATTR}="1"><br></p>`,
      );
      if (!el) return false;
      setCursorStart(el);
      return true;
    },
  ],

  [
    /^---$/,
    (block) => {
      const el = replaceBlock(block, `<hr><p ${CURSOR_ATTR}="1"><br></p>`);
      if (!el) return false;
      setCursorStart(el);
      return true;
    },
  ],

  [
    /^```/,
    (block, text) => {
      const lang = text.slice(3).trim();
      const cls = lang ? ` class="language-${lang}"` : "";
      const el = replaceBlock(
        block,
        `<pre><code${cls} ${CURSOR_ATTR}="1">\n</code></pre><p><br></p>`,
      );
      if (!el) return false;
      setCursorStart(el);
      return true;
    },
  ],

  [
    /^[-*]\s(.*)$/,
    (block, text) => {
      const match = text.match(/^[-*]\s(.*)$/);
      if (!match) return false;
      const el = replaceBlock(
        block,
        `<ul><li ${CURSOR_ATTR}="1">${escapeHtml(match[1] ?? "")}</li></ul>`,
      );
      if (!el) return false;
      setCursorStart(el);
      return true;
    },
  ],

  [
    /^\d+\.\s(.*)$/,
    (block, text) => {
      const match = text.match(/^\d+\.\s(.*)$/);
      if (!match) return false;
      const el = replaceBlock(
        block,
        `<ol><li ${CURSOR_ATTR}="1">${escapeHtml(match[1] ?? "")}</li></ol>`,
      );
      if (!el) return false;
      setCursorStart(el);
      return true;
    },
  ],

  [
    /^>\s(.*)$/,
    (block, text) => {
      const match = text.match(/^>\s(.*)$/);
      if (!match) return false;
      const el = replaceBlock(
        block,
        `<blockquote><p ${CURSOR_ATTR}="1">${escapeHtml(match[1] ?? "")}</p></blockquote>`,
      );
      if (!el) return false;
      setCursorStart(el);
      return true;
    },
  ],
];

/// Replace a block element with parsed HTML via execCommand so the operation
/// enters the browser's undo stack. Falls back to direct DOM swap in
/// environments (e.g. tests) where execCommand is not implemented.
/// Returns the element carrying CURSOR_ATTR (with the attribute removed).
function replaceBlock(block: HTMLElement, html: string): HTMLElement | null {
  if (typeof document.execCommand === "function") {
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.setStartBefore(block);
      range.setEndAfter(block);
      sel.removeAllRanges();
      sel.addRange(range);
      if (document.execCommand("insertHTML", false, html)) {
        const marker = document.querySelector(`[${CURSOR_ATTR}]`);
        if (marker instanceof HTMLElement) marker.removeAttribute(CURSOR_ATTR);
        return marker instanceof HTMLElement ? marker : null;
      }
    }
  }
  // Fallback: direct DOM swap for environments without execCommand
  const wrap = document.createElement("div");
  wrap.innerHTML = html;
  const marker = wrap.querySelector(`[${CURSOR_ATTR}]`);
  block.replaceWith(...Array.from(wrap.childNodes));
  if (marker instanceof HTMLElement) marker.removeAttribute(CURSOR_ATTR);
  return marker instanceof HTMLElement ? marker : null;
}

/// Check if the user just completed a block-start pattern (e.g. "## ", "- ").
/// Only transforms plain P/DIV blocks — won't re-transform existing headings/lists.
export function checkBlockInputTransform(contentEl: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;

  const anchor = sel.anchorNode;
  if (!anchor) return false;

  let block = findBlock(anchor, contentEl);

  // Browser may leave text nodes directly inside contentEl without a <p> wrapper
  if (!block && anchor.parentNode === contentEl) {
    const p = document.createElement("p");
    anchor.parentNode.insertBefore(p, anchor);
    p.appendChild(anchor);
    // Restore cursor inside the new wrapper
    const range = document.createRange();
    range.setStart(anchor, clampNodeOffset(anchor, sel.anchorOffset));
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    block = p;
  }

  if (!block) return false;

  const tag = block.tagName;

  // Re-level existing headings: "### " typed at start of an H1 → converts to H3
  if (tag.startsWith("H") && tag.length === 2) {
    const text = block.textContent ?? "";
    const re = new RegExp(`^#{1,6}${SP}`);
    const match = text.match(re);
    if (match) {
      const level = match[0].trimEnd().length;
      const rest = text.slice(match[0].length);
      const inner = rest ? escapeHtml(rest) : "<br>";
      const el = replaceBlock(block, `<h${level} ${CURSOR_ATTR}="1">${inner}</h${level}>`);
      if (!el) return false;
      setCursorStart(el);
      return true;
    }
    return false;
  }

  if (tag !== "P" && tag !== "DIV") return false;

  const text = block.textContent ?? "";

  for (const [pattern, handler] of inputTransforms) {
    if (pattern.test(text) && handler(block, text)) {
      return true;
    }
  }
  return false;
}

export function handleBlockTransform(
  e: KeyboardEvent,
  contentEl: HTMLElement,
  onDirty?: () => void,
) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;

  const block = findBlock(sel.anchorNode, contentEl);
  if (!block) return;

  const text = block.textContent ?? "";

  for (const [pattern, handler] of transforms) {
    if (pattern.test(text) && handler(block, text)) {
      e.preventDefault();
      onDirty?.();
      return;
    }
  }
}

function findBlock(node: Node | null, contentEl: HTMLElement): HTMLElement | null {
  let current: Node | null = node;
  while (current && current !== contentEl) {
    if (current.nodeType === Node.ELEMENT_NODE) {
      const tag = (current as HTMLElement).tagName;
      if (
        tag === "P" ||
        tag === "DIV" ||
        tag.startsWith("H") ||
        tag === "LI" ||
        tag === "BLOCKQUOTE" ||
        tag === "PRE"
      ) {
        return current as HTMLElement;
      }
    }
    current = current.parentNode;
  }
  return null;
}

function setCursorStart(el: Node) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.setStart(el, 0);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function clampNodeOffset(node: Node, offset: number): number {
  if (offset < 0) return 0;
  if (node.nodeType === Node.TEXT_NODE) {
    return Math.min(offset, node.textContent?.length ?? 0);
  }
  return Math.min(offset, node.childNodes.length);
}
