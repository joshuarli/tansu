import type { Selection } from "./document-session.ts";
import type { LocalDraftId, ServerIdentity, WorkspaceId } from "./identity.ts";
import type { LocalDraftJournalRecord } from "./workspace-store.ts";

export type LocalDraftSessionState = {
  serverInstanceId: string;
  vaultId: string;
  workspaceId: string;
  localDraftId: LocalDraftId;
  localRevision: number;
  updatedAtMs: number;
  mutationId: string;
  source: string;
  titleDraft: string;
  promotionPending: boolean;
  selection: Selection;
  storage: "available" | "pending" | "failed";
  storageError: unknown | null;
};

export type LocalDraftSessionServices = {
  createMutationId: () => string;
  checkpoint: (
    record: LocalDraftJournalRecord,
    urgency: "typing" | "structural",
    onFailure: (error: unknown) => void,
  ) => undefined | Promise<boolean>;
};

export class LocalDraftSession {
  private current: LocalDraftSessionState;
  private readonly listeners = new Set<(state: LocalDraftSessionState) => void>();
  private checkpointGeneration = 0;

  constructor(
    readonly identity: ServerIdentity,
    readonly workspaceId: WorkspaceId,
    readonly localDraftId: LocalDraftId,
    private readonly services: LocalDraftSessionServices,
  ) {
    const mutationId = this.services.createMutationId();
    this.current = {
      ...identity,
      workspaceId,
      localDraftId,
      localRevision: 0,
      updatedAtMs: Date.now(),
      mutationId,
      source: "",
      titleDraft: "",
      promotionPending: false,
      selection: null,
      storage: "available",
      storageError: null,
    };
  }

  get state(): LocalDraftSessionState {
    return this.current;
  }

  subscribe(listener: (state: LocalDraftSessionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  }

  async persist(): Promise<boolean> {
    const result = this.checkpoint("structural");
    return result instanceof Promise ? await result : true;
  }

  recover(record: LocalDraftJournalRecord): void {
    if (record.serverInstanceId !== this.identity.serverInstanceId ||
      record.vaultId !== this.identity.vaultId || record.workspaceId !== this.workspaceId ||
      record.localDraftId !== this.localDraftId) {
      throw new TypeError("Local draft recovery identity does not match the session");
    }
    this.set({
      ...this.current,
      localRevision: record.localRevision,
      updatedAtMs: record.checkpointedAtMs,
      mutationId: record.mutationId,
      source: record.source,
      titleDraft: record.titleDraft,
      promotionPending: record.promotionPending,
      selection: record.selection,
      storage: "available",
      storageError: null,
    });
  }

  edit(source: string, selection: Selection, urgency: "typing" | "structural" = "typing"): void {
    if (this.current.promotionPending) {
      throw new TypeError("Cannot edit a local draft while its create request is pending");
    }
    if (source === this.current.source) {
      if (sameSelection(selection, this.current.selection)) return;
      this.set({ ...this.current, selection: validSelection(selection, source.length) });
      this.checkpointInBackground(urgency);
      return;
    }
    this.updateRevision({
      source,
      selection: validSelection(selection, source.length),
    });
    this.checkpointInBackground(urgency);
  }

  editTitle(titleDraft: string): void {
    if (this.current.promotionPending) {
      throw new TypeError("Cannot edit a local draft while its create request is pending");
    }
    if (titleDraft === this.current.titleDraft) return;
    this.updateRevision({ titleDraft });
    this.checkpointInBackground("structural");
  }

  async beginPromotion(): Promise<boolean> {
    if (this.current.titleDraft.trim() === "") return false;
    if (!this.current.promotionPending) {
      this.set({ ...this.current, promotionPending: true });
    }
    const result = this.checkpoint("structural");
    return result instanceof Promise ? await result : true;
  }

  cancelPromotion(): void {
    if (!this.current.promotionPending) return;
    this.set({ ...this.current, promotionPending: false });
    this.checkpointInBackground("structural");
  }

  exportSource(): string {
    return this.current.source;
  }

  private updateRevision(fields: Partial<LocalDraftSessionState>): void {
    const localRevision = this.current.localRevision + 1;
    if (!Number.isSafeInteger(localRevision)) {
      throw new RangeError("Local draft revision exceeds the safe integer range");
    }
    this.set({
      ...this.current,
      ...fields,
      localRevision,
      updatedAtMs: Date.now(),
      mutationId: this.services.createMutationId(),
    });
  }

  private checkpoint(urgency: "typing" | "structural"): undefined | Promise<boolean> {
    const sequence = ++this.checkpointGeneration;
    const state = this.current;
    const record: LocalDraftJournalRecord = {
      formatVersion: 2,
      kind: "local",
      serverInstanceId: state.serverInstanceId,
      vaultId: state.vaultId,
      workspaceId: state.workspaceId,
      localDraftId: state.localDraftId,
      localRevision: state.localRevision,
      mutationId: state.mutationId,
      source: state.source,
      titleDraft: state.titleDraft,
      promotionPending: state.promotionPending,
      selection: state.selection,
      checkpointedAtMs: Date.now(),
    };
    this.set({ ...state, storage: "pending", storageError: null });
    let failed = false;
    const fail = (error: unknown) => {
      failed = true;
      if (sequence === this.checkpointGeneration) {
        this.set({ ...this.current, storage: "failed", storageError: error });
      }
    };
    try {
      const result = this.services.checkpoint(record, urgency, fail);
      if (result instanceof Promise) {
        return result.then((written) => {
          if (!written) {
            fail(new Error("Local draft checkpoint was rejected"));
          } else if (!failed && sequence === this.checkpointGeneration) {
            this.set({ ...this.current, storage: "available", storageError: null });
          }
          return written;
        }, (error: unknown) => {
          fail(error);
          throw error;
        });
      }
      return result;
    } catch (error) {
      fail(error);
      throw error;
    }
  }

  private checkpointInBackground(urgency: "typing" | "structural"): void {
    const result = this.checkpoint(urgency);
    if (result instanceof Promise) void result.catch(() => undefined);
  }

  private set(state: LocalDraftSessionState): void {
    this.current = state;
    for (const listener of this.listeners) listener(state);
  }
}

function validSelection(selection: Selection, sourceLength: number): Selection {
  if (selection === null) return null;
  if (!Number.isSafeInteger(selection.anchor) || !Number.isSafeInteger(selection.head) ||
    selection.anchor < 0 || selection.head < 0 || selection.anchor > sourceLength ||
    selection.head > sourceLength) {
    throw new TypeError("Local draft selection is outside its source");
  }
  return { anchor: selection.anchor, head: selection.head };
}

function sameSelection(left: Selection, right: Selection): boolean {
  return left?.anchor === right?.anchor && left?.head === right?.head;
}
