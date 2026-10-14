import type { WikiNote } from "./wiki-target.js";

export type EditorExtension =
  | { kind: "wiki-links" }
  | { kind: "wiki-images"; resolveUrl: (name: string) => string | null }
  | { kind: "callouts"; icons: Readonly<Record<string, string>> };

export type EditorConfig = {
  extensions?: readonly EditorExtension[];
  readOnly?: boolean;
  mode?: "live" | "source";
  className?: string;
  currentNotePath?: () => string;
  wikiNotes?: () => readonly WikiNote[];
  onWikiNoteOpen?: (noteId: string) => void;
  onLinkOpen?: (url: string) => void;
  onSave?: () => void;
  onFindRequested?: () => void;
  onChange?: (change: EditorChange) => void;
  uploadPastedImage?: (request: EditorImageUploadRequest) => Promise<EditorImageUploadResult>;
  onImagePasteStateChange?: (state: EditorImagePasteState) => void;
};

export type EditorChange = {
  noteId: string;
  revision: number;
  origin: "userEdit";
};

export type EditorImagePasteSelection = {
  anchor: number;
  head: number;
};

export type EditorImageUploadRequest = {
  image: Blob;
  noteId: string;
  revision: number;
  selection: EditorImagePasteSelection;
  signal: AbortSignal;
};

export type EditorImageUploadResult = {
  name: string;
  markdown: string;
};

type EditorImagePasteContext = {
  uploadId: number;
  noteId: string;
  revision: number;
  selection: EditorImagePasteSelection;
};

export type EditorImagePasteState = EditorImagePasteContext & (
  | { status: "uploading"; previewUrl: string }
  | { status: "inserted" | "stale" }
  | { status: "failed"; message: string }
);

export type WikiImageExtensionOptions = {
  resolveUrl: (name: string) => string | null;
};

export type CalloutExtensionOptions = {
  icons?: Readonly<Record<string, string>>;
};

const DEFAULT_CALLOUT_ICONS: Readonly<Record<string, string>> = {
  note: "📝",
  info: "ℹ️",
  tip: "💡",
  hint: "💡",
  important: "❗",
  warning: "⚠️",
  caution: "⚠️",
  danger: "🚨",
  bug: "🐛",
  example: "📋",
  quote: "🗨️",
  abstract: "📄",
  summary: "📄",
  todo: "✅",
  question: "❓",
  faq: "❓",
  success: "✅",
  check: "✅",
  done: "✅",
  failure: "❌",
  fail: "❌",
  missing: "❌",
};

export function createWikiLinkExtension(): EditorExtension {
  return { kind: "wiki-links" };
}

export function createWikiImageExtension(options: WikiImageExtensionOptions): EditorExtension {
  return { kind: "wiki-images", resolveUrl: options.resolveUrl };
}

export function createCalloutExtension(
  options: CalloutExtensionOptions = {},
): Extract<EditorExtension, { kind: "callouts" }> {
  return {
    kind: "callouts",
    icons: { ...DEFAULT_CALLOUT_ICONS, ...options.icons },
  };
}
