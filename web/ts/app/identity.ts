declare const identityBrand: unique symbol;

type IdentityValue<Name extends string> = string & { readonly [identityBrand]: Name };

export type ServerInstanceId = IdentityValue<"ServerInstanceId">;
export type VaultId = IdentityValue<"VaultId">;
export type WorkspaceId = IdentityValue<"WorkspaceId">;
export type NoteId = IdentityValue<"NoteId">;
export type LocalDraftId = IdentityValue<"LocalDraftId">;

export type ServerIdentity = {
  serverInstanceId: ServerInstanceId;
  vaultId: VaultId;
};

export type DocumentIdentity = ServerIdentity & {
  noteId: NoteId;
};

export function serverInstanceId(value: string): ServerInstanceId {
  return nonEmptyIdentity(value, "server instance") as ServerInstanceId;
}

export function vaultId(value: string): VaultId {
  return nonEmptyIdentity(value, "vault") as VaultId;
}

export function workspaceId(value: string): WorkspaceId {
  return nonEmptyIdentity(value, "workspace") as WorkspaceId;
}

export function noteId(value: string): NoteId {
  return nonEmptyIdentity(value, "note") as NoteId;
}

export function localDraftId(value: string): LocalDraftId {
  return nonEmptyIdentity(value, "local draft") as LocalDraftId;
}

export function documentIdentityKey(identity: DocumentIdentity): string {
  return JSON.stringify([
    "document-v1",
    identity.serverInstanceId,
    identity.vaultId,
    identity.noteId,
  ]);
}

function nonEmptyIdentity(value: string, name: string): string {
  if (value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${name} identity must be non-empty and trimmed`);
  }
  return value;
}
