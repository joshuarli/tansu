import { canonicalSourceHash } from "../save-delta.ts";
import type { V2ApiErrorKind, V2MutationResponse, V2NoteDocument, V2NoteMeta, V2NotePrecondition, V2SaveNoteRequest } from "../types.generated.ts";
import { isRetryableV2Error } from "./v2-api.ts";
import { type DocumentIdentity, type WorkspaceId, documentIdentityKey } from "./identity.ts";
import type { DraftJournalRecord } from "./workspace-store.ts";

export type Selection = { anchor: number; head: number } | null;

export type StorageState =
  | { kind: "available" }
  | { kind: "pending" }
  | { kind: "failed"; error: unknown };

export type SessionBase = {
  revision: number;
  sourceHash: string;
  diskHash: string;
};

export type CleanDraft = {
  localRevision: number;
  source: string;
  selection: Selection;
  mutationId: null;
};

export type DirtyDraft = {
  localRevision: number;
  source: string;
  selection: Selection;
  mutationId: string;
};

type LoadedFields = {
  identity: DocumentIdentity;
  generation: number;
  acceptedRevision: number;
  base: SessionBase;
  title: string;
  path: string;
  storage: StorageState;
};

type InitialUnavailableState = {
  status: "unavailable";
  identity: DocumentIdentity;
  generation: number;
  localRevision: 0;
  acceptedRevision: null;
  draft: null;
  reason: UnavailableReason;
  storage: StorageState;
};

export type DocumentSessionState =
  | {
    status: "loading";
    identity: DocumentIdentity;
    generation: number;
    localRevision: 0;
    acceptedRevision: null;
    storage: StorageState;
  }
  | InitialUnavailableState
  | (LoadedFields & { status: "clean"; draft: CleanDraft })
  | (LoadedFields & { status: "dirty"; draft: DirtyDraft })
  | (LoadedFields & {
    status: "saving";
    phase: "sending";
    draft: DirtyDraft;
    inFlight: InFlightSave;
  })
  | (LoadedFields & {
    status: "saving";
    phase: "pendingMaterialization";
    draft: DirtyDraft;
    inFlight: InFlightSave & { operationId: string };
  })
  | (LoadedFields & { status: "conflict"; draft: DirtyDraft; canonical: V2NoteDocument })
  | (LoadedFields & { status: "unavailable"; draft: DirtyDraft; reason: UnavailableReason })
  | (LoadedFields & { status: "auth-locked"; draft: CleanDraft | DirtyDraft });

export type UnavailableReason =
  | { kind: "unresolved"; error: Extract<V2ApiErrorKind, { code: "unresolved_note" }> }
  | { kind: "transient-exhausted"; error: unknown }
  | { kind: "failure"; error: unknown };

export type InFlightSave = {
  mutationId: string;
  localRevision: number;
  source: string;
  sourceHash: string;
  request: V2SaveNoteRequest;
  retryAttempt: number;
};

export type SaveEnvelope = {
  identity: DocumentIdentity;
  generation: number;
  response: V2MutationResponse;
};

export type DocumentSessionServices = {
  createMutationId: () => string;
  sourceHash: (source: string) => Promise<string>;
  save: (
    identity: DocumentIdentity,
    generation: number,
    request: V2SaveNoteRequest,
  ) => Promise<SaveEnvelope>;
  retryable: (error: unknown) => boolean;
  wait: (milliseconds: number) => Promise<void>;
  checkpointDraft: (
    record: DraftJournalRecord,
    urgency: "typing" | "structural",
    onFailure: (error: unknown) => void,
  ) => undefined | Promise<boolean>;
  clearCheckpoint: (
    identity: DocumentIdentity,
    acceptedLocalRevision: number,
    acceptedMutationId: string,
  ) => Promise<boolean>;
};

export class InvalidSessionTransitionError extends Error {
  constructor(status: DocumentSessionState["status"], action: string) {
    super(`Cannot ${action} a ${status} document session`);
    this.name = "InvalidSessionTransitionError";
  }
}

const RETRY_DELAYS_MS = [250, 1000, 3000] as const;

