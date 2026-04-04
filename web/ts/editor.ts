import { saveNote, getNote, getBacklinks, uploadImage, listNotes } from './api.ts';
import type { NoteEntry } from './api.ts';
import { markDirty, markClean, getActiveTab, openTab } from './tabs.ts';
import { toggleRevisions, hideRevisions, setOnRestore } from './revisions.ts';
import { stemFromPath } from './util.ts';
import { merge3 } from './merge.ts';

declare const marked: { parse: (md: string) => string };
declare const hljs: { highlightElement: (el: HTMLElement) => void };

let editorArea: HTMLElement;
let container: HTMLElement | null = null;
let contentEl: HTMLElement | null = null;
let sourceEl: HTMLTextAreaElement | null = null;
let backlinksEl: HTMLElement | null = null;
let isSourceMode = false;
let currentPath: string | null = null;
let autocompleteEl: HTMLElement | null = null;
let allNotes: NoteEntry[] | null = null;

export function initEditor() {
  editorArea = document.getElementById('editor-area')!;

  setOnRestore((content, mtime) => {
    if (currentPath) {
      loadContent(content);
      markClean(currentPath, content, mtime);
    }
  });
}

export function showEditor(path: string, content: string) {
  currentPath = path;
  isSourceMode = false;
  hideRevisions();
  hideAutocomplete();

  // Clear editor area (except empty state)
  const emptyState = document.getElementById('empty-state');
  editorArea.innerHTML = '';
  if (emptyState) editorArea.appendChild(emptyState);
  emptyState!.style.display = 'none';

  // Container
  container = document.createElement('div');
  container.className = 'editor-container';

  // Mode toggle toolbar (minimal)
  const toolbar = document.createElement('div');
  toolbar.className = 'editor-toolbar';

  const sourceBtn = document.createElement('button');
  sourceBtn.textContent = 'Source';
  sourceBtn.title = 'Toggle source mode';
  sourceBtn.onclick = () => toggleSourceMode();

  const revBtn = document.createElement('button');
  revBtn.textContent = 'Revisions';
  revBtn.onclick = () => { if (currentPath) toggleRevisions(currentPath); };

  toolbar.append(sourceBtn, revBtn);
  container.appendChild(toolbar);

  // WYSIWYG content area
  contentEl = document.createElement('div');
  contentEl.className = 'editor-content';
  contentEl.contentEditable = 'true';
  contentEl.spellcheck = true;
  container.appendChild(contentEl);

  // Source textarea (hidden by default)
  sourceEl = document.createElement('textarea');
  sourceEl.className = 'editor-source';
  sourceEl.style.display = 'none';
  container.appendChild(sourceEl);

  // Backlinks
  backlinksEl = document.createElement('div');
  backlinksEl.className = 'backlinks';
  backlinksEl.style.display = 'none';

  editorArea.appendChild(container);
  editorArea.appendChild(backlinksEl);

  loadContent(content);
  setupEditorEvents();
  loadBacklinks(path);
}

export function hideEditor() {
  currentPath = null;
  hideRevisions();
  hideAutocomplete();
  if (container) { container.remove(); container = null; }
  if (backlinksEl) { backlinksEl.remove(); backlinksEl = null; }
  contentEl = null;
  sourceEl = null;
  const emptyState = document.getElementById('empty-state');
  if (emptyState) emptyState.style.display = 'flex';
}

export function getCurrentContent(): string {
  if (isSourceMode && sourceEl) {
    return sourceEl.value;
  }
  if (contentEl) {
    return domToMarkdown(contentEl);
  }
  return '';
}

export async function saveCurrentNote() {
  const tab = getActiveTab();
  if (!tab || !currentPath) return;

  const content = getCurrentContent();
  const result = await saveNote(currentPath, content, tab.mtime);

  if (result.conflict) {
    showConflictBanner(result.content ?? '', result.mtime);
    return;
  }

  markClean(currentPath, content, result.mtime);
}

