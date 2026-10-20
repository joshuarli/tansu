import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dirtySnapshot, DocumentControllers, type SessionSource } from "./document-controller.ts";
import { DocumentSession, type DocumentSessionServices, type DocumentSessionState } from "./document-session.ts";
import { noteId, serverInstanceId, vaultId, workspaceId } from "./identity.ts";
import type { V2NoteDocument } from "../types.generated.ts";

describe("DocumentControllers", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shares one in-flight load per note and allows a new load after it settles", async () => {
    const controllers = new DocumentControllers();
    const start = vi.fn(() => Promise.resolve());
    const first = controllers.for(noteId("a")).ensureLoaded(start);
    const second = controllers.for(noteId("a")).ensureLoaded(start);
    await Promise.all([first, second]);
    expect(start).toHaveBeenCalledTimes(1);

    await controllers.for(noteId("a")).ensureLoaded(start);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("restarts the autosave timer on reschedule and fires once", () => {
    const controllers = new DocumentControllers();
    const run = vi.fn();
    const controller = controllers.for(noteId("a"));
    controller.scheduleAutoSave(100, run);
    vi.advanceTimersByTime(60);
    controller.scheduleAutoSave(100, run);
    vi.advanceTimersByTime(60);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(40);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("release cancels that note's autosave and forgets its load", async () => {
    const controllers = new DocumentControllers();
    const run = vi.fn();
    const start = vi.fn(() => new Promise<void>(() => {}));
    controllers.for(noteId("a")).scheduleAutoSave(100, run);
    void controllers.for(noteId("a")).ensureLoaded(start);
    controllers.release(noteId("a"));
    vi.advanceTimersByTime(200);
    expect(run).not.toHaveBeenCalled();

    void controllers.for(noteId("a")).ensureLoaded(start);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("disposeAll cancels every autosave", () => {
    const controllers = new DocumentControllers();
    const run = vi.fn();
    controllers.for(noteId("a")).scheduleAutoSave(100, run);
    controllers.for(noteId("b")).scheduleAutoSave(100, run);
    controllers.disposeAll();
    vi.advanceTimersByTime(200);
    expect(run).not.toHaveBeenCalled();
  });

  it("a settled load does not evict a newer controller's load", async () => {
    const controllers = new DocumentControllers();
    let finish = (): void => {};
    const old = controllers.for(noteId("a")).ensureLoaded(() => new Promise<void>((resolve) => { finish = resolve; }));
    controllers.release(noteId("a"));
    const start = vi.fn(() => new Promise<void>(() => {}));
    void controllers.for(noteId("a")).ensureLoaded(start);
    finish();
    await old;
    void controllers.for(noteId("a")).ensureLoaded(start);
    expect(start).toHaveBeenCalledTimes(1);
  });
});

function fakeSource() {
  const listeners = new Set<(state: DocumentSessionState) => void>();
  const source: SessionSource = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { source, listeners, emit: (state: DocumentSessionState) => listeners.forEach((listener) => listener(state)) };
}

const loadingState: DocumentSessionState = {
  status: "loading",
  identity: { serverInstanceId: serverInstanceId("s"), vaultId: vaultId("v"), noteId: noteId("a") },
  generation: 1,
  localRevision: 0,
  acceptedRevision: null,
  storage: { kind: "available" },
};

describe("DocumentController session subscription", () => {
  it("delivers states to the attached session only", () => {
    const controllers = new DocumentControllers();
    const first = fakeSource();
    const second = fakeSource();
    const seen: string[] = [];
    controllers.for(noteId("a")).attachSession(first.source, () => seen.push("first"));
    controllers.for(noteId("a")).attachSession(second.source, () => seen.push("second"));

    first.emit(loadingState);
    second.emit(loadingState);

    expect(first.listeners.size).toBe(0);
    expect(seen).toStrictEqual(["second"]);
  });

  it("release and disposeAll unsubscribe the session", () => {
    const controllers = new DocumentControllers();
    const released = fakeSource();
    const disposed = fakeSource();
    controllers.for(noteId("a")).attachSession(released.source, () => {});
    controllers.for(noteId("b")).attachSession(disposed.source, () => {});

    controllers.release(noteId("a"));
    expect(released.listeners.size).toBe(0);
    controllers.disposeAll();
    expect(disposed.listeners.size).toBe(0);
  });
});

describe("dirtySnapshot", () => {
  const identity = { serverInstanceId: serverInstanceId("s"), vaultId: vaultId("v"), noteId: noteId("a") };

  function session(): DocumentSession {
    const services: DocumentSessionServices = {
      createMutationId: () => "mutation-1",
      sourceHash: async () => `sha256-v2:${"0".repeat(64)}`,
      save: () => new Promise(() => {}),
      retryable: () => false,
      wait: async () => {},
      checkpointDraft: () => undefined,
      clearCheckpoint: async () => true,
    };
    const created = new DocumentSession(identity, 1, workspaceId("w"), services);
    const document: V2NoteDocument = {
      meta: {
        noteId: "a",
        path: "a.md",
        title: "A",
        tags: [],
        revision: 1,
        sourceHash: `sha256-v2:${"0".repeat(64)}`,
        diskHash: `sha256:${"0".repeat(64)}`,
        sourceHashFormatVersion: 2,
        diskHashFormatVersion: 1,
        updatedAtMs: 1,
      },
      content: "# A\n",
    };
    created.loaded(document);
    return created;
  }

  it("has no draft and is not dirty while loading", () => {
    expect(dirtySnapshot(loadingState)).toMatchObject({
      draft: null, selection: undefined, dirty: false, saving: false, title: undefined, path: undefined,
    });
  });

  it("is clean with the loaded source and the note's title and path", () => {
    expect(dirtySnapshot(session().state)).toMatchObject({
      draft: "# A\n", dirty: false, saving: false, conflict: false, title: "A", path: "a.md",
    });
  });

  it("is dirty after an edit and prefers the title draft", () => {
    const edited = session();
    edited.edit("# B\n", { anchor: 1, head: 1 });
    edited.editTitle("Renamed");
    expect(dirtySnapshot(edited.state)).toMatchObject({
      draft: "# B\n", selection: { anchor: 1, head: 1 }, dirty: true, saving: false, title: "Renamed",
    });
  });

  it("is dirty and saving while a save is in flight", async () => {
    const saving = session();
    saving.edit("# B\n", null);
    void saving.save();
    await Promise.resolve();
    await Promise.resolve();
    expect(saving.state.status).toBe("saving");
    expect(dirtySnapshot(saving.state)).toMatchObject({ dirty: true, saving: true });
  });
});

describe("DocumentControllers close", () => {
  it("keeps the controller until a flushing close settles and delays a new load behind it", async () => {
    const controllers = new DocumentControllers();
    let finish = (): void => {};
    const close = vi.fn();
    const session = { save: () => new Promise<void>((resolve) => { finish = resolve; }), close };
    const closing = controllers.close(noteId("a"), session, "flush");
    const start = vi.fn(() => Promise.resolve());
    const reopened = controllers.for(noteId("a")).ensureLoaded(start);
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();

    finish();
    await closing;
    await reopened;
    expect(close).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("closes the session when the flush fails and still releases the controller", async () => {
    const controllers = new DocumentControllers();
    const close = vi.fn();
    const failure = new Error("offline");
    const closing = controllers.close(noteId("a"), { save: () => Promise.reject(failure), close }, "flush");
    await expect(closing).rejects.toBe(failure);
    expect(close).toHaveBeenCalledTimes(1);
    const start = vi.fn(() => Promise.resolve());
    await controllers.for(noteId("a")).ensureLoaded(start);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("discards without saving", async () => {
    const controllers = new DocumentControllers();
    const save = vi.fn(() => Promise.resolve());
    const close = vi.fn();
    await controllers.close(noteId("a"), { save, close }, "discard");
    expect(save).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
