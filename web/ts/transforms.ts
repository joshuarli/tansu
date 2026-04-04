/// Block-level markdown transforms for the WYSIWYG editor.
/// Handles input like "## " → H2, "- " → UL, "```" → code block, etc.

import { markDirty } from './tabs.ts';

export function handleBlockTransform(e: KeyboardEvent, contentEl: HTMLElement, currentPath: string | null) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;

  const node = sel.anchorNode;
  if (!node) return;

  const block = findBlock(node, contentEl);
  if (!block) return;

  const text = block.textContent ?? '';

  const transforms: [RegExp, string][] = [
    [/^#{1,6}\s/, 'heading'],
    [/^[-*]\s/, 'ul'],
    [/^\d+\.\s/, 'ol'],
    [/^>\s/, 'blockquote'],
    [/^```/, 'code'],
    [/^---$/, 'hr'],
  ];

  for (const [pattern, type] of transforms) {
    if (!pattern.test(text)) continue;

    if (type === 'hr' && text.trim() === '---') {
      e.preventDefault();
      const hr = document.createElement('hr');
      block.replaceWith(hr);
      const p = document.createElement('p');
      p.innerHTML = '<br>';
      hr.after(p);
      setCursorStart(p);
      if (currentPath) markDirty(currentPath);
      return;
    }

    if (type === 'code' && text.startsWith('```')) {
      e.preventDefault();
      const lang = text.slice(3).trim();
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      if (lang) code.className = `language-${lang}`;
      code.textContent = '\n';
      pre.appendChild(code);
      block.replaceWith(pre);
      const p = document.createElement('p');
      p.innerHTML = '<br>';
      pre.after(p);
      setCursorStart(code);
      if (currentPath) markDirty(currentPath);
      return;
    }

    if (type === 'heading') {
      const match = text.match(/^(#{1,6})\s(.*)$/);
      if (match) {
        e.preventDefault();
        const level = match[1]!.length;
        const heading = document.createElement(`h${level}`);
        heading.textContent = match[2] ?? '';
        block.replaceWith(heading);
        const p = document.createElement('p');
        p.innerHTML = '<br>';
        heading.after(p);
        setCursorStart(p);
        if (currentPath) markDirty(currentPath);
        return;
      }
    }

    if (type === 'ul') {
      const match = text.match(/^[-*]\s(.*)$/);
      if (match) {
        e.preventDefault();
        const ul = document.createElement('ul');
        const li = document.createElement('li');
        li.textContent = match[1] ?? '';
        ul.appendChild(li);
        block.replaceWith(ul);
        setCursorStart(li);
        if (currentPath) markDirty(currentPath);
        return;
      }
    }

    if (type === 'ol') {
      const match = text.match(/^\d+\.\s(.*)$/);
      if (match) {
        e.preventDefault();
        const ol = document.createElement('ol');
        const li = document.createElement('li');
        li.textContent = match[1] ?? '';
        ol.appendChild(li);
        block.replaceWith(ol);
        setCursorStart(li);
        if (currentPath) markDirty(currentPath);
        return;
      }
    }

    if (type === 'blockquote') {
      const match = text.match(/^>\s(.*)$/);
      if (match) {
        e.preventDefault();
        const bq = document.createElement('blockquote');
        const p = document.createElement('p');
        p.textContent = match[1] ?? '';
        bq.appendChild(p);
        block.replaceWith(bq);
        setCursorStart(p);
        if (currentPath) markDirty(currentPath);
        return;
      }
    }
  }
}

function findBlock(node: Node, contentEl: HTMLElement): HTMLElement | null {
  let current: Node | null = node;
  while (current && current !== contentEl) {
    if (current.nodeType === Node.ELEMENT_NODE) {
      const el = current as HTMLElement;
      const tag = el.tagName;
      if (['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE'].includes(tag)) {
        return el;
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
