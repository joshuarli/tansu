import { createEditor, type EditorHandle, escapeHtml, stemFromPath } from "@joshuarli98/md-wysiwyg";

import { uploadImage } from "./api.ts";
import { editorExtensions } from "./editor-config.ts";

export type EditorAdapter = {
  readonly contentEl: HTMLElement;
  readonly sourceEl: HTMLTextAreaElement;
  readonly isSourceMode: boolean;
  setValue(markdown: string, offset?: number): void;
  getValue(): string;
  getCursorOffset(): number;
  toggleSourceMode(): void;
  applyFormat(
    transform: (
      md: string,
      selStart: number,
      selEnd: number,
    ) => {
      md: string;
      selStart: number;
      selEnd: number;
    },
  ): void;
  focus(): void;
  destroy(): void;
  setConfig(config: { undoStackMax: number }): void;
};

function buildImageFilename(path: string | null): string {
  const now = new Date();
  const ts =
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0") +
    String(now.getHours()).padStart(2, "0") +
    String(now.getMinutes()).padStart(2, "0") +
    String(now.getSeconds()).padStart(2, "0");
  const noteName = path ? stemFromPath(path) : "image";
  return `${noteName} ${ts}.webp`;
}

export function createEditorAdapter(
  mountEl: HTMLElement,
  opts: {
    undoStackMax: number;
    getCurrentPath: () => string | null;
    onChange: () => void;
    onSave: () => void;
  },
): EditorAdapter {
  const handle: EditorHandle = createEditor(mountEl, {
    extensions: editorExtensions,
    onChange: opts.onChange,
    onSave: opts.onSave,
    contentClassName: "editor-content",
    sourceClassName: "editor-source",
    undoStackMax: opts.undoStackMax,
    onImagePaste: async (blob) => {
      try {
        const savedName = await uploadImage(blob, buildImageFilename(opts.getCurrentPath()));
        const src = `/z-images/${encodeURIComponent(savedName)}`;
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(savedName)}" data-wiki-image="${escapeHtml(savedName)}" loading="lazy">`;
      } catch {
        return null;
      }
    },
  });

  return {
    get contentEl() {
      return handle.contentEl;
    },
    get sourceEl() {
      return handle.sourceEl;
    },
    get isSourceMode() {
      return handle.isSourceMode;
    },
    setValue(markdown, offset) {
      handle.setValue(markdown, offset);
    },
    getValue() {
      return handle.getValue();
    },
    getCursorOffset() {
      return handle.getCursorOffset();
    },
    toggleSourceMode() {
      handle.toggleSourceMode();
    },
    applyFormat(transform) {
      handle.applyFormat(transform);
    },
    focus() {
      handle.focus();
    },
    destroy() {
      handle.destroy();
    },
    setConfig(config) {
      handle.setConfig(config);
    },
  };
}