export function reloadFromDisk(content: string, mtime: number) {
  const tab = getActiveTab();
  if (!tab || !currentPath) return;

  if (!tab.dirty) {
    loadContent(content);
    markClean(currentPath, content, mtime);
    return;
  }

  // Dirty tab: attempt 3-way merge
  const base = tab.content; // last saved version
  const ours = getCurrentContent();
  const theirs = content;

  const merged = merge3(base, ours, theirs);
  if (merged !== null) {
    loadContent(merged);
    // Still dirty since merged content differs from disk
    tab.content = content;
    tab.mtime = mtime;
    return;
  }

  // Conflict: show banner
  showConflictBanner(content, mtime);
}

function showConflictBanner(diskContent: string, diskMtime: number) {
  if (!container) return;

  // Remove existing banner
  container.querySelector('.conflict-banner')?.remove();

  const banner = document.createElement('div');
  banner.className = 'conflict-banner';

  const msg = document.createElement('span');
  msg.textContent = 'File changed externally \u2014 conflicts detected.';

  const keepBtn = document.createElement('button');
  keepBtn.textContent = 'Keep mine';
  keepBtn.onclick = () => {
    banner.remove();
    // Force save with current content
    if (currentPath) {
      const content = getCurrentContent();
      saveNote(currentPath, content, 0).then(r => {
        if (currentPath) markClean(currentPath, content, r.mtime);
      });
    }
  };

  const takeBtn = document.createElement('button');
  takeBtn.textContent = 'Take theirs';
  takeBtn.onclick = () => {
    banner.remove();
    loadContent(diskContent);
    if (currentPath) markClean(currentPath, diskContent, diskMtime);
  };

  banner.append(msg, keepBtn, takeBtn);
  container.insertBefore(banner, container.firstChild);
}

function loadContent(markdown: string) {
  if (isSourceMode && sourceEl) {
    sourceEl.value = markdown;
  } else if (contentEl) {
    contentEl.innerHTML = marked.parse(markdown);
    highlightCodeBlocks();
  }
}

function highlightCodeBlocks() {
  if (!contentEl) return;
  contentEl.querySelectorAll('pre code').forEach((el) => {
    try { hljs.highlightElement(el as HTMLElement); } catch {}
  });
}

function toggleSourceMode() {
  if (!contentEl || !sourceEl) return;

  if (isSourceMode) {
    // Source -> WYSIWYG
    const md = sourceEl.value;
    contentEl.innerHTML = marked.parse(md);
    highlightCodeBlocks();
    contentEl.style.display = '';
    sourceEl.style.display = 'none';
    isSourceMode = false;
  } else {
    // WYSIWYG -> Source
    const md = domToMarkdown(contentEl);
    sourceEl.value = md;
    contentEl.style.display = 'none';
    sourceEl.style.display = '';
    isSourceMode = true;
  }

  // Update toolbar button
  container?.querySelector('.editor-toolbar button')?.classList.toggle('active', isSourceMode);
}

