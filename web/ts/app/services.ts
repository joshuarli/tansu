import { createCodeMirrorEditor, type EditorHandle } from "../editor/codemirror-adapter.ts";
import type { EditorConfig } from "../editor/tansu-extensions.ts";
import { pickHtmlImport } from "../html-import.ts";
import { markNextPaint, markPerformance } from "../performance.ts";
import {
  cacheNoteBody,
  createDraftCheckpointClearer,
  createDraftCheckpointWriter,
  createLocalDraftCheckpointWriter,
  createTitleDraftCheckpointClearer,
  createWorkspaceId,
  deleteCachedNoteBodies,
  DraftJournal,
  getCachedNoteBody,
  getDraftCheckpoint,
  getLocalDraftCheckpoint,
  getWorkspaceState,
  importLegacyWorkspaceOnce,
  promoteLocalDraftCheckpoint,
  saveWorkspaceState,
  type DraftJournalRecord,
  type LocalDraftJournalRecord,
} from "./workspace-store.ts";
import { serverInstanceId, vaultId, type DocumentIdentity, type ServerIdentity, type WorkspaceId } from "./identity.ts";
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
  htmlImport: {
    pickHtmlImport: typeof pickHtmlImport;
  };
  workspace: {
    createWorkspaceId: () => WorkspaceId;
    createJournal: (onFailure: (error: unknown) => void) => DraftJournal;
    attachVisibilityFlush: (journal: DraftJournal) => () => void;
    getWorkspaceState: typeof getWorkspaceState;
    saveWorkspaceState: typeof saveWorkspaceState;
    importLegacyWorkspaceOnce: typeof importLegacyWorkspaceOnce;
    getDraftCheckpoint: typeof getDraftCheckpoint;
    getLocalDraftCheckpoint: typeof getLocalDraftCheckpoint;
    promoteLocalDraftCheckpoint: typeof promoteLocalDraftCheckpoint;
    cacheNoteBody: typeof cacheNoteBody;
    deleteCachedNoteBodies: typeof deleteCachedNoteBodies;
    getCachedNoteBody: typeof getCachedNoteBody;
    checkpointWriter: (journal: DraftJournal) => (
      record: DraftJournalRecord,
      urgency: "typing" | "structural",
      onFailure: (error: unknown) => void,
    ) => undefined | Promise<boolean>;
    checkpointClearer: (journal: DraftJournal, workspaceId: WorkspaceId) => (
      identity: DocumentIdentity,
      revision: number,
      mutationId: string,
    ) => Promise<boolean>;
    titleCheckpointClearer: (journal: DraftJournal, workspaceId: WorkspaceId) => (
      identity: DocumentIdentity,
      revision: number,
      mutationId: string,
    ) => Promise<boolean>;
    localCheckpointWriter: (journal: DraftJournal) => (
      record: LocalDraftJournalRecord,
      urgency: "typing" | "structural",
      onFailure: (error: unknown) => void,
    ) => undefined | Promise<boolean>;
    serverIdentity: (serverInstanceId: string, vaultId: string) => ServerIdentity;
  };
  performance: {
    markNextPaint: typeof markNextPaint;
    markPerformance: typeof markPerformance;
  };
  storage: {
    requestPersistent: () => Promise<boolean>;
  };
};

const api = createV2ApiClient();

export const defaultServices: AppServices = {
  api,
  passkeys: {
    login: () => loginWithPasskey(api.auth),
    enroll: (capability) => enrollPasskey(api.auth, capability),
    logout: () => api.auth.logout(),
  },
  editor: { createEditor: createCodeMirrorEditor },
  htmlImport: { pickHtmlImport },
  workspace: {
    createWorkspaceId,
    createJournal: (onFailure) => new DraftJournal(onFailure),
    attachVisibilityFlush: (journal) => journal.attachVisibilityFlush(document, window),
    getWorkspaceState,
    saveWorkspaceState,
    importLegacyWorkspaceOnce,
    getDraftCheckpoint,
    getLocalDraftCheckpoint,
    promoteLocalDraftCheckpoint,
    cacheNoteBody,
    deleteCachedNoteBodies,
    getCachedNoteBody,
    checkpointWriter: createDraftCheckpointWriter,
    checkpointClearer: createDraftCheckpointClearer,
    titleCheckpointClearer: createTitleDraftCheckpointClearer,
    localCheckpointWriter: createLocalDraftCheckpointWriter,
    serverIdentity: (serverId, vault) => ({
      serverInstanceId: serverInstanceId(serverId),
      vaultId: vaultId(vault),
    }),
  },
  performance: { markNextPaint, markPerformance },
  storage: {
    requestPersistent: async () => navigator.storage?.persist() ?? false,
  },
};
