/// Block-level markdown transforms for the WYSIWYG editor.
/// Handles input like "## " → H2, "- " → UL, "```" → code block, etc.
///
/// All DOM replacements go through document.execCommand("insertHTML") so they
/// participate in the browser's native undo stack, matching the approach used
/// by inline-transforms.ts. A direct-DOM fallback handles test environments
/// where execCommand is not implemented.

import { CODE_FENCE_MARKER_LENGTH, MAX_HEADING_LEVEL } from "./constants.js";
import { clampNodeOffset, escapeHtml, isBlockTag } from "./util.js";

type TransformFn = (block: HTMLElement, text: string, contentEl: HTMLElement) => boolean;

// contentEditable inserts   (nbsp) instead of regular spaces in many cases
const SP = String.raw`[  ]`;

// Attribute placed on the element where the cursor should land after transform.
// Removed immediately after the element is located.
const CURSOR_ATTR = "data-block-cursor";

// Space-triggered: fire on input when user completes a block-start pattern
const inputTransforms: [RegExp, TransformFn][] = [
  [
    new RegExp(`^\\[([ xX])\\]${SP}$`),
    (block, text, contentEl) => {
      const match = text.match(new RegExp(`^\\[([ xX])\\]${SP}$`));
      if (!match) {
        return false;
      }
      const checked = match[1] !== " ";
      return replaceBlock(
        block,
        `<ul class="task-list"><li class="task-item"><input type="checkbox"${
          checked ? " checked" : ""
        }>&nbsp;<span ${CURSOR_ATTR}="1"></span></li></ul>`,
        contentEl,
      );
    },
  ],

  [
    new RegExp(`^#{1,${MAX_HEADING_LEVEL}}${SP}$`),
    (block, text, contentEl) => {
      const level = text.trimEnd().length;
      return replaceBlock(block, `<h${level} ${CURSOR_ATTR}="1"><br></h${level}>`, contentEl);
    },
  ],

  [
    new RegExp(`^[-*]${SP}$`),
    (block, _text, contentEl) =>
      replaceBlock(block, `<ul><li ${CURSOR_ATTR}="1"><br></li></ul>`, contentEl),
  ],

  [
    new RegExp(`^\\d+\\.${SP}$`),
    (block, _text, contentEl) =>
      replaceBlock(block, `<ol><li ${CURSOR_ATTR}="1"><br></li></ol>`, contentEl),
  ],

  [
    new RegExp(`^>${SP}$`),
    (block, _text, contentEl) =>
      replaceBlock(block, `<blockquote><p ${CURSOR_ATTR}="1"><br></p></blockquote>`, contentEl),
  ],

  [
    new RegExp(`^${"`".repeat(CODE_FENCE_MARKER_LENGTH)}\\S*${SP}$`),
    (block, text, contentEl) => {
      const lang = text.slice(CODE_FENCE_MARKER_LENGTH).replace(/[  ]+$/, "");
      const cls = lang ? ` class="language-${lang}"` : "";
      return replaceBlock(block, `<pre><code${cls} ${CURSOR_ATTR}="1">\n</code></pre>`, contentEl);
    },
  ],
];

// Enter-triggered: fire when user presses Enter with content already typed
const transforms: [RegExp, TransformFn][] = [
  [
    new RegExp(`^(#{1,${MAX_HEADING_LEVEL}})\\s(.*)$`),
    (block, text, contentEl) => {
      const match = text.match(new RegExp(`^(#{1,${MAX_HEADING_LEVEL}})\\s(.*)$`));
      if (!match) {
        return false;
      }
      const level = match[1]!.length;
      return replaceBlock(
        block,
        `<h${level}>${escapeHtml(match[2] ?? "")}</h${level}><p ${CURSOR_ATTR}="1"><br></p>`,
        contentEl,
      );
    },
  ],

  [
    /^---$/,
    (block, _text, contentEl) =>
      replaceBlock(block, `<hr><p ${CURSOR_ATTR}="1"><br></p>`, contentEl),
  ],

  [
    new RegExp(`^${"`".repeat(CODE_FENCE_MARKER_LENGTH)}`),
    (block, text, contentEl) => {
      const lang = text.slice(CODE_FENCE_MARKER_LENGTH).trim();
      const cls = lang ? ` class="language-${lang}"` : "";
      return replaceBlock(
        block,
        `<pre><code${cls} ${CURSOR_ATTR}="1">\n</code></pre><p><br></p>`,
        contentEl,
      );
    },
  ],

  [
    /^[-*]\s(.*)$/,
    (block, text, contentEl) => {
      const match = text.match(/^[-*]\s(.*)$/);
      if (!match) {
        return false;
      }
      return replaceBlock(
        block,
        `<ul><li ${CURSOR_ATTR}="1">${escapeHtml(match[1] ?? "")}</li></ul>`,
        contentEl,
      );
    },
  ],

  [
    /^\d+\.\s(.*)$/,
    (block, text, contentEl) => {
      const match = text.match(/^\d+\.\s(.*)$/);
      if (!match) {
        return false;
      }
      return replaceBlock(
        block,
        `<ol><li ${CURSOR_ATTR}="1">${escapeHtml(match[1] ?? "")}</li></ol>`,
        contentEl,
      );
    },
  ],

  [
    /^>\s(.*)$/,
    (block, text, contentEl) => {
      const match = text.match(/^>\s(.*)$/);
      if (!match) {
        return false;
      }
      return replaceBlock(
        block,
        `<blockquote><p ${CURSOR_ATTR}="1">${escapeHtml(match[1] ?? "")}</p></blockquote>`,
        contentEl,
      );
    },
  ],
];

/// Replace a block element with parsed HTML via execCommand so the operation
/// enters the browser's undo stack. Falls back to direct DOM swap in
/// environments (e.g. tests) where execCommand is not implemented.
/// Moves the cursor to the element carrying CURSOR_ATTR and returns true on
/// success.
function replaceBlock(block: HTMLElement, html: string, contentEl: HTMLElement): boolean {
  let marker: HTMLElement | null = null;
  if (typeof document.execCommand === "function") {
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.setStartBefore(block);
      range.setEndAfter(block);
      sel.removeAllRanges();
      sel.addRange(range);
      if (document.execCommand("insertHTML", false, html)) {
        // incremental edit; bypasses renderer intentionally for undo stack
        const found = contentEl.querySelector(`[${CURSOR_ATTR}]`);
        marker = found instanceof HTMLElement ? found : null;
      }
    }
  } else {
    // Fallback: direct DOM swap for environments without execCommand
    const wrap = document.createElement("div");
    wrap.innerHTML = html;
    const found = wrap.querySelector(`[${CURSOR_ATTR}]`);
    block.replaceWith(...wrap.childNodes);
    marker = found instanceof HTMLElement ? found : null;
  }
  if (marker) {
    marker.removeAttribute(CURSOR_ATTR);
    setCursorStart(marker);
    return true;
  }
  return false;
}

/// Check if the user just completed a block-start pattern (e.g. "## ", "- ").
/// Only transforms plain P/DIV blocks — won't re-transform existing headings/lists.
export function checkBlockInputTransform(contentEl: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) {
    return false;
  }

  const anchor = sel.anchorNode;
  if (!anchor) {
    return false;
  }

  let block = findBlock(anchor, contentEl);

  // Browser may leave text nodes directly inside contentEl without a <p> wrapper
  if (!block && anchor.parentNode === contentEl) {
    const p = document.createElement("p");
    anchor.parentNode.insertBefore(p, anchor);
    p.append(anchor);
    // Restore cursor inside the new wrapper
    const range = document.createRange();
    range.setStart(anchor, clampNodeOffset(anchor, sel.anchorOffset));
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    block = p;
  }

  if (!block) {
    return false;
  }

  const tag = block.tagName;

  // Re-level existing headings: "### " typed at start of an H1 → converts to H3
  if (tag.startsWith("H") && tag.length === 2) {
    const text = block.textContent ?? "";
    const re = new RegExp(`^#{1,${MAX_HEADING_LEVEL}}${SP}`);
    const match = text.match(re);
    if (match) {
      const level = match[0].trimEnd().length;
      const rest = text.slice(match[0].length);
      const inner = rest ? escapeHtml(rest) : "<br>";
      return replaceBlock(block, `<h${level} ${CURSOR_ATTR}="1">${inner}</h${level}>`, contentEl);
    }
    return false;
  }

  if (tag !== "P" && tag !== "DIV") {
    return false;
  }

  const text = block.textContent ?? "";

  for (const [pattern, handler] of inputTransforms) {
    if (pattern.test(text) && handler(block, text, contentEl)) {
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
  if (!sel || sel.rangeCount === 0) {
    return;
  }

  const block = findBlock(sel.anchorNode, contentEl);
  if (!block) {
    return;
  }

  if (isTaskItemBlock(block)) {
    if (continueTaskItem(block)) {
      e.preventDefault();
      onDirty?.();
    }
    return;
  }

  const text = block.textContent ?? "";

  for (const [pattern, handler] of transforms) {
    if (pattern.test(text) && handler(block, text, contentEl)) {
      e.preventDefault();
      onDirty?.();
      return;
    }
  }
}

function isTaskItemBlock(block: HTMLElement): boolean {
  if (block.tagName !== "LI") {
    return false;
  }
  if (block.classList.contains("task-item")) {
    return true;
  }
  return block.querySelector('input[type="checkbox"]') instanceof HTMLInputElement;
}

function continueTaskItem(block: HTMLElement): boolean {
  const parent = block.parentElement;
  if (!parent || parent.tagName !== "UL") {
    return false;
  }

  const next = document.createElement("li");
  next.className = "task-item";
  next.innerHTML = `<input type="checkbox">&nbsp;<span ${CURSOR_ATTR}="1"></span>`;
  block.after(next);

  const marker = next.querySelector(`[${CURSOR_ATTR}]`);
  if (marker instanceof HTMLElement) {
    marker.removeAttribute(CURSOR_ATTR);
    setCursorStart(marker);
  }
  return true;
}

function findBlock(node: Node | null, contentEl: HTMLElement): HTMLElement | null {
  let current: Node | null = node;
  while (current && current !== contentEl) {
    if (current.nodeType === Node.ELEMENT_NODE && isBlockTag((current as HTMLElement).tagName)) {
      return current as HTMLElement;
    }
    current = current.parentNode;
  }
  return null;
}

function setCursorStart(el: Node) {
  const sel = window.getSelection();
  if (!sel) {
    return;
  }
  const range = document.createRange();
  range.setStart(el, 0);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}
