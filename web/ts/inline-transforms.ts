/// Inline markdown → DOM transforms for live WYSIWYG editing.
/// Detects completed patterns like **bold** at the cursor and replaces
/// with styled elements. Uses execCommand('insertHTML') so transforms
/// participate in the browser's undo stack.

import { escapeHtml } from "./util.ts";

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

/// Check if the user just completed an inline markdown pattern at the cursor.
/// If so, replace the raw markers with a styled element. Returns true if a
/// transform was applied.
export function checkInlineTransform(): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;

  const node = sel.anchorNode;
  if (!node || node.nodeType !== Node.TEXT_NODE) return false;

  const text = node.textContent ?? "";
  const pos = sel.anchorOffset;

  for (const pat of patterns) {
    const m = matchPattern(text, pos, pat);
    if (m === null) continue;

    const range = document.createRange();
    range.setStart(node, m.start);
    // For trailingSpace patterns, leave the space in place as natural cursor target
    range.setEnd(node, pat.trailingSpace ? pos - 1 : pos);
    sel.removeAllRanges();
    sel.addRange(range);

    // ZWS after element gives cursor a text node to land in outside the styled element
    const suffix = pat.trailingSpace ? "" : "\u200B";
    document.execCommand(
      "insertHTML",
      false,
      `<${pat.tag}>${escapeHtml(m.content)}</${pat.tag}>${suffix}`,
    );

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
          nr.setStart(after, after.textContent!.length);
          nr.collapse(true);
          newSel.removeAllRanges();
          newSel.addRange(nr);
        }
      }
    }

    return true;
  }

  return false;
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
