/// Block-level markdown transforms for the WYSIWYG editor.
/// Handles input like "## " → H2, "- " → UL, "```" → code block, etc.

type TransformFn = (block: HTMLElement, text: string) => boolean;

// contentEditable inserts \u00A0 (nbsp) instead of regular spaces in many cases
const SP = "[ \\u00A0]";

// Space-triggered: fire on input when user completes a block-start pattern
const inputTransforms: [RegExp, TransformFn][] = [
  [
    new RegExp(`^#{1,6}${SP}$`),
    (block, text) => {
      const level = text.trimEnd().length;
      const heading = document.createElement(`h${level}`) as HTMLHeadingElement;
      heading.innerHTML = "<br>";
      block.replaceWith(heading);
      setCursorStart(heading);
      return true;
    },
  ],

  [
    new RegExp(`^[-*]${SP}$`),
    (block) => {
      const ul = document.createElement("ul");
      const li = document.createElement("li");
      li.innerHTML = "<br>";
      ul.appendChild(li);
      block.replaceWith(ul);
      setCursorStart(li);
      return true;
    },
  ],

  [
    new RegExp(`^\\d+\\.${SP}$`),
    (block) => {
      const ol = document.createElement("ol");
      const li = document.createElement("li");
      li.innerHTML = "<br>";
      ol.appendChild(li);
      block.replaceWith(ol);
      setCursorStart(li);
      return true;
    },
  ],

  [
    new RegExp(`^>${SP}$`),
    (block) => {
      const bq = document.createElement("blockquote");
      const p = document.createElement("p");
      p.innerHTML = "<br>";
      bq.appendChild(p);
      block.replaceWith(bq);
      setCursorStart(p);
      return true;
    },
  ],

  [
    new RegExp(`^\`{3}\\S*${SP}$`),
    (block, text) => {
      const lang = text.slice(3).replace(/[ \u00A0]+$/, "");
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (lang) code.className = `language-${lang}`;
      code.textContent = "\n";
      pre.appendChild(code);
      block.replaceWith(pre);
      setCursorStart(code);
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
    range.setStart(anchor, sel.anchorOffset);
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
      const heading = document.createElement(`h${level}`) as HTMLHeadingElement;
      if (rest) {
        heading.textContent = rest;
      } else {
        heading.innerHTML = "<br>";
      }
      block.replaceWith(heading);
      setCursorStart(heading);
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
