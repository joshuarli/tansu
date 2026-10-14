import { describe, expect, it, vi } from "vitest";

import type { V2MutationResponse, V2NoteDocument, V2NoteMeta } from "../types.generated.ts";
import { V2ApiError } from "./v2-api.ts";
import {
  DocumentSession,
  InvalidSessionTransitionError,
  type DocumentSessionServices,
  type SaveEnvelope,
} from "./document-session.ts";
import { noteId, serverInstanceId, vaultId, workspaceId } from "./identity.ts";
import type { DraftJournalRecord } from "./workspace-store.ts";

const identity = {
  serverInstanceId: serverInstanceId("server-1"),
  vaultId: vaultId("vault-1"),
  noteId: noteId("note-1"),
};
const workspace = workspaceId("workspace-1");

describe("document sessions", () => {
  it("rejects identity and selection mismatches before leaving the loading state", () => {
    const session = new DocumentSession(identity, 1, workspace, sessionServices());
    const otherDocument = {
      ...document(1, "# One\n", 1),
      meta: { ...metadata(1, "# One\n", 1), noteId: "other-note" },
    };

    expect(() => session.loaded(otherDocument)).toThrow("Loaded document note identity does not match the session");
    expect(() => session.loaded(document(1, "# One\n", 1), { anchor: 20, head: 20 }))
      .toThrow("Selection is outside the current source");
    expect(session.state.status).toBe("loading");

    expect(() => session.recover(document(1, "# One\n", 1), { ...draftRecord(1, "# Draft\n"), workspaceId: "other-workspace" }))
      .toThrow("Recovery identity does not match the document session");
    expect(() => session.recoverUnavailable({ ...draftRecord(1, "# Draft\n"), vaultId: "other-vault" }, new Error("test error"), "One", "one.md"))
      .toThrow("Recovery identity does not match the document session");
  });

  it("keeps clean and dirty edits distinct through auth lock transitions", () => {
    const session = new DocumentSession(identity, 1, workspace, sessionServices());
    session.loaded(document(1, "# One\n", 1), { anchor: 1, head: 1 });
    session.edit("# One\n", { anchor: 2, head: 2 });

    expect(session.state.status).toBe("clean");
    if (session.state.status === "clean") expect(session.state.draft.selection).toStrictEqual({ anchor: 2, head: 2 });

    session.lock();
    expect(() => session.edit("# Locked\n", null)).toThrow(InvalidSessionTransitionError);
    session.unlock();
    expect(session.state.status).toBe("clean");

    session.edit("# Draft\n", { anchor: 3, head: 3 });
    session.lock();
    session.unlock();
    expect(session.state.status).toBe("dirty");
    expect(() => session.loaded(document(2, "# Later\n", 2))).toThrow(InvalidSessionTransitionError);
  });

  it("loads an initially unavailable note when the server becomes reachable", () => {
    const session = new DocumentSession(identity, 1, workspace, sessionServices());
    session.markUnavailable(new Error("connection refused"));

    expect(session.state.status).toBe("unavailable");
    expect(session.reconcile(document(1, "# One\n", 1))).toBe("reloaded");
    expect(session.state.status).toBe("clean");
    if (session.state.status === "clean") expect(session.state.draft.source).toBe("# One\n");
  });

  it("resumes a checkpointed draft when the canonical base is unchanged", () => {
    const session = new DocumentSession(identity, 1, workspace, sessionServices());
    session.loaded(document(1, "# One\n", 1));
    session.edit("# Local draft\n", { anchor: 4, head: 4 });
    session.markUnavailable(new Error("connection refused"));

    expect(session.state.status).toBe("unavailable");
    expect(session.reconcile(document(1, "# One\n", 1))).toBe("unchanged");
    expect(session.state.status).toBe("dirty");
    if (session.state.status === "dirty") expect(session.state.draft.source).toBe("# Local draft\n");
  });

  it("serializes saves and coalesces edits against the acknowledged base", async () => {
    const requests: Array<{
      envelope: SaveEnvelope;
      resolve: (envelope: SaveEnvelope) => void;
    }> = [];
    const services = sessionServices({
      save: vi.fn((documentIdentity, generation, request) =>
        new Promise<SaveEnvelope>((resolve) => {
          requests.push({
            envelope: { identity: documentIdentity, generation, response: accepted(request.mutationId, null) },
            resolve,
          });
        })),
    });
    const session = new DocumentSession(identity, 1, workspace, services);
    session.loaded(document(1, "# One\n", 1));
    session.edit("# First\n", { anchor: 1, head: 1 });

    const saving = session.save();
    await until(() => requests.length === 1);
    session.edit("# Second\n", { anchor: 2, head: 2 });
    const first = at(requests, 0);
    first.resolve({
      ...first.envelope,
      response: accepted(first.envelope.response.mutationId, metadata(2, "# First\n", 2)),
    });
    await until(() => requests.length === 2);

    const second = at(requests, 1);
    expect(second.envelope.response.outcome.state).toBe("accepted");
    expect(services.save).toHaveBeenCalledTimes(2);
    const secondRequest = at(vi.mocked(services.save).mock.calls, 1)[2];
    expect(secondRequest.content).toBe("# Second\n");
    expect(secondRequest.precondition).toMatchObject({ baseRevision: 2 });
    second.resolve({
      ...second.envelope,
      response: accepted(second.envelope.response.mutationId, metadata(3, "# Second\n", 3)),
    });
    await saving;

    expect(session.state.status).toBe("clean");
    if (session.state.status === "clean") {
      expect(session.state.acceptedRevision).toBe(3);
      expect(session.state.draft.source).toBe("# Second\n");
    }
    expect(services.clearCheckpoint).toHaveBeenCalledTimes(1);
    expect(services.clearCheckpoint).toHaveBeenCalledWith(identity, 2, secondRequest.mutationId);
  });

  it("retries an uncertain transient save with the same mutation identity", async () => {
    const requests: string[] = [];
    const waits: number[] = [];
    const services = sessionServices({
      save: vi.fn(async (documentIdentity, generation, request) => {
        requests.push(request.mutationId);
        if (requests.length === 1) {
          throw new V2ApiError("temporary failure", 503, null);
        }
        return {
          identity: documentIdentity,
          generation,
          response: accepted(request.mutationId, metadata(2, "# Draft\n", 2)),
        };
      }),
      wait: vi.fn(async (milliseconds) => {
        waits.push(milliseconds);
      }),
    });
    const session = new DocumentSession(identity, 1, workspace, services);
    session.loaded(document(1, "# One\n", 1));
    session.edit("# Draft\n", { anchor: 3, head: 3 });

    await session.save();

    expect(requests).toHaveLength(2);
    expect(requests[1]).toBe(requests[0]);
    expect(waits).toStrictEqual([250]);
    expect(session.state.status).toBe("clean");
  });

  it("locks on an authentication error and unlocks back to the dirty state", async () => {
    const services = sessionServices({
      save: vi.fn(async () => {
        throw new V2ApiError("Authentication required", 401, { code: "auth_required" });
      }),
    });
    const session = new DocumentSession(identity, 1, workspace, services);
    session.loaded(document(1, "# One\n", 1));
    session.edit("# Draft\n", { anchor: 3, head: 3 });

    await session.save();
    expect(session.state.status).toBe("auth-locked");
    session.unlock();
    expect(session.state.status).toBe("dirty");
  });

  it("preserves canonical content and conflict metadata when a save conflicts", async () => {
    const current = document(2, "# Canonical\n", 2);
    const draft = {
      draftId: 4,
      noteId: identity.noteId,
      baseRevision: 1,
      baseSourceHash: hash(1),
      sourceHash: hash("draft".length),
      createdAtMs: 10,
    };
    const services = sessionServices({
      save: vi.fn(async () => {
        throw new V2ApiError("Save conflict", 409, { code: "save_conflict", current, draft });
      }),
    });
    const session = new DocumentSession(identity, 1, workspace, services);
    session.loaded(document(1, "# One\n", 1));
    session.edit("# Draft\n", { anchor: 3, head: 3 });

    await session.save();

    expect(session.state.status).toBe("conflict");
    if (session.state.status === "conflict") {
      expect(session.state.canonical).toBe(current);
      expect(session.state.conflictDraft).toBe(draft);
      expect(session.state.draft.source).toBe("# Draft\n");
    }
  });

  it("classifies unresolved save failures without retrying", async () => {
    const error = new V2ApiError("Unresolved note", 409, {
      code: "unresolved_note",
      noteId: identity.noteId,
      reason: "missing_snapshot",
    });
    const services = sessionServices({ save: vi.fn(async () => Promise.reject(error)) });
    const session = new DocumentSession(identity, 1, workspace, services);
    session.loaded(document(1, "# One\n", 1));
    session.edit("# Draft\n", { anchor: 3, head: 3 });

    await session.save();

    expect(services.save).toHaveBeenCalledTimes(1);
    expect(session.state).toMatchObject({
      status: "unavailable",
      reason: { kind: "unresolved", error: { code: "unresolved_note", reason: "missing_snapshot" } },
    });
  });

  it("marks a repeatedly failing save as transiently exhausted", async () => {
    const waits: number[] = [];
    const services = sessionServices({
      save: vi.fn(async () => {
        throw new V2ApiError("Server unavailable", 503, null);
      }),
      wait: vi.fn(async (milliseconds) => {
        waits.push(milliseconds);
      }),
    });
    const session = new DocumentSession(identity, 1, workspace, services);
    session.loaded(document(1, "# One\n", 1));
    session.edit("# Draft\n", { anchor: 3, head: 3 });

    await session.save();

    expect(services.save).toHaveBeenCalledTimes(4);
    expect(waits).toStrictEqual([250, 1000, 3000]);
    expect(session.state.status).toBe("unavailable");
    if (session.state.status === "unavailable") {
      expect(session.state.reason.kind).toBe("transient-exhausted");
    }
  });

  it("uses a reconciled canonical base when a save is already in flight", async () => {
    let finishSave: (() => void) | undefined;
    const services = sessionServices({
      save: vi.fn((documentIdentity, generation, request) => new Promise<SaveEnvelope>((resolve) => {
        finishSave = () => resolve({
          identity: documentIdentity,
          generation,
          response: accepted(request.mutationId, metadata(2, request.content, 2)),
        });
      })),
    });
    const session = new DocumentSession(identity, 1, workspace, services);
    session.loaded(document(1, "# One\n", 1));
    session.edit("# Draft\n", { anchor: 3, head: 3 });
    const saving = session.save();
    await until(() => finishSave !== undefined);

    expect(session.reconcile(document(2, "# Draft\n", 2))).toBe("unchanged");
    expect(session.state.status).toBe("saving");
    finishSave?.();
    await saving;

    expect(session.state.status).toBe("clean");
    expect(session.state.acceptedRevision).toBe(2);
  });

  it("propagates accepted-rename checkpoint clearing failures", async () => {
    const services = sessionServices({
      clearTitleCheckpoint: vi.fn(async () => {
        throw new Error("storage blocked");
      }),
    });
    const session = new DocumentSession(identity, 1, workspace, services);
    session.loaded(document(1, "# One\n", 1));
    session.editTitle("Renamed");
    const titleState = session.state;
    if (!("titleMutationId" in titleState) || titleState.titleMutationId === null) {
      throw new Error("Rename did not produce a title mutation identity");
    }

    await expect(session.acceptRename(
      { ...metadata(2, "# One\n", 2), title: "Renamed", path: "renamed.md" },
      titleState.titleRevision,
      titleState.titleMutationId,
    )).rejects.toThrow("storage blocked");

    expect(services.clearTitleCheckpoint).toHaveBeenCalledWith(
      identity,
      titleState.titleRevision,
      titleState.titleMutationId,
    );
    expect(session.state.status).toBe("clean");
    if (session.state.status === "clean") {
      expect(session.state.title).toBe("Renamed");
      expect(session.state.titleDraft).toBeNull();
    }
  });

  it("does not start a save for content that changed while its hash was pending", async () => {
    let resolveHash: ((hash: string) => void) | undefined;
    const hashSource = vi.fn((source: string) => source === "# First\n"
      ? new Promise<string>((resolve) => {
        resolveHash = resolve;
      })
      : Promise.resolve(hash(source.length)));
    const services = sessionServices({ sourceHash: hashSource });
    const session = new DocumentSession(identity, 1, workspace, services);
    session.loaded(document(1, "# One\n", 1));
    session.edit("# First\n", { anchor: 1, head: 1 });
    const saving = session.save();
    await until(() => resolveHash !== undefined);
    session.edit("# Latest\n", { anchor: 2, head: 2 });
    resolveHash?.(hash("first".length));
    await saving;

    expect(services.save).toHaveBeenCalledTimes(1);
    expect(at(vi.mocked(services.save).mock.calls, 0)[2].content).toBe("# Latest\n");
    expect(session.state.status).toBe("clean");
  });

  it("keeps source exportable when checkpoint storage and saving fail", async () => {
    const services = sessionServices({
      checkpointDraft: (_record, _urgency, onFailure) => {
        onFailure(new Error("storage blocked"));
        return undefined;
      },
      save: vi.fn(async () => {
        throw new Error("server offline");
      }),
    });
    const session = new DocumentSession(identity, 1, workspace, services);
    session.loaded(document(1, "# One\n", 1));
    session.edit("# Unsaved\n", { anchor: 4, head: 4 });

    await session.save();

    expect(session.state.status).toBe("unavailable");
    expect(session.state.storage.kind).toBe("failed");
    expect(session.exportSource()).toBe("# Unsaved\n");
  });

  it("opens a recovery conflict when the canonical base has advanced", () => {
    const services = sessionServices();
    const session = new DocumentSession(identity, 4, workspace, services);
    const canonical = document(2, "# Canonical\n", 2);
    session.recover(canonical, draftRecord(1, "# Recovered\n"));

    expect(session.state.status).toBe("conflict");
    if (session.state.status === "conflict") {
      expect(session.state.canonical).toStrictEqual(canonical);
      expect(session.state.draft.source).toBe("# Recovered\n");
    }
    expect(session.exportSource()).toBe("# Recovered\n");
    expect(services.save).not.toHaveBeenCalled();
  });

  it("cleans a recovered draft when the canonical content already includes it", () => {
    const services = sessionServices();
    const session = new DocumentSession(identity, 4, workspace, services);
    const canonical = document(2, "# Recovered\n", 2);
    const checkpoint = { ...draftRecord(1, canonical.content), titleDraft: null };

    session.recover(canonical, checkpoint);

    expect(session.state.status).toBe("clean");
    expect(session.exportSource()).toBe(canonical.content);
    expect(services.clearCheckpoint).toHaveBeenCalledWith(identity, checkpoint.localRevision, checkpoint.mutationId);
  });

  it("recovers a draft without canonical content and classifies unresolved notes", () => {
    const session = new DocumentSession(identity, 4, workspace, sessionServices());
    const error = new V2ApiError("note cannot be resolved", 409, {
      code: "unresolved_note",
      noteId: identity.noteId,
      reason: "missing_snapshot",
    });

    session.recoverUnavailable(draftRecord(1, "# Recovered\n"), error, "One", "one.md");

    expect(session.state).toMatchObject({
      status: "unavailable",
      reason: { kind: "unresolved", error: { code: "unresolved_note", reason: "missing_snapshot" } },
    });
    expect(session.exportSource()).toBe("# Recovered\n");
  });

  it("clears the exact recovered checkpoint after an accepted restore", () => {
    const services = sessionServices();
    const session = new DocumentSession(identity, 4, workspace, services);
    session.recover(document(2, "# Canonical\n", 2), draftRecord(1, "# Recovered\n"));
    const acceptedDocument = document(3, "# Recovered\n", 3);

    expect(session.applyAcceptedMutation(acceptedDocument, 2)).toBeTruthy();
    expect(session.state.status).toBe("clean");
    expect(session.exportSource()).toBe("# Recovered\n");
    expect(services.clearCheckpoint).toHaveBeenCalledWith(identity, 2, "mutation-recovered");
  });

  it("preserves a conflict draft when an accepted restore is stale", () => {
    const services = sessionServices();
    const session = new DocumentSession(identity, 4, workspace, services);
    session.recover(document(2, "# Canonical\n", 2), draftRecord(1, "# Recovered\n"));

    expect(session.applyAcceptedMutation(document(3, "# Recovered\n", 3), 1)).toBeFalsy();
    expect(session.state.status).toBe("conflict");
    expect(session.exportSource()).toBe("# Recovered\n");
    expect(services.clearCheckpoint).not.toHaveBeenCalled();
  });

  it("reconciles server revisions while preserving edits and opening newer conflicts", () => {
    const session = new DocumentSession(identity, 1, workspace, sessionServices());
    session.loaded(document(1, "# One\n", 1), { anchor: 6, head: 6 });
    expect(session.reconcile(document(2, "# One\n", 2))).toBe("unchanged");
    expect(session.state.status).toBe("clean");

    session.edit("# Local draft\n", { anchor: 8, head: 8 });
    expect(session.reconcile(document(3, "# One\n", 3))).toBe("unchanged");
    expect(session.state.status).toBe("dirty");
    expect(session.exportSource()).toBe("# Local draft\n");

    const firstConflict = document(4, "# External change\n", 4);
    expect(session.reconcile(firstConflict)).toBe("conflict");
    expect(session.reconcile(document(3, "# Older external\n", 5))).toBe("unchanged");
    const newerConflict = document(5, "# Newer external change\n", 6);
    expect(session.reconcile(newerConflict)).toBe("conflict");
    expect(session.state.status).toBe("conflict");
    if (session.state.status === "conflict") {
      expect(session.state.canonical).toBe(newerConflict);
      expect(session.state.draft.source).toBe("# Local draft\n");
    }
  });

  it("reloads clean content and clamps its saved selection to the new source", () => {
    const session = new DocumentSession(identity, 1, workspace, sessionServices());
    session.loaded(document(1, "# Longer content\n", 1), { anchor: 12, head: 12 });

    expect(session.reconcile(document(2, "# Short\n", 2))).toBe("reloaded");
    expect(session.state.status).toBe("clean");
    expect(session.exportSource()).toBe("# Short\n");
    if (session.state.status === "clean") {
      expect(session.state.draft.selection).toStrictEqual({ anchor: 8, head: 8 });
    }
  });

  it("keeps a newer title draft after an older accepted rename", async () => {
    const services = sessionServices({ clearTitleCheckpoint: vi.fn(async () => true) });
    const session = new DocumentSession(identity, 1, workspace, services);
    session.loaded(document(1, "# One\n", 1));
    session.editTitle("First title");
    const first = session.state;
    if (!("titleMutationId" in first) || first.titleMutationId === null) {
      throw new Error("Expected a title mutation identity");
    }
    session.editTitle("Newer title");

    await session.acceptRename(
      { ...metadata(2, "# One\n", 2), title: "First title", path: "first.md" },
      first.titleRevision,
      first.titleMutationId,
    );

    expect(session.state).toMatchObject({
      status: "clean",
      title: "First title",
      titleDraft: "Newer title",
      path: "first.md",
    });
    expect(services.clearTitleCheckpoint).not.toHaveBeenCalled();
    expect(services.checkpointDraft).toHaveBeenCalledTimes(3);
  });

  it("resolves pending materialization after the canonical event arrives", async () => {
    const services = sessionServices({
      save: vi.fn(async (documentIdentity, generation, request) => ({
        identity: documentIdentity,
        generation,
        response: {
          mutationId: request.mutationId,
          outcome: { state: "pendingMaterialization" as const, operationId: "operation-1" },
        },
      })),
    });
    const session = new DocumentSession(identity, 1, workspace, services);
    session.loaded(document(1, "# One\n", 1));
    session.edit("# Draft content\n", { anchor: 5, head: 5 });
    await session.save();

    expect(session.state).toMatchObject({
      status: "saving",
      phase: "pendingMaterialization",
      inFlight: { operationId: "operation-1" },
    });
    await session.resolvePendingMaterialization(metadata(2, "# Draft content\n", 2));

    expect(session.state.status).toBe("clean");
    expect(session.exportSource()).toBe("# Draft content\n");
    expect(services.clearCheckpoint).toHaveBeenCalledTimes(1);
  });

  it("saves edits made while materialization is pending", async () => {
    let calls = 0;
    const services = sessionServices({
      save: vi.fn(async (documentIdentity, generation, request) => {
        calls += 1;
        return {
          identity: documentIdentity,
          generation,
          response: calls === 1
            ? { mutationId: request.mutationId, outcome: { state: "pendingMaterialization" as const, operationId: "operation-1" } }
            : accepted(request.mutationId, metadata(3, request.content, 3)),
        };
      }),
    });
    const session = new DocumentSession(identity, 1, workspace, services);
    session.loaded(document(1, "# One\n", 1));
    session.edit("# First draft\n", { anchor: 4, head: 4 });
    await session.save();
    session.edit("# Newer draft\n", { anchor: 5, head: 5 });
    await session.resolvePendingMaterialization(metadata(2, "# First draft\n", 2));

    expect(services.save).toHaveBeenCalledTimes(2);
    expect(session.state.status).toBe("clean");
    expect(session.exportSource()).toBe("# Newer draft\n");
  });

  it("represents load failure and auth lock as explicit states", () => {
    const unavailable = new DocumentSession(identity, 1, workspace, sessionServices());
    unavailable.markUnavailable(new Error("server offline"));
    expect(unavailable.state.status).toBe("unavailable");
    expect(() => unavailable.exportSource()).toThrow(InvalidSessionTransitionError);

    const locked = new DocumentSession(identity, 1, workspace, sessionServices());
    locked.loaded(document(1, "# One\n", 1));
    locked.lock();
    expect(locked.state.status).toBe("auth-locked");
    locked.unlock();
    expect(locked.state.status).toBe("clean");
  });

  it("ignores a response from a closed session generation", async () => {
    let resolveSave: ((envelope: SaveEnvelope) => void) | undefined;
    const services = sessionServices({
      save: vi.fn((_documentIdentity, _generation, _request) => new Promise<SaveEnvelope>((resolve) => {
        resolveSave = resolve;
      })),
    });
    const session = new DocumentSession(identity, 1, workspace, services);
    session.loaded(document(1, "# One\n", 1));
    session.edit("# Draft\n", { anchor: 3, head: 3 });
    const saving = session.save();
    await until(() => resolveSave !== undefined);
    session.close();
    resolveSave?.({
      identity,
      generation: 1,
      response: accepted("mutation-1", metadata(2, "# Draft\n", 2)),
    });
    await saving;

    expect(session.state.status).toBe("saving");
    expect(services.clearCheckpoint).not.toHaveBeenCalled();
  });
});