export class DocumentSession {
  private current: DocumentSessionState;
  private listeners = new Set<(state: DocumentSessionState) => void>();
  private saveTask: Promise<void> | null = null;
  private generation: number;
  private checkpointGeneration = 0;
  private disposed = false;

  constructor(
    readonly identity: DocumentIdentity,
    generation: number,
    private readonly workspaceId: WorkspaceId,
    private readonly services: DocumentSessionServices,
  ) {
    this.generation = nonNegativeSafeInteger(generation, "generation");
    this.current = {
      status: "loading",
      identity,
      generation,
      localRevision: 0,
      acceptedRevision: null,
      storage: { kind: "available" },
    };
  }

  get state(): DocumentSessionState {
    return this.current;
  }

  subscribe(listener: (state: DocumentSessionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  }

  loaded(document: V2NoteDocument, selection: Selection = null): void {
    this.requireStatus("loading", "load");
    if (document.meta.noteId !== this.identity.noteId) {
      throw new SessionProtocolError("Loaded document note identity does not match the session");
    }
    const base = baseFromMeta(document.meta);
    const draft: CleanDraft = {
      localRevision: 0,
      source: document.content,
      selection: validateSelection(selection, document.content.length),
      mutationId: null,
    };
    this.set({
      status: "clean",
      identity: this.identity,
      generation: this.generation,
      acceptedRevision: base.revision,
      base,
      title: document.meta.title,
      path: document.meta.path,
      draft,
      storage: { kind: "available" },
    });
  }

  recover(document: V2NoteDocument, checkpoint: DraftJournalRecord): void {
    this.requireStatus("loading", "recover");
    if (document.meta.noteId !== this.identity.noteId ||
      checkpoint.serverInstanceId !== this.identity.serverInstanceId ||
      checkpoint.vaultId !== this.identity.vaultId || checkpoint.noteId !== this.identity.noteId ||
      checkpoint.workspaceId !== this.workspaceId) {
      throw new SessionProtocolError("Recovery identity does not match the document session");
    }
    const canonicalBase = baseFromMeta(document.meta);
    const savedBase: SessionBase = {
      revision: nonNegativeSafeInteger(checkpoint.baseRevision, "baseRevision"),
      sourceHash: checkpoint.baseSourceHash,
      diskHash: checkpoint.baseDiskHash,
    };
    const draft: DirtyDraft = {
      localRevision: nonNegativeSafeInteger(checkpoint.localRevision, "localRevision"),
      source: checkpoint.source,
      selection: validateSelection(checkpoint.selection, checkpoint.source.length),
      mutationId: validMutationId(checkpoint.mutationId),
    };
    const baseMatches = savedBase.revision === canonicalBase.revision &&
      savedBase.sourceHash === canonicalBase.sourceHash && savedBase.diskHash === canonicalBase.diskHash;
    if (checkpoint.source === document.content) {
      this.set({
        status: "clean",
        identity: this.identity,
        generation: this.generation,
        acceptedRevision: canonicalBase.revision,
        base: canonicalBase,
        title: document.meta.title,
        path: document.meta.path,
        draft: { ...draft, mutationId: null },
        storage: { kind: "available" },
      });
      if (checkpoint.titleDraft === null) {
        this.clearCheckpoint(checkpoint.localRevision, checkpoint.mutationId);
      }
      return;
    }
    if (!baseMatches) {
      this.set({
        status: "conflict",
        identity: this.identity,
        generation: this.generation,
        acceptedRevision: canonicalBase.revision,
        base: savedBase,
        title: document.meta.title,
        path: document.meta.path,
        draft,
        canonical: document,
        storage: { kind: "available" },
      });
      return;
    }
    this.set({
      status: "dirty",
      identity: this.identity,
      generation: this.generation,
      acceptedRevision: canonicalBase.revision,
      base: canonicalBase,
      title: document.meta.title,
      path: document.meta.path,
      draft,
      storage: { kind: "available" },
    });
  }

  edit(source: string, selection: Selection, urgency: "typing" | "structural" = "typing"): void {
    const state = this.loadedState("edit");
    const safeSelection = validateSelection(selection, source.length);
    if (source === state.draft.source) {
      const draft = { ...state.draft, selection: safeSelection };
      this.set({ ...state, draft } as DocumentSessionState);
      if (draft.mutationId !== null) {
        this.checkpoint(state.base, draft, urgency);
      }
      return;
    }
    const localRevision = incrementSafeInteger(state.draft.localRevision, "localRevision");
    const draft: DirtyDraft = {
      localRevision,
      source,
      selection: safeSelection,
      mutationId: validMutationId(this.services.createMutationId()),
    };
    const updated = state.status === "saving"
      ? { ...state, draft }
      : { ...state, status: "dirty" as const, draft };
    this.set(updated as DocumentSessionState);
    this.checkpoint(state.base, draft, urgency);
  }

  updateSelection(selection: Selection): void {
    const state = this.loadedState("update the selection of");
    const safeSelection = validateSelection(selection, state.draft.source.length);
    const draft = { ...state.draft, selection: safeSelection };
    this.set({ ...state, draft } as DocumentSessionState);
    if (draft.mutationId !== null) {
      this.checkpoint(state.base, draft, "typing");
    }
  }

  async save(): Promise<void> {
    if (this.saveTask !== null) {
      return this.saveTask;
    }
    const state = this.current;
    if (state.status === "clean" || state.status === "loading" || state.status === "saving" ||
      state.status === "conflict" || state.status === "auth-locked") {
      return;
    }
    if (state.status === "unavailable" && state.reason.kind !== "transient-exhausted") {
      return;
    }
    if (state.status === "unavailable") {
      if (state.draft === null) {
        return;
      }
      this.set({ ...state, status: "dirty" });
    }
    this.saveTask = this.runSaveLoop().finally(() => {
      this.saveTask = null;
    });
    return this.saveTask;
  }

  resolvePendingMaterialization(meta: V2NoteMeta): void {
    const state = this.current;
    if (state.status !== "saving" || state.phase !== "pendingMaterialization") {
      throw new InvalidSessionTransitionError(state.status, "resolve pending materialization for");
    }
    if (meta.noteId !== this.identity.noteId || meta.sourceHash !== state.inFlight.sourceHash) {
      return;
    }
    const base = baseFromMeta(meta);
    if (state.draft.localRevision === state.inFlight.localRevision) {
      this.set({
        status: "clean",
        identity: this.identity,
        generation: this.generation,
        acceptedRevision: base.revision,
        base,
        title: meta.title,
        path: meta.path,
        draft: { ...state.draft, mutationId: null },
        storage: state.storage,
      });
      this.clearCheckpoint(state.inFlight.localRevision, state.inFlight.mutationId);
      return;
    }
    this.set({
      status: "dirty",
      identity: this.identity,
      generation: this.generation,
      acceptedRevision: base.revision,
      base,
      title: meta.title,
      path: meta.path,
      draft: state.draft,
      storage: state.storage,
    });
    this.checkpoint(base, state.draft, "structural");
    void this.save();
  }

  lock(): void {
    const state = this.loadedState("lock");
    this.set({ ...state, status: "auth-locked" } as DocumentSessionState);
  }

  unlock(): void {
    if (this.current.status !== "auth-locked") {
      throw new InvalidSessionTransitionError(this.current.status, "unlock");
    }
    const state = this.current;
    const isDirty = state.draft.mutationId !== null;
    this.set({ ...state, status: isDirty ? "dirty" : "clean" } as DocumentSessionState);
  }

  markUnavailable(error: unknown): void {
    if (this.current.status === "loading") {
      this.set({
        status: "unavailable",
        identity: this.identity,
        generation: this.generation,
        localRevision: 0,
        acceptedRevision: null,
        draft: null,
        reason: classifyUnavailable(error),
        storage: this.current.storage,
      });
      return;
    }
    const state = this.loadedState("mark unavailable");
    this.set({ ...state, status: "unavailable", reason: classifyUnavailable(error) } as DocumentSessionState);
  }

  exportSource(): string {
    const state = this.current;
    if (state.status === "loading" || (state.status === "unavailable" && state.draft === null)) {
      throw new InvalidSessionTransitionError(state.status, "export source from");
    }
    return state.draft.source;
  }

  close(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.generation = incrementSafeInteger(this.generation, "generation");
    this.listeners.clear();
  }

  private async runSaveLoop(): Promise<void> {
    while (!this.disposed) {
      const state = this.current;
      if (state.status !== "dirty") {
        return;
      }
      const requestGeneration = this.generation;
      const identityKey = documentIdentityKey(this.identity);
      const localRevision = state.draft.localRevision;
      const mutationId = state.draft.mutationId;
      let sourceHash: string;
      try {
        sourceHash = await this.services.sourceHash(state.draft.source);
      } catch (error) {
        this.failCurrent(requestGeneration, identityKey, { kind: "failure", error });
        return;
      }
      if (!this.isCurrent(requestGeneration, identityKey)) {
        return;
      }
      const latest = this.current;
      if (latest.status !== "dirty") {
        return;
      }
      if (latest.draft.localRevision !== localRevision) {
        continue;
      }
      const precondition: V2NotePrecondition = {
        baseRevision: latest.acceptedRevision,
        baseSourceHash: latest.base.sourceHash,
        baseDiskHash: latest.base.diskHash,
      };
      const request: V2SaveNoteRequest = {
        mutationId,
        precondition,
        content: latest.draft.source,
        sourceHash,
      };
      const inFlight: InFlightSave = {
        mutationId,
        localRevision,
        source: latest.draft.source,
        sourceHash,
        request,
        retryAttempt: 0,
      };
      this.set({ ...latest, status: "saving", phase: "sending", inFlight });
      const response = await this.sendWithRetry(inFlight, requestGeneration, identityKey);
      if (response === null || !this.isCurrent(requestGeneration, identityKey)) {
        return;
      }
      if (response.outcome.state === "conflict") {
        if (response.outcome.current.meta.noteId !== this.identity.noteId ||
          response.outcome.draft.noteId !== this.identity.noteId) {
          this.failCurrent(requestGeneration, identityKey, {
            kind: "failure",
            error: new SessionProtocolError("Conflict response note identity does not match the session"),
          });
          return;
        }
        const saving = this.current;
        if (saving.status !== "saving") {
          return;
        }
        this.set({
          status: "conflict",
          identity: this.identity,
          generation: this.generation,
          acceptedRevision: saving.acceptedRevision,
          base: saving.base,
          title: saving.title,
          path: saving.path,
          draft: saving.draft,
          canonical: response.outcome.current,
          storage: saving.storage,
        });
        return;
      }
      if (response.outcome.state === "pendingMaterialization") {
        const saving = this.current;
        if (saving.status !== "saving") {
          return;
        }
        this.set({
          ...saving,
          phase: "pendingMaterialization",
          inFlight: { ...saving.inFlight, operationId: response.outcome.operationId },
        });
        return;
      }
      const meta = response.outcome.state === "accepted" ? response.outcome.result : null;
      if (meta === null || meta.noteId !== this.identity.noteId || meta.sourceHash !== inFlight.sourceHash) {
        this.failCurrent(requestGeneration, identityKey, {
          kind: "failure",
          error: new SessionProtocolError("Accepted save response omitted or changed note identity"),
        });
        return;
      }
      const saving = this.current;
      if (saving.status !== "saving") {
        return;
      }
      const base = baseFromMeta(meta);
      if (saving.draft.localRevision === inFlight.localRevision) {
        this.set({
          status: "clean",
          identity: this.identity,
          generation: this.generation,
          acceptedRevision: base.revision,
          base,
          title: meta.title,
          path: meta.path,
          draft: { ...saving.draft, source: inFlight.source, mutationId: null },
          storage: saving.storage,
        });
        this.clearCheckpoint(inFlight.localRevision, inFlight.mutationId);
        return;
      }
      this.set({
        status: "dirty",
        identity: this.identity,
        generation: this.generation,
        acceptedRevision: base.revision,
        base,
        title: meta.title,
        path: meta.path,
        draft: saving.draft,
        storage: saving.storage,
      });
      this.checkpoint(base, saving.draft, "structural");
    }
  }

  private async sendWithRetry(
    inFlight: InFlightSave,
    generation: number,
    identityKey: string,
  ): Promise<V2MutationResponse | null> {
    let attempt = 0;
    while (true) {
      try {
        const envelope = await this.services.save(this.identity, generation, inFlight.request);
        if (!this.isCurrent(generation, identityKey)) {
          return null;
        }
        if (documentIdentityKey(envelope.identity) !== identityKey || envelope.generation !== generation) {
          this.failCurrent(generation, identityKey, {
            kind: "failure",
            error: new SessionProtocolError("Save response belongs to a different session generation"),
          });
          return null;
        }
        if (envelope.response.mutationId !== inFlight.mutationId) {
          this.failCurrent(generation, identityKey, {
            kind: "failure",
            error: new SessionProtocolError("Save response mutation identity does not match the request"),
          });
          return null;
        }
        return envelope.response;
      } catch (error) {
        if (!this.isCurrent(generation, identityKey)) {
          return null;
        }
        const kind = apiErrorKind(error);
        if (kind?.code === "save_conflict") {
          const current = this.current;
          if (current.status === "saving") {
            this.set({
              status: "conflict",
              identity: this.identity,
              generation: this.generation,
              acceptedRevision: current.acceptedRevision,
              base: current.base,
              title: current.title,
              path: current.path,
              draft: current.draft,
              canonical: kind.current,
              storage: current.storage,
            });
          }
          return null;
        }
        if (kind?.code === "auth_required") {
          const current = this.current;
          if (current.status === "saving") {
            this.set({ ...current, status: "auth-locked" });
          }
          return null;
        }
        if (kind?.code === "unresolved_note") {
          this.failCurrent(generation, identityKey, { kind: "unresolved", error: kind });
          return null;
        }
        if (!this.services.retryable(error) || attempt >= RETRY_DELAYS_MS.length) {
          const reason = this.services.retryable(error)
            ? { kind: "transient-exhausted" as const, error }
            : { kind: "failure" as const, error };
          this.failCurrent(generation, identityKey, reason);
          return null;
        }
        const nextAttempt = attempt + 1;
        const state = this.current;
        if (state.status === "saving" && state.phase === "sending") {
          this.set({ ...state, inFlight: { ...state.inFlight, retryAttempt: nextAttempt } });
        }
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined) {
          this.failCurrent(generation, identityKey, { kind: "transient-exhausted", error });
          return null;
        }
        try {
          await this.services.wait(delay);
        } catch (waitError) {
          if (this.isCurrent(generation, identityKey)) {
            this.failCurrent(generation, identityKey, { kind: "failure", error: waitError });
          }
          return null;
        }
        attempt = nextAttempt;
      }
    }
  }

