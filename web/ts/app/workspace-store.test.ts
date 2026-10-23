import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import {
  ClientStorageFailureError,
  DraftJournal,
  createWorkspaceId,
  cacheNoteBody,
  clearDraftCheckpoint,
  clearTitleDraftCheckpoint,
  deleteCachedNoteBodies,
  decodeDraftJournalRecord,
  decodeLocalDraftJournalRecord,
  decodeWorkspaceState,
  getDraftCheckpoint,
  getLocalDraftCheckpoint,
  getCachedNoteBody,
  getWorkspaceState,
  getOrCreateWorkspace,
  promoteLocalDraftCheckpoint,
  saveWorkspaceState,
  writeDraftCheckpoint,
  writeLocalDraftCheckpoint,
  type DraftJournalRecord,
  type LocalDraftJournalRecord,
  type WorkspaceState,
} from "./workspace-store.ts";
import { localDraftId, noteId, serverInstanceId, vaultId, workspaceId, type LocalDraftId, type NoteId } from "./identity.ts";

describe("private workspace storage", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  });

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
      activeTab: { kind: "saved", noteId: "note-1" },
      closedTabs: [],
      pinnedNoteIds: ["note-1"],
      recentNoteIds: ["note-1"],
      searchHistory: ["needle"],
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
    expect(() => decodeDraftJournalRecord({ ...valid, baseSourceHash: "invalid" })).toThrow(ClientStorageFailureError);
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
    const accepted = {
      ...draftRecord(1, "# Saved body\n"),
      titleRevision: 3,
      titleMutationId: "title-mutation-3",
      titleDraft: "Accepted title",
    };
    journal.schedule(accepted);

    await expect(journal.clearTitleDraftCheckpoint(identity, workspaceId("workspace-1"), identity.noteId, 3, "other-mutation")).resolves.toBeFalsy();
    await expect(journal.clearTitleDraftCheckpoint(identity, workspaceId("workspace-1"), identity.noteId, 3, "title-mutation-3")).resolves.toBeTruthy();
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
    await expect(journal.clearTitleDraftCheckpoint(identity, workspaceId("workspace-1"), identity.noteId, 3, "title-mutation-3")).resolves.toBeFalsy();
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
    journal.schedule(draftRecord(1, "# First\n"));
    journal.schedule(draftRecord(2, "# Latest\n"));

    await vi.advanceTimersByTimeAsync(200);
    await journal.flushAll();

    expect(writes).toHaveLength(1);
    expect(at(writes, 0).source).toBe("# Latest\n");
    await journal.checkpoint(draftRecord(3, "# Structural\n"));
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
    const first = draftRecord(1, "# First\n");
    journal.schedule(first);

    await expect(journal.clearCheckpoint({
      serverInstanceId: serverInstanceId("server-1"),
      vaultId: vaultId("vault-1"),
    }, workspaceId("workspace-1"), noteId("note-1"), first.localRevision, first.mutationId)).resolves.toBeTruthy();
    expect(clears).toStrictEqual([{ noteId: "note-1", revision: 1, mutationId: "mutation-1" }]);

    const newer = draftRecord(2, "# Newer\n");
    journal.schedule(newer);
    await expect(journal.clearCheckpoint({
      serverInstanceId: serverInstanceId("server-1"),
      vaultId: vaultId("vault-1"),
    }, workspaceId("workspace-1"), noteId("note-1"), first.localRevision, first.mutationId)).resolves.toBeFalsy();
    await vi.advanceTimersByTimeAsync(200);
    expect(writes).toStrictEqual([newer]);
    await expect(journal.clearCheckpoint({
      serverInstanceId: serverInstanceId("server-1"),
      vaultId: vaultId("vault-1"),
    }, workspaceId("workspace-1"), noteId("note-1"), newer.localRevision, newer.mutationId)).resolves.toBeTruthy();
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

  it("creates an empty workspace and preserves it after edits", async () => {
    const identity = { serverInstanceId: serverInstanceId("server-1"), vaultId: vaultId("vault-1") };
    const workspace = workspaceId("workspace-1");

    await expect(getWorkspaceState(identity, workspace)).resolves.toBeNull();
    const created = await getOrCreateWorkspace(identity, workspace);

    expect(created).toMatchObject({ tabs: [], activeTab: null, closedTabs: [], pinnedNoteIds: [], recentNoteIds: [] });
    await expect(getWorkspaceState(identity, workspace)).resolves.toMatchObject(created);

    const updated: WorkspaceState = {
      ...created,
      tabs: [{ kind: "saved", noteId: "note-3", title: "Current", path: "three.md", selection: null, scrollTop: 0, mode: "live" }],
      activeTab: { kind: "saved", noteId: "note-3" },
    };
    await saveWorkspaceState(updated);
    await expect(getOrCreateWorkspace(identity, workspace)).resolves.toMatchObject({
      tabs: [{ noteId: "note-3", title: "Current" }],
    });
    await expect(getWorkspaceState(identity, workspace)).resolves.toMatchObject({
      tabs: [{ noteId: "note-3", title: "Current" }],
    });
  });

  it("stores clean note bodies by identity, replaces old hashes, and deletes a vault note's cache", async () => {
    const firstIdentity = documentIdentity("note-1");
    const otherIdentity = documentIdentity("note-2");
    const first = noteDocument("note-1", 1, "First", "one.md", "# First\n");
    const replacement = noteDocument("note-1", 2, "Latest", "one.md", "# Latest\n");
    const other = noteDocument("note-2", 1, "Other", "two.md", "# Other\n");

    await cacheNoteBody(firstIdentity, first);
    await cacheNoteBody(otherIdentity, other);
    await cacheNoteBody(firstIdentity, replacement);

    await expect(getCachedNoteBody(firstIdentity, replacement.meta)).resolves.toMatchObject({
      sourceHash: replacement.meta.sourceHash,
      content: replacement.content,
    });
    await expect(getCachedNoteBody(firstIdentity, first.meta)).resolves.toBeNull();
    await expect(getCachedNoteBody(otherIdentity, other.meta)).resolves.toMatchObject({ content: other.content });

    await deleteCachedNoteBodies(firstIdentity);
    await expect(getCachedNoteBody(firstIdentity, replacement.meta)).resolves.toBeNull();
    await expect(getCachedNoteBody(otherIdentity, other.meta)).resolves.toMatchObject({ content: other.content });
  });

  it("refuses to cache or look up a note under a different note identity", async () => {
    const identity = documentIdentity("note-1");
    const other = noteDocument("note-2", 1, "Other", "two.md", "# Other\n");

    await expect(cacheNoteBody(identity, other)).rejects.toMatchObject({ kind: "corrupt" });
    await expect(getCachedNoteBody(identity, other.meta)).rejects.toMatchObject({ kind: "corrupt" });
  });

  it("prunes the oldest clean body after the cache exceeds its bound", async () => {
    for (let index = 0; index <= 300; index += 1) {
      const id = `note-${String(index).padStart(3, "0")}`;
      const identity = documentIdentity(id);
      await cacheNoteBody(identity, noteDocument(id, 1, id, `${id}.md`, `# ${id}\n`));
    }

    const oldestIdentity = documentIdentity("note-000");
    const newestIdentity = documentIdentity("note-300");
    const oldest = noteDocument("note-000", 1, "note-000", "note-000.md", "# note-000\n");
    const newest = noteDocument("note-300", 1, "note-300", "note-300.md", "# note-300\n");
    await expect(getCachedNoteBody(oldestIdentity, oldest.meta)).resolves.toBeNull();
    await expect(getCachedNoteBody(newestIdentity, newest.meta)).resolves.toMatchObject({ content: newest.content });
  });

  it("keeps the newest saved draft checkpoint and clears only its accepted version", async () => {
    const identity = { serverInstanceId: serverInstanceId("server-1"), vaultId: vaultId("vault-1") };
    const workspace = workspaceId("workspace-1");
    const first = draftRecord(1, "# First\n");
    const newer = draftRecord(2, "# Newer\n");

    await expect(writeDraftCheckpoint(first)).resolves.toBeTruthy();
    await expect(writeDraftCheckpoint(newer)).resolves.toBeTruthy();
    await expect(writeDraftCheckpoint(first)).resolves.toBeFalsy();
    await expect(getDraftCheckpoint(identity, workspace, "note-1")).resolves.toMatchObject({
      localRevision: 2,
      source: "# Newer\n",
    });
    await expect(clearDraftCheckpoint(identity, workspace, "note-1", 1, "mutation-1")).resolves.toBeFalsy();
    await expect(clearDraftCheckpoint(identity, workspace, "note-1", 2, "mutation-2")).resolves.toBeTruthy();
    await expect(getDraftCheckpoint(identity, workspace, "note-1")).resolves.toBeNull();
  });

  it("promotes a local draft into the saved journal and workspace tabs", async () => {
    const identity = documentIdentity("note-1");
    const workspace = workspaceId("workspace-1");
    const local = localDraftRecord(3, "# Unsaved\n");
    const id = localDraftId("local-1");
    const state: WorkspaceState = {
      formatVersion: 1,
      serverInstanceId: identity.serverInstanceId,
      vaultId: identity.vaultId,
      workspaceId: workspace,
      tabs: [{ kind: "local-draft", localDraftId: id, title: "Recovered 3", path: "", selection: { anchor: 2, head: 2 }, scrollTop: 0, mode: "live" }],
      activeTab: { kind: "local-draft", localDraftId: id },
      closedTabs: [],
      pinnedNoteIds: [],
      recentNoteIds: [],
      searchHistory: [],
      savedAtMs: 3,
    };
    const accepted = noteDocument("note-1", 4, "Accepted", "accepted.md", "# Accepted\n");

    await saveWorkspaceState(state);
    await expect(writeLocalDraftCheckpoint(local)).resolves.toBeTruthy();
    await expect(writeLocalDraftCheckpoint({ ...local, localRevision: 2 })).resolves.toBeFalsy();
    const promoted = await promoteLocalDraftCheckpoint(identity, workspace, id, accepted);
    if (promoted === null) throw new Error("Expected local draft promotion");

    expect(promoted).toMatchObject({
      baseRevision: 4,
      source: "# Unsaved\n",
      titleDraft: "Recovered 3",
      titleRevision: 3,
    });
    await expect(getLocalDraftCheckpoint(identity, workspace, id)).resolves.toBeNull();
    await expect(getDraftCheckpoint(identity, workspace, "note-1")).resolves.toMatchObject(promoted);
    await expect(getWorkspaceState(identity, workspace)).resolves.toMatchObject({
      tabs: [{ kind: "saved", noteId: "note-1", title: "Recovered 3", path: "accepted.md" }],
      activeTab: { kind: "saved", noteId: "note-1" },
    });
    await expect(promoteLocalDraftCheckpoint(identity, workspace, id, accepted)).resolves.toBeNull();
  });

  it("retains newer title checkpoints when an older body arrives later", async () => {
    const first = {
      ...draftRecord(2, "# Latest body\n"),
      titleRevision: 5,
      titleMutationId: "title-5",
      titleDraft: "Title five",
    };
    const staleBodyWithNewTitle = {
      ...draftRecord(1, "# Stale body\n"),
      titleRevision: 6,
      titleMutationId: "title-6",
      titleDraft: "Title six",
    };

    await expect(writeDraftCheckpoint(first)).resolves.toBeTruthy();
    await expect(writeDraftCheckpoint(staleBodyWithNewTitle)).resolves.toBeTruthy();
    await expect(getDraftCheckpoint(
      { serverInstanceId: serverInstanceId("server-1"), vaultId: vaultId("vault-1") },
      workspaceId("workspace-1"),
      "note-1",
    )).resolves.toMatchObject({
      localRevision: 2,
      source: "# Latest body\n",
      titleRevision: 6,
      titleDraft: "Title six",
    });
  });

  it("keeps a title draft when a newer body checkpoint has no title revision", async () => {
    const identity = { serverInstanceId: serverInstanceId("server-1"), vaultId: vaultId("vault-1") };
    const workspace = workspaceId("workspace-1");
    const title = {
      ...draftRecord(1, "# First body\n"),
      titleRevision: 5,
      titleMutationId: "title-5",
      titleDraft: "Renamed",
    };

    await writeDraftCheckpoint(title);
    await writeDraftCheckpoint(draftRecord(2, "# New body\n"));

    await expect(getDraftCheckpoint(identity, workspace, "note-1")).resolves.toMatchObject({
      localRevision: 2,
      source: "# New body\n",
      titleRevision: 5,
      titleMutationId: "title-5",
      titleDraft: "Renamed",
    });
  });

  it("rejects title mutations that reuse a revision for different title state", async () => {
    const original = {
      ...draftRecord(1, "# First body\n"),
      titleRevision: 1,
      titleMutationId: "title-1",
      titleDraft: "First title",
    };
    await writeDraftCheckpoint(original);

    await expect(writeDraftCheckpoint({
      ...draftRecord(2, "# New body\n"),
      titleRevision: 1,
      titleMutationId: "other-title-1",
      titleDraft: "Other title",
    })).rejects.toMatchObject({ kind: "corrupt" });
    await expect(writeDraftCheckpoint({
      ...original,
      localRevision: 2,
      mutationId: "mutation-2",
      titleDraft: "Changed without title revision",
    })).rejects.toMatchObject({ kind: "corrupt" });
  });

  it("merges local title recovery without replacing a newer saved body", async () => {
    const identity = documentIdentity("note-1");
    const workspace = workspaceId("workspace-1");
    const id = localDraftId("local-1");
    const accepted = noteDocument("note-1", 4, "Accepted", "accepted.md", "# Accepted\n");
    await writeLocalDraftCheckpoint(localDraftRecord(3, "# Unsaved\n"));
    await writeDraftCheckpoint(draftRecord(9, "# Newer saved draft\n"));

    await expect(promoteLocalDraftCheckpoint(identity, workspace, id, accepted)).resolves.toMatchObject({
      source: "# Newer saved draft\n",
      titleDraft: "Recovered 3",
      titleRevision: 3,
    });
    await expect(getLocalDraftCheckpoint(identity, workspace, id)).resolves.toBeNull();
    await expect(getDraftCheckpoint(identity, workspace, "note-1")).resolves.toMatchObject({
      source: "# Newer saved draft\n",
      titleDraft: "Recovered 3",
    });
  });

  it("rejects persisted workspace records with invalid discriminants and bounded fields", () => {
    const workspace = decodeWorkspaceState({
      formatVersion: 1,
      serverInstanceId: "server-1",
      vaultId: "vault-1",
      workspaceId: "workspace-1",
      tabs: [],
      activeTab: null,
      closedTabs: [],
      pinnedNoteIds: [],
      recentNoteIds: [],
      searchHistory: [],
      savedAtMs: 0,
    });

    expect(() => decodeWorkspaceState({ ...workspace, tabs: Array.from({ length: 501 }, () => ({})) })).toThrow("bounded array");
    expect(() => decodeWorkspaceState({ ...workspace, activeTab: { kind: "other", noteId: "note-1" } })).toThrow("Active workspace tab kind");
    expect(() => decodeWorkspaceState({ ...workspace, tabs: [{ kind: "saved", noteId: "note-1", title: "One", path: "one.md", selection: null, scrollTop: -1, mode: "live" }] })).toThrow("scrollTop");
    expect(() => decodeWorkspaceState({ ...workspace, tabs: [{ kind: "saved", noteId: "note-1", title: "One", path: "one.md", selection: null, scrollTop: 0, mode: "preview" }] })).toThrow("mode is unknown");
    expect(() => decodeWorkspaceState({ ...workspace, tabs: [{ kind: "unknown", noteId: "note-1", title: "One", path: "one.md", selection: null, scrollTop: 0, mode: "live" }] })).toThrow("tab kind is unknown");
    expect(() => decodeWorkspaceState({ ...workspace, searchHistory: Array(101).fill("query") })).toThrow("bounded array");
  });

  it("clears a persisted title only when its revision and mutation identity match", async () => {
    const identity = { serverInstanceId: serverInstanceId("server-1"), vaultId: vaultId("vault-1") };
    const workspace = workspaceId("workspace-1");
    const record = {
      ...draftRecord(1, "# Body stays\n"),
      titleRevision: 3,
      titleMutationId: "title-3",
      titleDraft: "Unsaved title",
    };

    await writeDraftCheckpoint(record);
    await expect(clearTitleDraftCheckpoint(identity, workspace, "note-1", 2, "title-2")).resolves.toBeFalsy();
    await expect(clearTitleDraftCheckpoint(identity, workspace, "note-1", 3, "title-3")).resolves.toBeTruthy();
    await expect(getDraftCheckpoint(identity, workspace, "note-1")).resolves.toMatchObject({
      source: "# Body stays\n",
      titleDraft: null,
      titleRevision: 3,
      titleMutationId: "title-3",
    });
  });

  it("uses structural local draft checkpoints immediately and typing checkpoints after debounce", async () => {
    vi.useFakeTimers();
    const writes: LocalDraftJournalRecord[] = [];
    const journal = new DraftJournal(
      () => {},
      200,
      undefined,
      undefined,
      async (record) => {
        writes.push(record);
        return true;
      },
    );
    const failure = () => {};

    expect(journal.scheduleLocal(localDraftRecord(1, "# Typing\n"), failure)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    await journal.checkpointLocal(localDraftRecord(2, "# Structural\n"), failure);

    expect(writes.map((record) => record.source)).toStrictEqual(["# Typing\n", "# Structural\n"]);
  });

  it("reports checkpoint write failures to the record and journal handlers", async () => {
    const failure = new Error("quota exceeded");
    const journalFailure = vi.fn();
    const recordFailure = vi.fn();
    const journal = new DraftJournal(journalFailure, 200, async () => {
      throw failure;
    });

    await expect(journal.checkpoint(draftRecord(1, "# Draft\n"), recordFailure)).rejects.toBe(failure);
    expect(recordFailure).toHaveBeenCalledWith(failure);
    expect(journalFailure).toHaveBeenCalledWith(failure);
  });

  it("flushes scheduled checkpoints when the page becomes hidden and detaches listeners", async () => {
    const writes: DraftJournalRecord[] = [];
    let finishWrite: (() => void) | undefined;
    const flushed = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    const journal = new DraftJournal(() => {}, 60_000, async (record) => {
      writes.push(record);
      finishWrite?.();
      return true;
    });
    const detach = journal.attachVisibilityFlush(document, window);
    journal.schedule(draftRecord(1, "# Hidden\n"));
    const visibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    await flushed;
    detach();
    window.dispatchEvent(new Event("pagehide"));
    await journal.dispose();
    if (visibilityState === undefined) delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
    else Object.defineProperty(document, "visibilityState", visibilityState);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.source).toBe("# Hidden\n");
  });

  it("drains checkpoints scheduled while an earlier write is still in flight", async () => {
    vi.useFakeTimers();
    const writes: DraftJournalRecord[] = [];
    let startFirstWrite = () => {};
    const firstWriteStarted = new Promise<void>((resolve) => {
      startFirstWrite = resolve;
    });
    let finishFirstWrite = () => {};
    const firstWrite = new Promise<void>((resolve) => {
      finishFirstWrite = resolve;
    });
    const journal = new DraftJournal(() => {}, 200, async (record) => {
      writes.push(record);
      if (record.localRevision === 1) {
        startFirstWrite();
        await firstWrite;
      }
      return true;
    });
    journal.schedule(draftRecord(1, "# First\n"));
    const disposing = journal.dispose();
    await firstWriteStarted;
    journal.schedule(draftRecord(2, "# Latest\n"));
    finishFirstWrite();
    await disposing;

    expect(writes.map((record) => record.source)).toStrictEqual(["# First\n", "# Latest\n"]);
  });
});

function documentIdentity(id: string) {
  return {
    serverInstanceId: serverInstanceId("server-1"),
    vaultId: vaultId("vault-1"),
    noteId: noteId(id),
  };
}

function noteDocument(noteIdValue: string, revision: number, title: string, path: string, content: string) {
  return {
    meta: {
      noteId: noteIdValue,
      path,
      title,
      tags: [],
      revision,
      sourceHash: hash(`${revision}:${content}`),
      diskHash: hash(content, "blake3-v2:"),
      sourceHashFormatVersion: 3,
      diskHashFormatVersion: 2,
      updatedAtMs: revision,
    },
    content,
  };
}

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
  prefix: "blake3-v2:" | "blake3-v3:" = "blake3-v3:",
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
