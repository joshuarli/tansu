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