  private checkpoint(base: SessionBase, draft: CleanDraft | DirtyDraft, urgency: "typing" | "structural"): void {
    if (this.disposed) {
      return;
    }
    const sequence = incrementSafeInteger(this.checkpointGeneration, "checkpointGeneration");
    this.checkpointGeneration = sequence;
    const record: DraftJournalRecord = {
      formatVersion: 1,
      serverInstanceId: this.identity.serverInstanceId,
      vaultId: this.identity.vaultId,
      workspaceId: this.workspaceId,
      noteId: this.identity.noteId,
      baseRevision: base.revision,
      baseSourceHash: base.sourceHash,
      baseDiskHash: base.diskHash,
      localRevision: draft.localRevision,
      mutationId: draft.mutationId ?? validMutationId(this.services.createMutationId()),
      source: draft.source,
      titleDraft: null,
      selection: draft.selection,
      checkpointedAtMs: Date.now(),
    };
    this.updateStorage({ kind: "pending" });
    let failureReported = false;
    const onFailure = (error: unknown) => {
      failureReported = true;
      if (!this.disposed && sequence === this.checkpointGeneration) {
        this.updateStorage({ kind: "failed", error });
      }
    };
    try {
      const result = this.services.checkpointDraft(record, urgency, onFailure);
      if (result instanceof Promise) {
        void result.then((written) => {
          if (!written) {
            onFailure(new SessionProtocolError("A newer draft checkpoint is already stored"));
          } else if (!this.disposed && sequence === this.checkpointGeneration) {
            this.updateStorage({ kind: "available" });
          }
        }, (error) => {
          if (!failureReported) {
            onFailure(error);
          }
        });
      }
    } catch (error) {
      onFailure(error);
    }
  }

