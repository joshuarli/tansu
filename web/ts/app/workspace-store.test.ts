import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ClientStorageFailureError,
  DraftJournal,
  createWorkspaceId,
  createDraftCheckpointClearer,
  createDraftCheckpointWriter,
  createTitleDraftCheckpointClearer,
  decodeDraftJournalRecord,
  decodeLocalDraftJournalRecord,
  decodeWorkspaceState,
  getCachedNoteBody,
  type DraftJournalRecord,
  type LocalDraftJournalRecord,
} from "./workspace-store.ts";
import { localDraftId, noteId, serverInstanceId, vaultId, workspaceId, type LocalDraftId, type NoteId } from "./identity.ts";

describe("private workspace storage", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keys state by versioned server, vault, note, and workspace identity", () => {
    const state = decodeWorkspaceState({
      formatVersion: 1,
      serverInstanceId: "server-1",
      vaultId: "vault-1",
      workspaceId: "workspace-1",
      tabs: [{
        noteId: "note-1",
        title: "One",
        path: "one.md",
        selection: { anchor: 2, head: 2 },
        scrollTop: 0,
        mode: "live",
      }],
      activeNoteId: "note-1",
      closedTabs: [],
      pinnedNoteIds: ["note-1"],
      recentNoteIds: ["note-1"],
      searchHistory: ["needle"],
      legacySessionImported: true,
      savedAtMs: 3,
    });

    expect(at(state.tabs, 0)).toMatchObject({ kind: "saved", noteId: "note-1" });
    expect(state.activeTab).toStrictEqual({ kind: "saved", noteId: "note-1" });
    expect(decodeWorkspaceState({
      ...state,
      activeTab: { kind: "local-draft", localDraftId: "local-1" },
      tabs: [{
        kind: "local-draft",
        localDraftId: "local-1",
        title: "Unsaved",
        path: "",
        selection: null,
        scrollTop: 0,
        mode: "live",
      }],
    }).tabs).toStrictEqual([{
      kind: "local-draft",
      localDraftId: localDraftId("local-1"),
      title: "Unsaved",
      path: "",
      selection: null,
      scrollTop: 0,
      mode: "live",
    }]);
    expect(decodeWorkspaceState({
      ...state,
      activeTab: { kind: "local-draft", localDraftId: "local-1" },
    }).activeTab).toStrictEqual({ kind: "local-draft", localDraftId: localDraftId("local-1") });
    expect(() => decodeWorkspaceState({ ...state, formatVersion: 2 })).toThrow(ClientStorageFailureError);
    expect(() => decodeWorkspaceState({ ...state, savedAtMs: Number.MAX_SAFE_INTEGER + 1 })).toThrow(ClientStorageFailureError);
  });

  it("reuses the persisted browser workspace identity", () => {
    const storage = memoryStorage();
    const first = createWorkspaceId(storage);

    expect(createWorkspaceId(storage)).toBe(first);
  });

  it("validates a draft record before it enters the journal", () => {
    const valid = draftRecord(1, "# Draft\n");

    expect(decodeDraftJournalRecord(valid)).toStrictEqual(valid);
    expect(decodeDraftJournalRecord({
      ...valid,
      titleRevision: 2,
      titleMutationId: "title-mutation-2",
    })).toStrictEqual({
      ...valid,
      titleRevision: 2,
      titleMutationId: "title-mutation-2",
    });
    expect(decodeDraftJournalRecord({
      ...valid,
      baseSourceHash: hash("a", "sha256-v2:"),
      baseDiskHash: hash("a", "sha256:"),
    })).toMatchObject({ baseSourceHash: expect.stringMatching(/^sha256-v2:/), baseDiskHash: expect.stringMatching(/^sha256:/) });
    expect(() => decodeDraftJournalRecord({ ...valid, baseSourceHash: "sha256:old" })).toThrow(ClientStorageFailureError);
    expect(() => decodeDraftJournalRecord({ ...valid, selection: { anchor: 99, head: 99 } })).toThrow(ClientStorageFailureError);
    expect(() => decodeDraftJournalRecord({ ...valid, titleRevision: -1 })).toThrow(ClientStorageFailureError);
    expect(() => decodeDraftJournalRecord({ ...valid, titleMutationId: "" })).toThrow(ClientStorageFailureError);
  });

  it("decodes local draft records at their versioned boundary", () => {
    const valid = localDraftRecord(1, "# Local draft\n");

    expect(decodeLocalDraftJournalRecord(valid)).toStrictEqual(valid);
    const old = { ...valid } as Omit<LocalDraftJournalRecord, "promotionPending"> & { promotionPending?: boolean };
    delete old.promotionPending;
    expect(decodeLocalDraftJournalRecord(old).promotionPending).toBeFalsy();
    expect(() => decodeDraftJournalRecord(valid)).toThrow(ClientStorageFailureError);
    expect(() => decodeLocalDraftJournalRecord({ ...valid, kind: "saved" })).toThrow(ClientStorageFailureError);
    expect(() => decodeLocalDraftJournalRecord({ ...valid, noteId: "different-key" })).toThrow(ClientStorageFailureError);
    expect(() => decodeLocalDraftJournalRecord({ ...valid, selection: { anchor: 99, head: 99 } })).toThrow(ClientStorageFailureError);
  });

  it("keeps local draft IDs separate from saved note IDs", async () => {
    const savedWrites: DraftJournalRecord[] = [];
    const localWrites: LocalDraftJournalRecord[] = [];
    const journal = new DraftJournal(
      () => {},
      200,
      async (record) => {
        savedWrites.push(record);
        return true;
      },
      undefined,
      async (record) => {
        localWrites.push(record);
        return true;
      },
    );
    const saved = draftRecord(1, "# Saved\n");
    const local = localDraftRecord(1, "# Local\n", "note-1");
    const localIdIsNotANoteId: IsAssignable<LocalDraftId, NoteId> = false;

    await journal.checkpoint(saved);
    await journal.checkpointLocal(local);

    expect(localIdIsNotANoteId).toBeFalsy();
    expect(savedWrites).toStrictEqual([saved]);
    expect(localWrites).toStrictEqual([local]);
  });

  it("clears only the matching saved title version and keeps body data", async () => {
    vi.useFakeTimers();
    const writes: DraftJournalRecord[] = [];
    const clearStoredTitle = vi.fn(async () => false);
    const journal = new DraftJournal(
      () => {},
      200,
      async (record) => {
        writes.push(record);
        return true;
      },
      undefined,
      undefined,
      clearStoredTitle,
    );
    const identity = {
      serverInstanceId: serverInstanceId("server-1"),
      vaultId: vaultId("vault-1"),
      noteId: noteId("note-1"),
    };
    const clearTitle = createTitleDraftCheckpointClearer(journal, workspaceId("workspace-1"));
    const accepted = {
      ...draftRecord(1, "# Saved body\n"),
      titleRevision: 3,
      titleMutationId: "title-mutation-3",
      titleDraft: "Accepted title",
    };
    journal.schedule(accepted);

    await expect(clearTitle(identity, 3, "other-mutation")).resolves.toBeFalsy();
    await expect(clearTitle(identity, 3, "title-mutation-3")).resolves.toBeTruthy();
    expect(writes).toStrictEqual([{ ...accepted, titleDraft: null }]);
    expect(at(writes, 0).source).toBe("# Saved body\n");
    expect(clearStoredTitle).not.toHaveBeenCalled();

    const newer = {
      ...draftRecord(2, "# Newer body\n"),
      titleRevision: 4,
      titleMutationId: "title-mutation-4",
      titleDraft: "Newer title",
    };
    journal.schedule(newer);
    await expect(clearTitle(identity, 3, "title-mutation-3")).resolves.toBeFalsy();
    await vi.advanceTimersByTimeAsync(200);
    expect(writes).toStrictEqual([{ ...accepted, titleDraft: null }, newer]);
  });

  it("coalesces typing checkpoints to the newest complete source", async () => {
    vi.useFakeTimers();
    const writes: DraftJournalRecord[] = [];
    const journal = new DraftJournal(
      () => {},
      200,
      async (record) => {
        writes.push(record);
        return true;
      },
    );
    const writeCheckpoint = createDraftCheckpointWriter(journal);
    writeCheckpoint(draftRecord(1, "# First\n"), "typing", () => {});
    writeCheckpoint(draftRecord(2, "# Latest\n"), "typing", () => {});

    await vi.advanceTimersByTimeAsync(200);
    await journal.flushAll();

    expect(writes).toHaveLength(1);
    expect(at(writes, 0).source).toBe("# Latest\n");
    await writeCheckpoint(draftRecord(3, "# Structural\n"), "structural", () => {});
    expect(writes).toHaveLength(2);
    expect(at(writes, 1).source).toBe("# Structural\n");
  });

  it("clears only an accepted revision and keeps a newer pending checkpoint", async () => {
    vi.useFakeTimers();
    const writes: DraftJournalRecord[] = [];
    const clears: Array<{ noteId: string; revision: number; mutationId: string }> = [];
    const journal = new DraftJournal(
      () => {},
      200,
      async (record) => {
        writes.push(record);
        return true;
      },
      async (_identity, _workspace, noteId, revision, mutationId) => {
        clears.push({ noteId, revision, mutationId });
        return true;
      },
    );
    const clearCheckpoint = createDraftCheckpointClearer(journal, workspaceId("workspace-1"));
    const writeCheckpoint = createDraftCheckpointWriter(journal);
    const first = draftRecord(1, "# First\n");
    writeCheckpoint(first, "typing", () => {});

    await expect(clearCheckpoint({
      serverInstanceId: serverInstanceId("server-1"),
      vaultId: vaultId("vault-1"),
      noteId: noteId("note-1"),
    }, first.localRevision, first.mutationId)).resolves.toBeTruthy();
    expect(clears).toStrictEqual([{ noteId: "note-1", revision: 1, mutationId: "mutation-1" }]);

    const newer = draftRecord(2, "# Newer\n");
    writeCheckpoint(newer, "typing", () => {});
    await expect(clearCheckpoint({
      serverInstanceId: serverInstanceId("server-1"),
      vaultId: vaultId("vault-1"),
      noteId: noteId("note-1"),
    }, first.localRevision, first.mutationId)).resolves.toBeFalsy();
    await vi.advanceTimersByTimeAsync(200);
    expect(writes).toStrictEqual([newer]);
    await expect(clearCheckpoint({
      serverInstanceId: serverInstanceId("server-1"),
      vaultId: vaultId("vault-1"),
      noteId: noteId("note-1"),
    }, newer.localRevision, newer.mutationId)).resolves.toBeTruthy();
  });

  it("reports IndexedDB unavailability instead of silently replacing persistent state", async () => {
    vi.stubGlobal("indexedDB", undefined);

    await expect(getCachedNoteBody({
      serverInstanceId: serverInstanceId("server-1"),
      vaultId: vaultId("vault-1"),
      noteId: noteId("note-1"),
    }, { noteId: "note-1", sourceHash: hash("a") })).rejects.toMatchObject({
      name: "ClientStorageFailureError",
      kind: "unavailable",
    });
  });
});

