/// Block-level markdown transforms for the WYSIWYG editor.
/// Handles input like "## " → H2, "- " → UL, "```" → code block, etc.

import { markDirty } from "./tabs.ts";

type TransformFn = (block: HTMLElement, text: string) => boolean;

const transforms: [RegExp, TransformFn][] = [
  [
    /^(#{1,6})\s(.*)$/,
    (block, text) => {
      const match = text.match(/^(#{1,6})\s(.*)$/);
      if (!match) return false;
      const heading = document.createElement(`h${match[1]!.length}`);
      heading.textContent = match[2] ?? "";
      block.replaceWith(heading);
      addParagraphAfter(heading);
      return true;
    },
  ],

  [
    /^---$/,
    (block) => {
      const hr = document.createElement("hr");
      block.replaceWith(hr);
      addParagraphAfter(hr);
      return true;
    },
  ],

  [
    /^```/,
    (block, text) => {
      const lang = text.slice(3).trim();
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (lang) code.className = `language-${lang}`;
      code.textContent = "\n";
      pre.appendChild(code);
      block.replaceWith(pre);
      addParagraphAfter(pre);
      setCursorStart(code);
      return true;
    },
  ],

  [
    /^[-*]\s(.*)$/,
    (block, text) => {
      const match = text.match(/^[-*]\s(.*)$/);
      if (!match) return false;
      const ul = document.createElement("ul");
      const li = document.createElement("li");
      li.textContent = match[1] ?? "";
      ul.appendChild(li);
      block.replaceWith(ul);
      setCursorStart(li);
      return true;
    },
  ],

  [
    /^\d+\.\s(.*)$/,
    (block, text) => {
      const match = text.match(/^\d+\.\s(.*)$/);
      if (!match) return false;
      const ol = document.createElement("ol");
      const li = document.createElement("li");
      li.textContent = match[1] ?? "";
      ol.appendChild(li);
      block.replaceWith(ol);
      setCursorStart(li);
      return true;
    },
  ],

  [
    /^>\s(.*)$/,
    (block, text) => {
      const match = text.match(/^>\s(.*)$/);
      if (!match) return false;
      const bq = document.createElement("blockquote");
      const p = document.createElement("p");
      p.textContent = match[1] ?? "";
      bq.appendChild(p);
      block.replaceWith(bq);
      setCursorStart(p);
      return true;
    },
  ],
];

export function handleBlockTransform(
  e: KeyboardEvent,
  contentEl: HTMLElement,
  currentPath: string | null,
) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;

  const block = findBlock(sel.anchorNode, contentEl);
  if (!block) return;

  const text = block.textContent ?? "";

  for (const [pattern, handler] of transforms) {
    if (pattern.test(text) && handler(block, text)) {
      e.preventDefault();
      if (currentPath) markDirty(currentPath);
      return;
    }
  }
}

function addParagraphAfter(el: Element) {
  const p = document.createElement("p");
  p.innerHTML = "<br>";
  el.after(p);
  setCursorStart(p);
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