  private clearCheckpoint(localRevision: number, mutationId: string): void {
    const onFailure = (error: unknown) => {
      if (!this.disposed) {
        this.updateStorage({ kind: "failed", error });
      }
    };
    try {
      void this.services.clearCheckpoint(this.identity, localRevision, mutationId).then((cleared) => {
        if (cleared && !this.disposed && this.current.status !== "loading" &&
          !(this.current.status === "unavailable" && this.current.draft === null) &&
          this.current.draft.localRevision === localRevision) {
          this.updateStorage({ kind: "available" });
        }
      }, onFailure);
    } catch (error) {
      onFailure(error);
    }
  }

  private updateStorage(storage: StorageState): void {
    if (this.current.status !== "loading") {
      this.set({ ...this.current, storage } as DocumentSessionState);
    } else {
      this.set({ ...this.current, storage });
    }
  }

  private failCurrent(generation: number, key: string, reason: UnavailableReason): void {
    if (!this.isCurrent(generation, key)) {
      return;
    }
    const state = this.current;
    if (state.status === "saving" || state.status === "dirty") {
      this.set({ ...state, status: "unavailable", reason });
    }
  }

  private isCurrent(generation: number, key: string): boolean {
    return !this.disposed && this.generation === generation &&
      documentIdentityKey(this.identity) === key && this.current.generation === generation;
  }

