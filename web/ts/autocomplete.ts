/// Wiki-link autocomplete: detects [[ typing and shows a dropdown of matching notes.

import { listNotes } from "./api.ts";
import type { NoteEntry } from "./api.ts";
import { markDirty } from "./tabs.ts";
import { stemFromPath } from "./util.ts";

let autocompleteEl: HTMLElement | null = null;
let allNotes: NoteEntry[] | null = null;

export function invalidateNoteCache() {
  allNotes = null;
}

export function hideAutocomplete() {
  if (autocompleteEl) {
    autocompleteEl.remove();
    autocompleteEl = null;
  }
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
  const pos = range.startOffset;

  const before = text.slice(0, pos);
  const triggerIdx = before.lastIndexOf("[[");
  if (triggerIdx === -1 || before.includes("]]", triggerIdx)) {
    hideAutocomplete();
    return;
  }

  const query = before.slice(triggerIdx + 2).toLowerCase();
  showAutocomplete(query, node as Text, triggerIdx, pos, currentPath);
}

async function showAutocomplete(
  query: string,
  textNode: Text,
  triggerIdx: number,
  cursorPos: number,
  currentPath: string | null,
) {
  if (!allNotes) {
    try {
      allNotes = await listNotes();
    } catch (e) {
      console.warn("Failed to load notes for autocomplete:", e);
      return;
    }
  }

  const filtered = allNotes
    .filter((n) => {
      const stem = stemFromPath(n.path).toLowerCase();
      const title = n.title.toLowerCase();
      return stem.includes(query) || title.includes(query);
    })
    .slice(0, 10);

  if (filtered.length === 0) {
    hideAutocomplete();
    return;
  }

  hideAutocomplete();
  autocompleteEl = document.createElement("div");
  autocompleteEl.className = "autocomplete";

  const range = document.createRange();
  range.setStart(textNode, triggerIdx);
  range.setEnd(textNode, cursorPos);
  const rect = range.getBoundingClientRect();
  autocompleteEl.style.left = `${rect.left}px`;
  autocompleteEl.style.top = `${rect.bottom + 4}px`;

  let selectedIdx = 0;

  filtered.forEach((note, i) => {
    const item = document.createElement("div");
    item.className = "autocomplete-item" + (i === 0 ? " selected" : "");
    item.textContent = note.title || stemFromPath(note.path);
    item.onclick = () => completeWikiLink(textNode, triggerIdx, cursorPos, note, currentPath);
    autocompleteEl!.appendChild(item);
  });

  document.body.appendChild(autocompleteEl);

  const handler = (e: KeyboardEvent) => {
    if (!autocompleteEl) {
      document.removeEventListener("keydown", handler, true);
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
      e.preventDefault();
      e.stopPropagation();
      const note = filtered[selectedIdx];
      if (note) completeWikiLink(textNode, triggerIdx, cursorPos, note, currentPath);
      document.removeEventListener("keydown", handler, true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      hideAutocomplete();
      document.removeEventListener("keydown", handler, true);
    }
  };

  document.addEventListener("keydown", handler, true);
}

function updateSelection(idx: number) {
  if (!autocompleteEl) return;
  const items = autocompleteEl.children;
  for (let i = 0; i < items.length; i++) {
    items[i]!.classList.toggle("selected", i === idx);
  }
}

function completeWikiLink(
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
  if (currentPath) markDirty(currentPath);
}
