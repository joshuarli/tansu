import { saveNote } from "./api.ts";
import {
  checkWikiLinkTrigger,
  hideAutocomplete,
  invalidateNoteCache as _invalidateNoteCache,
} from "./autocomplete.ts";
import { loadBacklinks } from "./backlinks.ts";
import { showConflictBanner, handleReloadConflict } from "./conflict.ts";
import { on } from "./events.ts";
import { handleImagePaste } from "./image-paste.ts";
import { checkInlineTransform } from "./inline-transforms.ts";
import { renderMarkdown } from "./markdown.ts";
import { toggleRevisions, hideRevisions, isRevisionsOpen } from "./revisions.ts";
import { domToMarkdown } from "./serialize.ts";
import { markDirty, markClean, getActiveTab } from "./tabs.ts";
import { checkBlockInputTransform, handleBlockTransform } from "./transforms.ts";

let editorArea: HTMLElement;
let container: HTMLElement | null = null;
let contentEl: HTMLElement | null = null;
let sourceEl: HTMLTextAreaElement | null = null;
let backlinksEl: HTMLElement | null = null;
let revisionsEl: HTMLElement | null = null;
let isSourceMode = false;
let currentPath: string | null = null;

export { _invalidateNoteCache as invalidateNoteCache };

export function initEditor() {
  editorArea = document.getElementById("editor-area")!;

  on<{ content: string; mtime: number }>("revision:restore", ({ content, mtime }) => {
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

  const emptyState = document.getElementById("empty-state");
  editorArea.innerHTML = "";
  if (emptyState) editorArea.appendChild(emptyState);
  emptyState!.style.display = "none";

  container = document.createElement("div");
  container.className = "editor-container";

  const toolbar = document.createElement("div");
  toolbar.className = "editor-toolbar";

  const sourceBtn = document.createElement("button");
  sourceBtn.textContent = "Source";
  sourceBtn.title = "Toggle source mode";
  sourceBtn.onclick = () => toggleSourceMode();

  const revBtn = document.createElement("button");
  revBtn.textContent = "Revisions";
  revBtn.onclick = () => {
    if (currentPath && revisionsEl) {
      toggleRevisions({
        path: currentPath,
        host: revisionsEl,
        getCurrentContent: getCurrentContent,
        onHide: () => {
          if (revisionsEl) revisionsEl.style.display = "none";
          if (isSourceMode && sourceEl) sourceEl.style.display = "";
          else if (contentEl) contentEl.style.display = "";
        },
      });
      if (isRevisionsOpen()) {
        if (contentEl) contentEl.style.display = "none";
        if (sourceEl) sourceEl.style.display = "none";
        if (revisionsEl) revisionsEl.style.display = "";
      }
    }
  };

  toolbar.append(sourceBtn, revBtn);
  container.appendChild(toolbar);

  contentEl = document.createElement("div");
  contentEl.className = "editor-content";
  contentEl.contentEditable = "true";
  contentEl.spellcheck = true;
  container.appendChild(contentEl);

  sourceEl = document.createElement("textarea");
  sourceEl.className = "editor-source";
  sourceEl.style.display = "none";
  container.appendChild(sourceEl);

  revisionsEl = document.createElement("div");
  revisionsEl.className = "revisions-container";
  revisionsEl.style.display = "none";
  container.appendChild(revisionsEl);

  backlinksEl = document.createElement("div");
  backlinksEl.className = "backlinks";
  backlinksEl.style.display = "none";

  editorArea.appendChild(container);
  editorArea.appendChild(backlinksEl);

  loadContent(content);
  setupEditorEvents();
  loadBacklinks(backlinksEl, path);
}

export function hideEditor() {
  currentPath = null;
  hideRevisions();
  hideAutocomplete();

  if (container) {
    container.remove();
    container = null;
  }
  if (backlinksEl) {
    backlinksEl.remove();
    backlinksEl = null;
  }
  contentEl = null;
  sourceEl = null;
  revisionsEl = null;
  const emptyState = document.getElementById("empty-state");
  if (emptyState) emptyState.style.display = "flex";
}

export function getCurrentContent(): string {
  if (isSourceMode && sourceEl) {
    return sourceEl.value;
  }
  if (contentEl) {
    return domToMarkdown(contentEl);
  }
  return "";
}

export async function saveCurrentNote() {
  const tab = getActiveTab();
  if (!tab || !currentPath) return;

  const content = getCurrentContent();
  const result = await saveNote(currentPath, content, tab.mtime);

  if (result.conflict) {
    const diskContent = result.content ?? "";
    // False conflict: mtime drifted but content unchanged (Spotlight, iCloud, etc.)
    if (diskContent === content || diskContent === tab.content) {
      const retry = await saveNote(currentPath, content, 0);
      markClean(currentPath, content, retry.mtime);
      return;
    }
    // Real conflict: disk content genuinely differs
    if (container) {
      showConflictBanner(
        container,
        currentPath,
        diskContent,
        result.mtime,
        loadContent,
        getCurrentContent,
      );
    }
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

  if (container) {
    handleReloadConflict(
      tab,
      container,
      currentPath,
      content,
      mtime,
      loadContent,
      getCurrentContent,
    );
  }
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
  hideRevisions();

  if (isSourceMode) {
    const md = sourceEl.value;
    contentEl.innerHTML = renderMarkdown(md);
    contentEl.style.display = "";
    sourceEl.style.display = "none";
    isSourceMode = false;
  } else {
    const md = domToMarkdown(contentEl);
    sourceEl.value = md;
    contentEl.style.display = "none";
    sourceEl.style.display = "";
    isSourceMode = true;
  }

  container?.querySelector(".editor-toolbar button")?.classList.toggle("active", isSourceMode);
}

function setupEditorEvents() {
  if (!contentEl || !sourceEl) return;

  contentEl.addEventListener("input", () => {
    if (currentPath) markDirty(currentPath);
    if (contentEl && checkBlockInputTransform(contentEl)) return;
    checkInlineTransform();
    if (contentEl) checkWikiLinkTrigger(contentEl, currentPath);
  });

  sourceEl.addEventListener("input", () => {
    if (currentPath) markDirty(currentPath);
  });

  contentEl.addEventListener("keydown", (e) => {
    const meta = e.metaKey || e.ctrlKey;

    if (meta && e.key === "s") {
      e.preventDefault();
      saveCurrentNote();
      return;
    }

    if (meta && e.key === "b") {
      e.preventDefault();
      document.execCommand("bold");
      return;
    }

    if (meta && e.key === "i") {
      e.preventDefault();
      document.execCommand("italic");
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      handleBlockTransform(e, contentEl!, currentPath);
    }
  });

  contentEl.addEventListener("paste", (e) => {
    e.preventDefault();
    const clipData = e.clipboardData;
    if (!clipData) return;

    const imageItem = Array.from(clipData.items).find((item) => item.type.startsWith("image/"));
    if (imageItem) {
      handleImagePaste(imageItem, currentPath);
      return;
    }

    const text = clipData.getData("text/plain");
    document.execCommand("insertText", false, text);
  });

  sourceEl.addEventListener("keydown", (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key === "s") {
      e.preventDefault();
      saveCurrentNote();
    }
  });
}
