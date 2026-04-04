import { saveNote, getBacklinks, uploadImage } from './api.ts';
import { markDirty, markClean, getActiveTab, openTab } from './tabs.ts';
import { toggleRevisions, hideRevisions, setOnRestore } from './revisions.ts';
import { stemFromPath } from './util.ts';
import { merge3 } from './merge.ts';
import { domToMarkdown } from './serialize.ts';
import { handleBlockTransform } from './transforms.ts';
import { checkWikiLinkTrigger, hideAutocomplete, invalidateNoteCache as _invalidateNoteCache } from './autocomplete.ts';
import { renderMarkdown } from './markdown.ts';


let editorArea: HTMLElement;
let container: HTMLElement | null = null;
let contentEl: HTMLElement | null = null;
let sourceEl: HTMLTextAreaElement | null = null;
let backlinksEl: HTMLElement | null = null;
let isSourceMode = false;
let currentPath: string | null = null;

export { _invalidateNoteCache as invalidateNoteCache };

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


  const emptyState = document.getElementById('empty-state');
  editorArea.innerHTML = '';
  if (emptyState) editorArea.appendChild(emptyState);
  emptyState!.style.display = 'none';

  container = document.createElement('div');
  container.className = 'editor-container';

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

  contentEl = document.createElement('div');
  contentEl.className = 'editor-content';
  contentEl.contentEditable = 'true';
  contentEl.spellcheck = true;
  container.appendChild(contentEl);

  sourceEl = document.createElement('textarea');
  sourceEl.className = 'editor-source';
  sourceEl.style.display = 'none';
  container.appendChild(sourceEl);

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
  const base = tab.content;
  const ours = getCurrentContent();
  const theirs = content;

  const merged = merge3(base, ours, theirs);
  if (merged !== null) {
    loadContent(merged);
    tab.content = content;
    tab.mtime = mtime;
    return;
  }

  showConflictBanner(content, mtime);
}

function showConflictBanner(diskContent: string, diskMtime: number) {
  if (!container) return;

  container.querySelector('.conflict-banner')?.remove();

  const banner = document.createElement('div');
  banner.className = 'conflict-banner';

  const msg = document.createElement('span');
  msg.textContent = 'File changed externally \u2014 conflicts detected.';

  const keepBtn = document.createElement('button');
  keepBtn.textContent = 'Keep mine';
  keepBtn.onclick = () => {
    banner.remove();
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
    contentEl.innerHTML = renderMarkdown(markdown);
  }
}


function toggleSourceMode() {
  if (!contentEl || !sourceEl) return;

  if (isSourceMode) {
    const md = sourceEl.value;
    contentEl.innerHTML = renderMarkdown(md);
    contentEl.style.display = '';
    sourceEl.style.display = 'none';
    isSourceMode = false;
  } else {
    const md = domToMarkdown(contentEl);
    sourceEl.value = md;
    contentEl.style.display = 'none';
    sourceEl.style.display = '';
    isSourceMode = true;
  }

  container?.querySelector('.editor-toolbar button')?.classList.toggle('active', isSourceMode);
}

function setupEditorEvents() {
  if (!contentEl || !sourceEl) return;

  contentEl.addEventListener('input', () => {
    if (currentPath) markDirty(currentPath);
    if (contentEl) checkWikiLinkTrigger(contentEl, currentPath);
  });

  sourceEl.addEventListener('input', () => {
    if (currentPath) markDirty(currentPath);
  });

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

    if (e.key === 'Enter' && !e.shiftKey) {
      handleBlockTransform(e, contentEl!, currentPath);
    }
  });

  contentEl.addEventListener('paste', (e) => {
    e.preventDefault();
    const clipData = e.clipboardData;
    if (!clipData) return;

    const imageItem = Array.from(clipData.items).find(item => item.type.startsWith('image/'));
    if (imageItem) {
      handleImagePaste(imageItem);
      return;
    }

    const text = clipData.getData('text/plain');
    document.execCommand('insertText', false, text);
  });

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

async function handleImagePaste(item: DataTransferItem) {
  const file = item.getAsFile();
  if (!file) return;

  const bitmap = await createImageBitmap(file);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
  bitmap.close();

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
    document.execCommand('insertText', false, `![[${savedName}]]`);
    if (currentPath) markDirty(currentPath);
  } catch (e) {
    console.error('Image upload failed:', e);
  }
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