function sessionServices(overrides: Partial<DocumentSessionServices> = {}): DocumentSessionServices {
  let nextMutation = 1;
  return {
    createMutationId: () => `mutation-${nextMutation++}`,
    sourceHash: async (source) => hash(source.length),
    save: vi.fn(async (documentIdentity, generation, request) => ({
      identity: documentIdentity,
      generation,
      response: accepted(request.mutationId, metadata(2, request.content, 2)),
    })),
    retryable: (error) => error instanceof V2ApiError && error.status >= 500,
    wait: async () => {},
    checkpointDraft: vi.fn((_record, _urgency, _onFailure) => undefined),
    clearCheckpoint: vi.fn(async () => true),
    ...overrides,
  };
}

function document(revision: number, content: string, hashNumber: number): V2NoteDocument {
  return { meta: metadata(revision, content, hashNumber), content };
}

function metadata(revision: number, content: string, hashNumber: number): V2NoteMeta {
  return {
    noteId: identity.noteId,
    path: "one.md",
    title: "One",
    tags: [],
    revision,
    sourceHash: hash(content.length),
    diskHash: `sha256:${String(hashNumber).padStart(64, "0")}`,
    sourceHashFormatVersion: 2,
    diskHashFormatVersion: 1,
    updatedAtMs: revision,
  };
}

function accepted(mutationId: string, result: V2NoteMeta | null): V2MutationResponse {
  return { mutationId, outcome: { state: "accepted", result } };
}

function hash(number: number): string {
  return `sha256-v2:${String(number).padStart(64, "0")}`;
}

function draftRecord(baseRevision: number, source: string): DraftJournalRecord {
  return {
    formatVersion: 1,
    serverInstanceId: identity.serverInstanceId,
    vaultId: identity.vaultId,
    workspaceId: workspace,
    noteId: identity.noteId,
    baseRevision,
    baseSourceHash: hash(baseRevision),
    baseDiskHash: `sha256:${String(baseRevision).padStart(64, "0")}`,
    localRevision: 2,
    mutationId: "mutation-recovered",
    source,
    titleDraft: null,
    selection: { anchor: 2, head: 2 },
    checkpointedAtMs: 3,
  };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("Expected asynchronous work did not finish");
}

function at<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`Missing item at index ${index}`);
  }
  return item;
}