function draftRecord(baseRevision: number, source: string): DraftJournalRecord {
  return {
    formatVersion: 1,
    serverInstanceId: "server-1",
    vaultId: "vault-1",
    workspaceId: "workspace-1",
    noteId: "note-1",
    baseRevision,
    baseSourceHash: hash(String(baseRevision)),
    baseDiskHash: hash(String(baseRevision), "blake3-v2:"),
    localRevision: baseRevision,
    mutationId: `mutation-${baseRevision}`,
    source,
    titleDraft: null,
    selection: { anchor: 2, head: 2 },
    checkpointedAtMs: 3,
  };
}

function localDraftRecord(
  localRevision: number,
  source: string,
  value = "local-1",
): LocalDraftJournalRecord {
  return {
    formatVersion: 2,
    kind: "local",
    serverInstanceId: "server-1",
    vaultId: "vault-1",
    workspaceId: "workspace-1",
    localDraftId: localDraftId(value),
    localRevision,
    mutationId: `mutation-${localRevision}`,
    source,
    titleDraft: `Recovered ${localRevision}`,
    promotionPending: false,
    selection: { anchor: 2, head: 2 },
    checkpointedAtMs: 3,
  };
}

type IsAssignable<Source, Target> = [Source] extends [Target] ? true : false;

function hash(
  value: string,
  prefix: "blake3-v2:" | "blake3-v3:" | "sha256:" | "sha256-v2:" = "blake3-v3:",
): string {
  return `${prefix}${value.charCodeAt(0).toString(16).padStart(64, "0")}`;
}

function at<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`Missing item at index ${index}`);
  }
  return item;
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}
