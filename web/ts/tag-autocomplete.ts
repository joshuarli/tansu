import { listTags } from "./api.ts";
import {
  TAG_AUTOCOMPLETE_MAX_RESULTS,
  TAG_AUTOCOMPLETE_OFFSET_PX,
  TAG_AUTOCOMPLETE_MIN_WIDTH_PX,
} from "./constants.ts";

type TagSelection = (tag: string) => void;

type InputTarget = {
  inputEl: HTMLInputElement;
  selectedTags: readonly string[];
  onSelect: TagSelection;
};

type Item = { kind: "existing" | "create"; tag: string; label: string };

let autocompleteEl: HTMLElement | null = null;
let allTags: string[] | null = null;
let activeKeyHandler: ((e: KeyboardEvent) => void) | null = null;
let activePointerHandler: ((e: MouseEvent) => void) | null = null;
let requestId = 0;

export function invalidateTagCache() {
  allTags = null;
}

export function rememberTags(tags: readonly string[]) {
  const merged = allTags ? new Set(allTags) : new Set<string>();
  for (const tag of tags) {
    merged.add(tag);
  }
  allTags = [...merged].toSorted();
}

function clearDropdown() {
  if (autocompleteEl) {
    autocompleteEl.remove();
    autocompleteEl = null;
  }
  if (activeKeyHandler) {
    document.removeEventListener("keydown", activeKeyHandler, true);
    activeKeyHandler = null;
  }
  if (activePointerHandler) {
    document.removeEventListener("mousedown", activePointerHandler, true);
    activePointerHandler = null;
  }
}

export function hideTagAutocomplete() {
  requestId++;
  clearDropdown();
}

export function normalizeTagInput(input: string): string {
  return input
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/g, "")
    .trim();
}

function isSubsequenceMatch(text: string, query: string): boolean {
  if (!query) {
    return true;
  }
  let queryIndex = 0;
  for (const ch of text) {
    if (ch === query[queryIndex]) {
      queryIndex++;
      if (queryIndex === query.length) {
        return true;
      }
    }
  }
  return false;
}

export function rankTags(tags: readonly string[], query: string): string[] {
  const normalizedQuery = normalizeTagInput(query);
  const exact: string[] = [];
  const prefix: string[] = [];
  const substring: string[] = [];
  const subsequence: string[] = [];
  const alphabetical: string[] = [];

  for (const tag of [...new Set(tags)].toSorted()) {
    if (!normalizedQuery) {
      alphabetical.push(tag);
    } else if (tag === normalizedQuery) {
      exact.push(tag);
    } else if (tag.startsWith(normalizedQuery)) {
      prefix.push(tag);
    } else if (tag.includes(normalizedQuery)) {
      substring.push(tag);
    } else if (isSubsequenceMatch(tag, normalizedQuery)) {
      subsequence.push(tag);
    }
  }

  return normalizedQuery ? [...exact, ...prefix, ...substring, ...subsequence] : alphabetical;
}

function isActiveTarget(target: InputTarget): boolean {
  return target.inputEl.isConnected && document.activeElement === target.inputEl;
}

function updateSelection(index: number) {
  if (!autocompleteEl) {
    return;
  }
  const items = autocompleteEl.children;
  for (let i = 0; i < items.length; i++) {
    items[i]!.classList.toggle("selected", i === index);
  }
  items[index]?.scrollIntoView({ block: "nearest" });
}

function applyTag(target: InputTarget, tag: string) {
  target.inputEl.value = "";
  hideTagAutocomplete();
  target.onSelect(tag);
  target.inputEl.focus();
}

async function showDropdown(target: InputTarget, query: string, currentRequestId: number) {
  if (!allTags) {
    try {
      allTags = await listTags();
    } catch {
      if (currentRequestId === requestId) {
        clearDropdown();
      }
      return;
    }
  }
  if (currentRequestId !== requestId || !isActiveTarget(target)) {
    return;
  }

  const availableTags = allTags.filter((tag) => !target.selectedTags.includes(tag));
  const normalizedQuery = normalizeTagInput(query);
  const items: Item[] = rankTags(availableTags, normalizedQuery)
    .slice(0, TAG_AUTOCOMPLETE_MAX_RESULTS)
    .map((tag) => ({ kind: "existing", tag, label: `#${tag}` }));
  if (normalizedQuery && !items.some((item) => item.tag === normalizedQuery)) {
    items.push({ kind: "create", tag: normalizedQuery, label: `Create #${normalizedQuery}` });
  }
  if (items.length === 0) {
    clearDropdown();
    return;
  }

  clearDropdown();
  autocompleteEl = document.createElement("div");
  autocompleteEl.className = "autocomplete";
  const rect = target.inputEl.getBoundingClientRect();
  autocompleteEl.style.left = `${rect.left}px`;
  autocompleteEl.style.top = `${rect.bottom + TAG_AUTOCOMPLETE_OFFSET_PX}px`;
  autocompleteEl.style.minWidth = `${Math.max(rect.width, TAG_AUTOCOMPLETE_MIN_WIDTH_PX)}px`;

  let selectedIndex = 0;
  for (const [index, item] of items.entries()) {
    const el = document.createElement("div");
    el.className = `autocomplete-item${index === 0 ? " selected" : ""}`;
    el.textContent = item.label;
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
    });
    el.onclick = () => applyTag(target, item.tag);
    autocompleteEl.append(el);
  }
  document.body.append(autocompleteEl);

  activePointerHandler = (e: MouseEvent) => {
    const clickTarget = e.target;
    if (
      clickTarget instanceof Node &&
      (target.inputEl.contains(clickTarget) || autocompleteEl?.contains(clickTarget))
    ) {
      return;
    }
    hideTagAutocomplete();
  };
  document.addEventListener("mousedown", activePointerHandler, true);

  activeKeyHandler = (e: KeyboardEvent) => {
    if (!autocompleteEl || document.activeElement !== target.inputEl) {
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      selectedIndex = (selectedIndex + 1) % items.length;
      updateSelection(selectedIndex);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      selectedIndex = (selectedIndex - 1 + items.length) % items.length;
      updateSelection(selectedIndex);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      const item = items[selectedIndex];
      if (item) {
        applyTag(target, item.tag);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      hideTagAutocomplete();
    }
  };
  document.addEventListener("keydown", activeKeyHandler, true);
}

export function checkTagInput(
  inputEl: HTMLInputElement,
  selectedTags: readonly string[],
  onSelect: TagSelection,
) {
  if (document.activeElement !== inputEl) {
    hideTagAutocomplete();
    return;
  }

  const currentRequestId = ++requestId;
  void showDropdown(
    {
      inputEl,
      selectedTags,
      onSelect,
    },
    inputEl.value,
    currentRequestId,
  );
}