  private loadedState(
    action: string,
  ): Exclude<DocumentSessionState, { status: "loading" } | InitialUnavailableState> {
    if (this.current.status === "loading" ||
      (this.current.status === "unavailable" && this.current.draft === null)) {
      throw new InvalidSessionTransitionError(this.current.status, action);
    }
    if (this.current.status === "auth-locked" || this.current.status === "conflict") {
      throw new InvalidSessionTransitionError(this.current.status, action);
    }
    return this.current as Exclude<DocumentSessionState, { status: "loading" } | InitialUnavailableState>;
  }

  private requireStatus(status: DocumentSessionState["status"], action: string): void {
    if (this.current.status !== status) {
      throw new InvalidSessionTransitionError(this.current.status, action);
    }
  }

  private set(state: DocumentSessionState): void {
    this.current = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}

export class SessionProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionProtocolError";
  }
}

export function defaultDocumentSessionServices(
  save: DocumentSessionServices["save"],
  checkpointDraft: DocumentSessionServices["checkpointDraft"],
  clearCheckpoint: DocumentSessionServices["clearCheckpoint"],
  wait: DocumentSessionServices["wait"] = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
): DocumentSessionServices {
  return {
    createMutationId: () => {
      const id = globalThis.crypto?.randomUUID();
      if (id === undefined) {
        throw new Error("Secure random mutation identity is unavailable");
      }
      return id;
    },
    sourceHash: canonicalSourceHash,
    save,
    retryable: isRetryableV2Error,
    wait,
    checkpointDraft,
    clearCheckpoint,
  };
}

