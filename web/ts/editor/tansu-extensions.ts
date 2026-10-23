import type { WikiNote } from "./wiki-target.js";
import type { OutlineHeading } from "./source-navigation.js";

export type EditorConfig = {
  wikiLinks?: boolean;
  resolveAssetUrl?: (name: string) => string | null;
  calloutIcons?: Readonly<Record<string, string>>;
  readOnly?: boolean;
  mode?: "live" | "source";
  undoStackMax?: number;
  imageWebpQuality?: number;
  className?: string;
  noteTitle?: string;
  onNoteTitleCommit?: (request: { title: string; intent: "rename" | "submit" }) => Promise<boolean>;
  currentNotePath?: () => string;
  wikiNotes?: () => readonly WikiNote[];
  onWikiNoteOpen?: (noteId: string) => void;
  loadNotePreview?: (noteId: string, signal: AbortSignal) => Promise<string>;
  onLinkOpen?: (url: string) => void;
  onSave?: () => void;
  onFindRequested?: () => void;
  onActiveHeadingChange?: (heading: OutlineHeading | null) => void;
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
