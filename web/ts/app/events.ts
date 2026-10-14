import type { NoteId, RevisionEventId } from "../state.ts";
import type { LocalDraftId, VaultId } from "./identity.ts";
import type { TabIdentity } from "./tab-identity.ts";

export type CommandId =
  | "open"
  | "create"
  | "save"
  | "rename"
  | "delete"
  | "pin"
  | "reopen"
  | "reading"
  | "search"
  | "import"
  | "revisions"
  | "settings"
  | "source";

export type CommandItem = {
  id: CommandId;
  label: string;
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
