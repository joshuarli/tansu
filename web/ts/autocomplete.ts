/// Wiki-link autocomplete: detects [[ typing and shows a dropdown of matching notes.

import { clampNodeOffset, stemFromPath } from "@joshuarli98/md-wysiwyg";

import { listNotes, type NoteEntry } from "./api.ts";
import { getVaultSettings } from "./settings.ts";
import { markDirty } from "./tab-state.ts";

let autocompleteEl: HTMLElement | null = null;
let allNotes: NoteEntry[] | null = null;
let activeKeyHandler: ((e: KeyboardEvent) => void) | null = null;
let autocompleteRequestId = 0;

export function invalidateNoteCache() {
  allNotes = null;
}

function removeKeyHandler() {
  if (activeKeyHandler) {
    document.removeEventListener("keydown", activeKeyHandler, true);
    activeKeyHandler = null;
  }
}

function clearAutocomplete() {
  if (autocompleteEl) {
    autocompleteEl.remove();
    autocompleteEl = null;
  }
  removeKeyHandler();
}

export function hideAutocomplete() {
  autocompleteRequestId++;
  clearAutocomplete();
}

export function checkWikiLinkTrigger(contentEl: HTMLElement, currentPath: string | null) {
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

  const text = node.textContent ?? "";
  const pos = clampNodeOffset(node, range.startOffset);

  const before = text.slice(0, pos);
  const triggerIdx = before.lastIndexOf("[[");
  if (triggerIdx === -1 || before.includes("]]", triggerIdx)) {
    hideAutocomplete();
    return;
  }

  const query = before.slice(triggerIdx + 2).toLowerCase();
  const requestId = ++autocompleteRequestId;
  void showAutocomplete({
    requestId,
    query,
    contentEl,
    textNode: node as Text,
    triggerIdx,
    cursorPos: pos,
    currentPath,
  });
}

type AutocompleteRequest = {
  requestId: number;
  query: string;
  contentEl: HTMLElement;
  textNode: Text;
  triggerIdx: number;
  cursorPos: number;
  currentPath: string | null;
};

function isActiveTrigger(
  contentEl: HTMLElement,
  textNode: Text,
  triggerIdx: number,
  cursorPos: number,
): boolean {
  if (!textNode.isConnected || !contentEl.contains(textNode)) {
    return false;
  }
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) {
    return false;
  }
  const range = sel.getRangeAt(0);
  if (range.startContainer !== textNode) {
    return false;
  }
  const pos = clampNodeOffset(textNode, range.startOffset);
  if (pos !== cursorPos) {
    return false;
  }
  const before = (textNode.textContent ?? "").slice(0, pos);
  return before.lastIndexOf("[[") === triggerIdx && !before.includes("]]", triggerIdx);
}

async function showAutocomplete({
  requestId,
  query,
  contentEl,
  textNode,
  triggerIdx,
  cursorPos,
  currentPath,
}: AutocompleteRequest) {
  if (!allNotes) {
    try {
      allNotes = await listNotes();
    } catch {
      if (requestId === autocompleteRequestId) {
        clearAutocomplete();
      }
      return;
    }
  }
  if (
    requestId !== autocompleteRequestId ||
    !isActiveTrigger(contentEl, textNode, triggerIdx, cursorPos)
  ) {
    return;
  }

  const filtered = allNotes
    .filter((n) => {
      const stem = stemFromPath(n.path).toLowerCase();
      const title = n.title.toLowerCase();
      return stem.includes(query) || title.includes(query);
    })
    .slice(0, getVaultSettings().autocompleteMaxResults);

  if (filtered.length === 0) {
    clearAutocomplete();
    return;
  }

  clearAutocomplete();
  autocompleteEl = document.createElement("div");
  autocompleteEl.className = "autocomplete";

  const range = document.createRange();
  range.setStart(textNode, triggerIdx);
  range.setEnd(textNode, cursorPos);
  const rect = range.getBoundingClientRect();
  autocompleteEl.style.left = `${rect.left}px`;
  autocompleteEl.style.top = `${rect.bottom + getVaultSettings().autocompleteOffsetPx}px`;

  let selectedIdx = 0;

  for (const [i, note] of filtered.entries()) {
    const item = document.createElement("div");
    item.className = `autocomplete-item${i === 0 ? " selected" : ""}`;
    item.textContent = note.title || stemFromPath(note.path);
    item.onclick = () => completeWikiLink(textNode, triggerIdx, cursorPos, note, currentPath);
    autocompleteEl!.append(item);
  }

  document.body.append(autocompleteEl);

  removeKeyHandler();
  const handler = (e: KeyboardEvent) => {
    if (!autocompleteEl) {
      removeKeyHandler();
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      selectedIdx = (selectedIdx + 1) % filtered.length;
      updateSelection(selectedIdx);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      selectedIdx = (selectedIdx - 1 + filtered.length) % filtered.length;
      updateSelection(selectedIdx);
    } else if (e.key === "Enter" || e.key === "Tab") {
      /* c8 ignore start */
      e.preventDefault();
      e.stopPropagation();
      const note = filtered[selectedIdx];
      if (note && requestId === autocompleteRequestId) {
        completeWikiLink(textNode, triggerIdx, cursorPos, note, currentPath);
      }
      removeKeyHandler();
      /* c8 ignore stop */
    } else if (e.key === "Escape") {
      e.preventDefault();
      hideAutocomplete();
    }
  };

  document.addEventListener("keydown", handler, true);
  activeKeyHandler = handler;
}

function updateSelection(idx: number) {
  if (!autocompleteEl) {
    return;
  }
  const items = autocompleteEl.children;
  for (let i = 0; i < items.length; i++) {
    items[i]!.classList.toggle("selected", i === idx);
  }
}

export type CompleteWikiLink = typeof completeWikiLink;

export function completeWikiLink(
  textNode: Text,
  triggerIdx: number,
  cursorPos: number,
  note: NoteEntry,
  currentPath: string | null,
) {
  const stem = stemFromPath(note.path);
  const text = textNode.textContent ?? "";
  const before = text.slice(0, triggerIdx);
  const after = text.slice(cursorPos);
  textNode.textContent = `${before}[[${stem}]]${after}`;

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
  if (currentPath) {
    markDirty(currentPath);
  }
}
