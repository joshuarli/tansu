import type { NoteId, RevisionEventId } from "../state.ts";
import type { FindMatch, OutlineHeading } from "../editor/source-navigation.js";
import type { V2QuickOpenResponse, V2SearchHit } from "../types.generated.ts";
import type { LocalDraftId, VaultId } from "./identity.ts";
import type { TabIdentity } from "./tab-identity.ts";

export type CommandId =
  | "open"
  | "create"
  | "save"
  | "rename"
  | "delete"
  | "pin"
  | "close"
  | "reopen"
  | "reading"
  | "search"
  | "import"
  | "revisions"
  | "settings"
  | "find"
  | "source";

export type CommandItem = {
  id: CommandId;
  label: string;
  shortcut?: string;
};

export type EditorToolbarCommand =
  | "bold"
  | "italic"
  | "highlight"
  | "strikethrough"
  | "heading"
  | "undo"
  | "redo"
  | "source"
  | "save";

type SettingsFormValue = {
  excludedFoldersText: string;
  autosaveDelayMs: number;
  undoStackMax: number;
  imageWebpQuality: number;
};

export type ViewEvent =
  | { type: "vault.switch"; vaultId: VaultId }
  | { type: "search.input"; query: string }
  | { type: "search.open" }
  | { type: "search.overlayInput"; query: string }
  | { type: "search.overlaySubmit" }
  | { type: "search.historySelect"; query: string }
  | { type: "search.hitOpen"; hit: V2SearchHit }
  | { type: "quickOpen.open" }
  | { type: "quickOpen.input"; query: string }
  | { type: "quickOpen.hitOpen"; hit: V2QuickOpenResponse["hits"][number] }
  | { type: "find.open" }
  | { type: "find.input"; query: string }
  | { type: "find.move"; direction: -1 | 1 }
  | { type: "find.close" }
  | { type: "find.select"; match: FindMatch }
  | { type: "outline.select"; heading: OutlineHeading }
  | { type: "sidebar.toggle" }
  | { type: "outline.toggle" }
  | { type: "auth.login" }
  | { type: "auth.enroll" }
  | { type: "auth.logout" }
  | { type: "auth.capability"; value: string }
  | { type: "storage.persist" }
  | { type: "command.open" }
  | { type: "command.filter"; query: string }
  | { type: "command.run"; id: CommandId }
  | { type: "dialog.input"; value: string }
  | { type: "dialog.submit"; value?: string }
  | { type: "settings.submit"; settings: SettingsFormValue }
  | { type: "overlay.close" }
  | { type: "context.close" }
  | { type: "context.open"; noteId: NoteId; x: number; y: number }
  | { type: "tab.activate"; tab: TabIdentity }
  | { type: "tab.close"; tab: TabIdentity }
  | { type: "note.open"; noteId: NoteId }
  | { type: "note.retry"; noteId: NoteId }
  | { type: "localDraft.open"; localDraftId: LocalDraftId }
  | { type: "note.rename"; noteId?: NoteId }
  | { type: "note.delete"; noteId?: NoteId }
  | { type: "note.pin"; noteId?: NoteId }
  | { type: "note.addTag" }
  | { type: "tags.update"; tags: string[] }
  | { type: "reading.toggle" }
  | { type: "editor.toolbar"; command: EditorToolbarCommand }
  | { type: "revisions.open" }
  | { type: "revisions.select"; eventId: RevisionEventId }
  | { type: "revisions.restore" }
  | { type: "conflict.view" }
  | { type: "conflict.restore" }
  | { type: "draft.export" }
  | { type: "draft.recreate" }
  | { type: "render.request" };