function setupEditorEvents() {
  if (!contentEl || !sourceEl) return;

  // Track dirty state
  contentEl.addEventListener('input', () => {
    if (currentPath) markDirty(currentPath);
  });

  sourceEl.addEventListener('input', () => {
    if (currentPath) markDirty(currentPath);
  });

  // Keyboard shortcuts in contenteditable
  contentEl.addEventListener('keydown', (e) => {
    const meta = e.metaKey || e.ctrlKey;

    if (meta && e.key === 's') {
      e.preventDefault();
      saveCurrentNote();
      return;
    }

    if (meta && e.key === 'b') {
      e.preventDefault();
      wrapInline('**');
      return;
    }

    if (meta && e.key === 'i') {
      e.preventDefault();
      wrapInline('*');
      return;
    }

    // Block transforms on Enter
    if (e.key === 'Enter' && !e.shiftKey) {
      handleBlockTransform(e);
    }

    // Paste: strip to plain text
    // (handled in paste event below)
  });

  contentEl.addEventListener('paste', (e) => {
    e.preventDefault();
    const clipData = e.clipboardData;
    if (!clipData) return;

    // Check for image paste
    const imageItem = Array.from(clipData.items).find(item => item.type.startsWith('image/'));
    if (imageItem) {
      handleImagePaste(imageItem);
      return;
    }

    // Plain text paste
    const text = clipData.getData('text/plain');
    document.execCommand('insertText', false, text);
  });

  // Wiki-link autocomplete: detect [[ typing
  contentEl.addEventListener('input', () => {
    checkWikiLinkTrigger();
  });

  // Source mode shortcuts
  sourceEl.addEventListener('keydown', (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key === 's') {
      e.preventDefault();
      saveCurrentNote();
    }
  });
}

function wrapInline(marker: string) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  const text = range.toString();
  if (text) {
    document.execCommand('insertText', false, `${marker}${text}${marker}`);
  }
}

function handleBlockTransform(e: KeyboardEvent) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;

  const node = sel.anchorNode;
  if (!node) return;

  const block = findBlock(node);
  if (!block) return;

  const text = block.textContent ?? '';

  // Check for block-level markdown shortcuts
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
      // Create new paragraph after hr
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
      // Create paragraph after
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

function findBlock(node: Node): HTMLElement | null {
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

async function handleImagePaste(item: DataTransferItem) {
  const file = item.getAsFile();
  if (!file) return;

  // Convert to webp using OffscreenCanvas
  const bitmap = await createImageBitmap(file);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
  bitmap.close();

  // Generate filename
  const now = new Date();
  const ts = now.getFullYear().toString()
    + String(now.getMonth() + 1).padStart(2, '0')
    + String(now.getDate()).padStart(2, '0')
    + String(now.getHours()).padStart(2, '0')
    + String(now.getMinutes()).padStart(2, '0')
    + String(now.getSeconds()).padStart(2, '0');

  const noteName = currentPath ? stemFromPath(currentPath) : 'image';
  const filename = `${noteName} ${ts}.webp`;

  try {
    const savedName = await uploadImage(blob, filename);
    // Insert wiki-image syntax
    document.execCommand('insertText', false, `![[${savedName}]]`);
    if (currentPath) markDirty(currentPath);
  } catch (e) {
    console.error('Image upload failed:', e);
  }
}

// Wiki-link autocomplete
async function checkWikiLinkTrigger() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !contentEl) {
    hideAutocomplete();
    return;
  }

  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) {
    hideAutocomplete();
    return;
  }

  const text = node.textContent ?? '';
  const pos = range.startOffset;

  // Find [[ before cursor
  const before = text.slice(0, pos);
  const triggerIdx = before.lastIndexOf('[[');
  if (triggerIdx === -1 || before.includes(']]', triggerIdx)) {
    hideAutocomplete();
    return;
  }

  const query = before.slice(triggerIdx + 2).toLowerCase();
  await showAutocomplete(query, node as Text, triggerIdx, pos);
}

