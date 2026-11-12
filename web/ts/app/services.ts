import { createCodeMirrorEditor, type EditorHandle } from "../editor/codemirror-adapter.ts";
import type { EditorConfig } from "../editor/tansu-extensions.ts";
import {
  cacheNoteBody,
  clearDraftCheckpoint,
  clearTitleDraftCheckpoint,
  createWorkspaceId,
  deleteCachedNoteBodies,
  DraftJournal,
  getCachedNoteBody,
  getDraftCheckpoint,
  getLocalDraftCheckpoint,
  getWorkspaceState,
  getOrCreateWorkspace,
  promoteLocalDraftCheckpoint,
  saveWorkspaceState,
  writeDraftCheckpoint,
  writeLocalDraftCheckpoint,
} from "./workspace-store.ts";
import type { WorkspaceWriteGate } from "./workspace-ownership.ts";
import type { WorkspaceId } from "./identity.ts";
import { enrollPasskey, loginWithPasskey } from "./passkeys.ts";
import { createV2ApiClient, type V2ApiClient } from "./v2-api.ts";

export type AppServices = {
  api: V2ApiClient;
  passkeys: {
    login: () => Promise<void>;
    enroll: (capability?: string) => Promise<void>;
    logout: () => Promise<void>;
  };
  editor: {
    createEditor: (container: HTMLElement, config?: EditorConfig) => EditorHandle;
  };
  workspace: {
    createWorkspaceId: () => WorkspaceId;
    createJournal: (onFailure: (error: unknown) => void, gate?: WorkspaceWriteGate) => DraftJournal;
    attachVisibilityFlush: (journal: DraftJournal) => () => void;
    getWorkspaceState: typeof getWorkspaceState;
    saveWorkspaceState: typeof saveWorkspaceState;
    getOrCreateWorkspace: typeof getOrCreateWorkspace;
    getDraftCheckpoint: typeof getDraftCheckpoint;
    getLocalDraftCheckpoint: typeof getLocalDraftCheckpoint;
    promoteLocalDraftCheckpoint: typeof promoteLocalDraftCheckpoint;
    cacheNoteBody: typeof cacheNoteBody;
    deleteCachedNoteBodies: typeof deleteCachedNoteBodies;
    getCachedNoteBody: typeof getCachedNoteBody;
  };
  storage: {
    requestPersistent: () => Promise<boolean>;
  };
};

function gateWrite<Args extends unknown[]>(
  gate: WorkspaceWriteGate | undefined,
  write: (...args: Args) => Promise<boolean>,
): (...args: Args) => Promise<boolean> {
  if (gate === undefined) return write;
  return (...args) => gate.run(() => write(...args), false);
}

const api = createV2ApiClient();

export const defaultServices: AppServices = {
  api,
  passkeys: {
    login: () => loginWithPasskey(api.auth),
    enroll: (capability) => enrollPasskey(api.auth, capability),
    logout: () => api.auth.logout(),
  },
  editor: { createEditor: createCodeMirrorEditor },
  workspace: {
    createWorkspaceId,
    createJournal: (onFailure, gate) => new DraftJournal(
      onFailure,
      200,
      gateWrite(gate, writeDraftCheckpoint),
      gateWrite(gate, clearDraftCheckpoint),
      gateWrite(gate, writeLocalDraftCheckpoint),
      gateWrite(gate, clearTitleDraftCheckpoint),
    ),
    attachVisibilityFlush: (journal) => journal.attachVisibilityFlush(document, window),
    getWorkspaceState,
    saveWorkspaceState,
    getOrCreateWorkspace,
    getDraftCheckpoint,
    getLocalDraftCheckpoint,
    promoteLocalDraftCheckpoint,
    cacheNoteBody,
    deleteCachedNoteBodies,
    getCachedNoteBody,
  },
  storage: {
    requestPersistent: async () => navigator.storage?.persist() ?? false,
  },
};
