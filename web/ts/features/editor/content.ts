import type { EditorAdapter } from "../../editor-adapter.ts";
import { splitFrontmatter } from "../../frontmatter.ts";

type LoadEditorContentOptions = {
  handle: EditorAdapter | null;
  markdown: string;
  explicitOffset?: number;
  setTags: (tags: readonly string[]) => void;
};

export function loadEditorContent(opts: Readonly<LoadEditorContentOptions>): void {
  const { handle, markdown, explicitOffset, setTags } = opts;
  if (!handle) {
    return;
  }

  const parsed = splitFrontmatter(markdown);
  if (handle.isSourceMode) {
    const position = handle.sourceEl.selectionStart;
    handle.sourceEl.value = markdown;
    handle.sourceEl.selectionStart = position;
    handle.sourceEl.selectionEnd = position;
  } else {
    const focused =
      handle.contentEl === document.activeElement ||
      handle.contentEl.contains(document.activeElement);
    const offset = explicitOffset ?? (focused ? handle.getCursorOffset() : -1);
    if (offset >= 0) {
      handle.setValue(parsed.body, offset);
      if (explicitOffset !== undefined) {
        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0) {
          const range = selection.getRangeAt(0);
          const node =
            range.startContainer instanceof Element
              ? range.startContainer
              : range.startContainer.parentElement;
          node?.scrollIntoView({ block: "center", behavior: "instant" });
        }
      }
    } else {
      handle.setValue(parsed.body);
    }
  }

  if (parsed.hasFrontmatter) {
    setTags(parsed.tags);
  }
}