async function showAutocomplete(query: string, textNode: Text, triggerIdx: number, cursorPos: number) {
  // Load all notes if not cached
  if (!allNotes) {
    try {
      allNotes = await listNotes();
    } catch {
      return;
    }
  }

  const filtered = allNotes.filter(n => {
    const stem = stemFromPath(n.path).toLowerCase();
    const title = n.title.toLowerCase();
    return stem.includes(query) || title.includes(query);
  }).slice(0, 10);

  if (filtered.length === 0) {
    hideAutocomplete();
    return;
  }

  hideAutocomplete();
  autocompleteEl = document.createElement('div');
  autocompleteEl.className = 'autocomplete';

  // Position near cursor
  const range = document.createRange();
  range.setStart(textNode, triggerIdx);
  range.setEnd(textNode, cursorPos);
  const rect = range.getBoundingClientRect();
  autocompleteEl.style.left = `${rect.left}px`;
  autocompleteEl.style.top = `${rect.bottom + 4}px`;

  let selectedIdx = 0;

  filtered.forEach((note, i) => {
    const item = document.createElement('div');
    item.className = 'autocomplete-item' + (i === 0 ? ' selected' : '');
    item.textContent = note.title || stemFromPath(note.path);
    item.onclick = () => completeWikiLink(textNode, triggerIdx, cursorPos, note);
    autocompleteEl!.appendChild(item);
  });

  document.body.appendChild(autocompleteEl);

  // Handle keyboard in autocomplete
  const handler = (e: KeyboardEvent) => {
    if (!autocompleteEl) {
      document.removeEventListener('keydown', handler, true);
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      selectedIdx = (selectedIdx + 1) % filtered.length;
      updateAutocompleteSelection(selectedIdx);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      selectedIdx = (selectedIdx - 1 + filtered.length) % filtered.length;
      updateAutocompleteSelection(selectedIdx);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      const note = filtered[selectedIdx];
      if (note) completeWikiLink(textNode, triggerIdx, cursorPos, note);
      document.removeEventListener('keydown', handler, true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hideAutocomplete();
      document.removeEventListener('keydown', handler, true);
    }
  };

  document.addEventListener('keydown', handler, true);
}

function updateAutocompleteSelection(idx: number) {
  if (!autocompleteEl) return;
  const items = autocompleteEl.children;
  for (let i = 0; i < items.length; i++) {
    items[i]!.classList.toggle('selected', i === idx);
  }
}

function completeWikiLink(textNode: Text, triggerIdx: number, cursorPos: number, note: NoteEntry) {
  const stem = stemFromPath(note.path);
  const text = textNode.textContent ?? '';
  const before = text.slice(0, triggerIdx);
  const after = text.slice(cursorPos);
  textNode.textContent = `${before}[[${stem}]]${after}`;

  // Place cursor after ]]
  const newPos = triggerIdx + stem.length + 4;
  const sel = window.getSelection();
  if (sel) {
    const range = document.createRange();
    range.setStart(textNode, Math.min(newPos, textNode.length));
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  hideAutocomplete();
  if (currentPath) markDirty(currentPath);
}

function hideAutocomplete() {
  if (autocompleteEl) {
    autocompleteEl.remove();
    autocompleteEl = null;
  }
}

export function invalidateNoteCache() {
  allNotes = null;
}

async function loadBacklinks(path: string) {
  if (!backlinksEl) return;
  try {
    const links = await getBacklinks(path);
    if (links.length === 0) {
      backlinksEl.style.display = 'none';
      return;
    }

    backlinksEl.style.display = '';
    backlinksEl.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'backlinks-header';
    header.textContent = `${links.length} backlink${links.length > 1 ? 's' : ''}`;
    backlinksEl.appendChild(header);

    const list = document.createElement('div');
    list.className = 'backlinks-list';
    for (const linkPath of links) {
      const item = document.createElement('div');
      item.className = 'backlink-item';
      item.textContent = stemFromPath(linkPath);
      item.onclick = () => openTab(linkPath);
      list.appendChild(item);
    }
    backlinksEl.appendChild(list);
  } catch {
    backlinksEl.style.display = 'none';
  }
}

// DOM -> Markdown serialization
function domToMarkdown(root: HTMLElement): string {
  const blocks: string[] = [];
  for (const child of root.children) {
    const md = blockToMd(child as HTMLElement);
    if (md !== null) blocks.push(md);
  }
  return blocks.join('\n\n');
}

function blockToMd(el: HTMLElement): string | null {
  const tag = el.tagName;

  if (tag === 'H1') return `# ${inlineToMd(el)}`;
  if (tag === 'H2') return `## ${inlineToMd(el)}`;
  if (tag === 'H3') return `### ${inlineToMd(el)}`;
  if (tag === 'H4') return `#### ${inlineToMd(el)}`;
  if (tag === 'H5') return `##### ${inlineToMd(el)}`;
  if (tag === 'H6') return `###### ${inlineToMd(el)}`;
  if (tag === 'P' || tag === 'DIV') return inlineToMd(el);
  if (tag === 'HR') return '---';

  if (tag === 'UL') {
    return Array.from(el.children)
      .map(li => `- ${inlineToMd(li as HTMLElement)}`)
      .join('\n');
  }

  if (tag === 'OL') {
    return Array.from(el.children)
      .map((li, i) => `${i + 1}. ${inlineToMd(li as HTMLElement)}`)
      .join('\n');
  }

  if (tag === 'BLOCKQUOTE') {
    const inner = Array.from(el.children)
      .map(child => blockToMd(child as HTMLElement) ?? '')
      .join('\n\n');
    return inner.split('\n').map(line => `> ${line}`).join('\n');
  }

  if (tag === 'PRE') {
    const code = el.querySelector('code');
    const text = code?.textContent ?? el.textContent ?? '';
    const lang = code?.className?.match(/language-(\S+)/)?.[1] ?? '';
    return '```' + lang + '\n' + text.replace(/\n$/, '') + '\n```';
  }

  if (tag === 'TABLE') {
    return tableToMd(el);
  }

  // Fallback
  return inlineToMd(el);
}

function inlineToMd(el: HTMLElement): string {
  let md = '';
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      md += node.textContent ?? '';
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const child = node as HTMLElement;
      const childTag = child.tagName;

      if (childTag === 'STRONG' || childTag === 'B') {
        md += `**${inlineToMd(child)}**`;
      } else if (childTag === 'EM' || childTag === 'I') {
        md += `*${inlineToMd(child)}*`;
      } else if (childTag === 'CODE') {
        md += '`' + (child.textContent ?? '') + '`';
      } else if (childTag === 'A') {
        const target = child.getAttribute('data-target');
        if (target) {
          // Wiki-link
          const display = child.textContent ?? target;
          if (display === target) {
            md += `[[${target}]]`;
          } else {
            md += `[[${target}|${display}]]`;
          }
        } else {
          const href = child.getAttribute('href') ?? '';
          md += `[${child.textContent ?? ''}](${href})`;
        }
      } else if (childTag === 'IMG') {
        const wikiImage = child.getAttribute('data-wiki-image');
        if (wikiImage) {
          md += `![[${wikiImage}]]`;
        } else {
          const src = child.getAttribute('src') ?? '';
          const alt = child.getAttribute('alt') ?? '';
          md += `![${alt}](${src})`;
        }
      } else if (childTag === 'BR') {
        md += '\n';
      } else {
        md += inlineToMd(child);
      }
    }
  }
  return md;
}

function tableToMd(table: HTMLElement): string {
  const rows: string[][] = [];
  for (const tr of table.querySelectorAll('tr')) {
    const cells: string[] = [];
    for (const cell of tr.querySelectorAll('th, td')) {
      cells.push((cell.textContent ?? '').trim());
    }
    rows.push(cells);
  }

  if (rows.length === 0) return '';

  const colCount = Math.max(...rows.map(r => r.length));
  const lines: string[] = [];

  // Header row
  const header = rows[0] ?? [];
  lines.push('| ' + Array.from({ length: colCount }, (_, i) => header[i] ?? '').join(' | ') + ' |');
  lines.push('| ' + Array.from({ length: colCount }, () => '---').join(' | ') + ' |');

  // Data rows
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    lines.push('| ' + Array.from({ length: colCount }, (_, j) => row[j] ?? '').join(' | ') + ' |');
  }

  return lines.join('\n');
}
