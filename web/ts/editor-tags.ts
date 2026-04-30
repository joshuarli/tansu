import { splitFrontmatter, withFrontmatter } from "./frontmatter.ts";
import {
  checkTagInput,
  hideTagAutocomplete,
  normalizeTagInput,
  rememberTags,
} from "./tag-autocomplete.ts";

export type TagState = {
  tags(): string[];
  setTags(tags: readonly string[]): void;
  getCurrentContent(): string;
  syncSourceFromTags(): void;
  handleTagSelected(tag: string): void;
  renderTagRow(): void;
};

type TagStateOptions = {
  getHandle: () => {
    isSourceMode: boolean;
    sourceEl: HTMLTextAreaElement;
    getValue(): string;
  } | null;
  getTagInputEl: () => HTMLInputElement | null;
  setTagsView: (tags: readonly string[]) => void;
  onMutation: () => void;
};

export function createTagState(opts: Readonly<TagStateOptions>): TagState {
  let currentTags: string[] = [];
  let tagInputEl: HTMLInputElement | null = null;

  function getTags() {
    return [...currentTags];
  }

  function renderTagRow() {
    opts.setTagsView(currentTags);
    tagInputEl = opts.getTagInputEl();
    if (!tagInputEl) {
      return;
    }

    tagInputEl.onfocus = () => {
      if (tagInputEl) {
        checkTagInput(tagInputEl, currentTags, handleTagSelected);
      }
    };
    tagInputEl.oninput = () => {
      if (!tagInputEl) {
        return;
      }
      const normalized = normalizeTagInput(tagInputEl.value);
      if (tagInputEl.value !== normalized) {
        tagInputEl.value = normalized;
      }
      checkTagInput(tagInputEl, currentTags, handleTagSelected);
    };
    tagInputEl.onblur = () => {
      setTimeout(() => {
        if (document.activeElement !== tagInputEl) {
          hideTagAutocomplete();
        }
      }, 0);
    };
    tagInputEl.onkeydown = (e) => {
      if (!tagInputEl) {
        return;
      }
      if (e.key === "Backspace" && tagInputEl.value === "" && currentTags.length > 0) {
        e.preventDefault();
        hideTagAutocomplete();
        currentTags = currentTags.slice(0, -1);
        renderTagRow();
        syncSourceFromTags();
        opts.onMutation();
        tagInputEl.focus();
      }
    };
  }

  function setTags(nextTags: readonly string[]) {
    currentTags = [...nextTags];
    renderTagRow();
  }

  function syncSourceFromTags() {
    const handle = opts.getHandle();
    if (!handle || !handle.isSourceMode) {
      return;
    }
    const parsed = splitFrontmatter(handle.sourceEl.value);
    const body = parsed.hasFrontmatter ? parsed.body : handle.sourceEl.value;
    handle.sourceEl.value = withFrontmatter(body, currentTags);
  }

  function handleTagSelected(tag: string) {
    rememberTags([tag]);
    if (!currentTags.includes(tag)) {
      currentTags = [...currentTags, tag].toSorted();
      renderTagRow();
    }
    syncSourceFromTags();
    opts.onMutation();
    tagInputEl?.focus();
  }

  function getCurrentContent() {
    const handle = opts.getHandle();
    if (!handle) {
      return "";
    }
    if (handle.isSourceMode) {
      const parsed = splitFrontmatter(handle.sourceEl.value);
      if (parsed.hasFrontmatter) {
        const changed =
          currentTags.length !== parsed.tags.length ||
          currentTags.some((tag, i) => tag !== parsed.tags[i]);
        if (changed) {
          currentTags = [...parsed.tags];
          renderTagRow();
        }
      }
      return handle.sourceEl.value;
    }
    return withFrontmatter(handle.getValue(), currentTags);
  }

  return {
    tags: getTags,
    setTags,
    getCurrentContent,
    syncSourceFromTags,
    handleTagSelected,
    renderTagRow,
  };
}
