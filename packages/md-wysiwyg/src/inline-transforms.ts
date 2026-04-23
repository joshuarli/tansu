/// Inline markdown → DOM transforms for live WYSIWYG editing.
/// Detects completed patterns like **bold** at the cursor and replaces
/// with styled elements. Uses execCommand('insertHTML') so transforms
/// participate in the browser's undo stack.

import { escapeHtml } from "./util.js";

interface InlinePattern {
  open: string;
  close: string;
  tag: string;
  trailingSpace?: boolean; // require space/nbsp after close to trigger
}

// Longer markers first — ** must be checked before *
export { type InlinePattern };
export const patterns: InlinePattern[] = [
  { open: "**", close: "**", tag: "strong" },
  { open: "~~", close: "~~", tag: "del" },
  { open: "==", close: "==", tag: "mark" },
  { open: "`", close: "`", tag: "code", trailingSpace: true },
  { open: "*", close: "*", tag: "em" },
];

const MAX_SEARCH = 200;

/// Compute the range [start, end) of text to replace for a matched pattern.
export function computeReplaceRange(
  pat: InlinePattern,
  matchStart: number,
  cursorPos: number,
): { start: number; end: number } {
  return { start: matchStart, end: pat.trailingSpace ? cursorPos - 1 : cursorPos };
}

/// Build the HTML to insert for a matched inline pattern.
export function buildReplacementHtml(pat: InlinePattern, content: string): string {
  const suffix = pat.trailingSpace ? "" : "\u200B";
  return `<${pat.tag}>${escapeHtml(content)}</${pat.tag}>${suffix}`;
}

/// Check if the user just completed an inline markdown pattern at the cursor.
/// If so, replace the raw markers with a styled element. Returns the HTML tag
/// name that was applied (e.g. "strong"), or null if no transform fired.
export function checkInlineTransform(): string | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;

  const node = sel.anchorNode;
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;

  const text = node.textContent ?? "";
  const pos = clampNodeOffset(node, sel.anchorOffset);

  for (const pat of patterns) {
    const m = matchPattern(text, pos, pat);
    if (m === null) continue;

    const { start, end } = computeReplaceRange(pat, m.start, pos);
    const html = buildReplacementHtml(pat, m.content);

    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    sel.removeAllRanges();
    sel.addRange(range);

    document.execCommand("insertHTML", false, html);

    // For trailingSpace patterns, the space text node is already there —
    // move cursor to after it so typing continues outside the styled element
    if (pat.trailingSpace) {
      const newSel = window.getSelection();
      if (newSel && newSel.rangeCount > 0) {
        const r = newSel.getRangeAt(0);
        let cursor = r.startContainer;
        // Walk up to the styled element if we're inside it
        while (cursor.parentNode && cursor.parentNode !== node.parentNode) {
          cursor = cursor.parentNode;
        }
        // Find the text node after the styled element (contains the space)
        const after = (cursor as HTMLElement).nextSibling;
        if (after && after.nodeType === Node.TEXT_NODE) {
          const nr = document.createRange();
          nr.setStart(after, clampNodeOffset(after, after.textContent?.length ?? 0));
          nr.collapse(true);
          newSel.removeAllRanges();
          newSel.addRange(nr);
        }
      }
    }

    return pat.tag;
  }

  return null;
}

export function matchPattern(
  text: string,
  pos: number,
  pat: InlinePattern,
): { start: number; content: string } | null {
  const { open, close } = pat;

  // For trailingSpace patterns, the char at pos-1 must be space/nbsp
  let end = pos;
  if (pat.trailingSpace) {
    if (pos < 1) return null;
    const last = text[pos - 1];
    if (last !== " " && last !== "\u00A0") return null;
    end = pos - 1;
  }

  if (end < open.length + close.length + 1) return null;

  // Closing marker must be right before cursor (or before trailing space)
  if (text.slice(end - close.length, end) !== close) return null;

  // Single * closing must not be part of **
  if (close === "*" && end >= 2 && text[end - 2] === "*") return null;

  // Single ` closing must not be part of `` or ```
  if (close === "`" && end >= 2 && text[end - 2] === "`") return null;

  // Search backwards for opening marker
  const contentEnd = end - close.length;
  const searchStart = Math.max(0, contentEnd - MAX_SEARCH);

  for (let i = contentEnd - 1; i >= searchStart; i--) {
    if (text.slice(i, i + open.length) !== open) continue;

    // Single * opening must not be part of **
    if (open === "*" && ((i > 0 && text[i - 1] === "*") || text[i + 1] === "*")) continue;

    // Single ` opening/closing must not be part of `` or ```
    if (open === "`" && ((i > 0 && text[i - 1] === "`") || text[i + 1] === "`")) continue;

    const content = text.slice(i + open.length, contentEnd);
    if (content.length === 0) continue;
    // Markdown convention: content must not start or end with space
    if (content.startsWith(" ") || content.endsWith(" ")) continue;

    return { start: i, content };
  }

  return null;
}

function clampNodeOffset(node: Node, offset: number): number {
  if (offset < 0) return 0;
  if (node.nodeType === Node.TEXT_NODE) {
    return Math.min(offset, node.textContent?.length ?? 0);
  }
  return Math.min(offset, node.childNodes.length);
}