function baseFromMeta(meta: V2NoteMeta): SessionBase {
  return { revision: meta.revision, sourceHash: meta.sourceHash, diskHash: meta.diskHash };
}

function validMutationId(value: string): string {
  if (value.length === 0 || new TextEncoder().encode(value).length > 128) {
    throw new SessionProtocolError("Mutation identity must contain at most 128 UTF-8 bytes");
  }
  return value;
}

function validateSelection(selection: Selection, sourceLength: number): Selection {
  if (selection === null) {
    return null;
  }
  const anchor = nonNegativeSafeInteger(selection.anchor, "selection anchor");
  const head = nonNegativeSafeInteger(selection.head, "selection head");
  if (anchor > sourceLength || head > sourceLength) {
    throw new SessionProtocolError("Selection is outside the current source");
  }
  return { anchor, head };
}

function apiErrorKind(error: unknown): V2ApiErrorKind | null {
  return error !== null && typeof error === "object" && "kind" in error
    ? ((error as { kind: V2ApiErrorKind | null }).kind)
    : null;
}

function classifyUnavailable(error: unknown): UnavailableReason {
  const kind = apiErrorKind(error);
  return kind?.code === "unresolved_note"
    ? { kind: "unresolved", error: kind }
    : { kind: "failure", error };
}

function nonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function incrementSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value + 1)) {
    throw new RangeError(`${name} exceeded the safe integer range`);
  }
  return value + 1;
}
