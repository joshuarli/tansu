import type { MarkdownExtension } from "./extension.js";
import {
  renderMarkdown,
  renderMarkdownWithCursor,
  renderMarkdownWithSelection,
} from "./markdown.js";

type EditorRenderer = {
  render(md: string): void;
  renderWithCursor(md: string, offset: number): void;
  renderWithSelection(md: string, selStart: number, selEnd: number): void;
};

export function createEditorRenderer(
  contentEl: HTMLElement,
  extensions: readonly MarkdownExtension[],
): EditorRenderer {
  const renderOpts = { extensions: [...extensions] };

  return {
    render(md) {
      contentEl.innerHTML = renderMarkdown(md, renderOpts);
    },
    renderWithCursor(md, offset) {
      contentEl.innerHTML = renderMarkdownWithCursor(md, offset, renderOpts);
    },
    renderWithSelection(md, selStart, selEnd) {
      contentEl.innerHTML = renderMarkdownWithSelection(md, selStart, selEnd, renderOpts);
    },
  };
}
