import type { LocalDraftId, NoteId } from "./identity.ts";

export type TabIdentity =
  | { kind: "saved"; noteId: NoteId }
  | { kind: "local-draft"; localDraftId: LocalDraftId };

export function toTabKey(identity: TabIdentity): string {
  return identity.kind === "saved"
    ? `saved:${identity.noteId}`
    : `local:${identity.localDraftId}`;
}

export function sameTabIdentity(left: TabIdentity | null, right: TabIdentity | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind === "saved") return right.kind === "saved" && left.noteId === right.noteId;
  return right.kind === "local-draft" && left.localDraftId === right.localDraftId;
}
