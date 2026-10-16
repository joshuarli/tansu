import type { ConflictDraftId } from "../state.ts";
import type { DocumentSessionState, Selection } from "./document-session.ts";
import type { NoteId } from "./identity.ts";

export type DirtySnapshot = {
  draft: string | null;
  selection: Selection | undefined;
  dirty: boolean;
  saving: boolean;
  savePending: boolean;
  conflict: boolean;
  conflictDraftId: ConflictDraftId | null;
  title: string | undefined;
  path: string | undefined;
};

export function dirtySnapshot(value: DocumentSessionState): DirtySnapshot {
  const draft = "draft" in value ? value.draft : null;
  return {
    draft: draft === null ? null : draft.source,
    selection: draft === null ? undefined : draft.selection,
    dirty: value.status === "dirty" || value.status === "saving" || value.status === "conflict" ||
      value.status === "unavailable" && value.draft !== null ||
      value.status === "auth-locked" && value.draft.mutationId !== null,
    saving: value.status === "saving",
    savePending: value.status === "saving" && value.phase === "pendingMaterialization",
    conflict: value.status === "conflict",
    conflictDraftId: value.status === "conflict" && value.conflictDraft !== null
      ? value.conflictDraft.draftId as ConflictDraftId
      : null,
    title: "title" in value ? value.titleDraft ?? value.title : undefined,
    path: "path" in value ? value.path : undefined,
  };
}

export type SessionSource = {
  subscribe(listener: (state: DocumentSessionState) => void): () => void;
};

export type ClosableSession = {
  save(): Promise<unknown>;
  close(): void;
};

export type CloseDisposition = "flush" | "discard";

export class DocumentController {
  private load: Promise<void> | null = null;
  private readonly mutations = new Set<Promise<unknown>>();
  private autoSaveTimer: number | undefined;
  private session: SessionSource | null = null;
  private unsubscribe: (() => void) | null = null;

  attachSession(session: SessionSource, onState: (state: DocumentSessionState) => void): void {
    this.detachSession();
    this.session = session;
    this.unsubscribe = session.subscribe((state) => {
      if (this.session === session) onState(state);
    });
  }

  detachSession(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.session = null;
  }

  track<T>(mutation: Promise<T>): Promise<T> {
    const tracked = mutation.finally(() => this.mutations.delete(tracked));
    tracked.catch(() => {});
    this.mutations.add(tracked);
    return tracked;
  }

  async settled(): Promise<void> {
    while (this.mutations.size > 0) await Promise.allSettled(this.mutations);
  }

  hasPendingMutations(): boolean {
    return this.mutations.size > 0;
  }

  retire(): void {
    this.cancelAutoSave();
    this.detachSession();
    this.load = null;
  }

  close(session: ClosableSession, disposition: CloseDisposition): Promise<void> {
    this.retire();
    if (disposition === "discard") {
      session.close();
      return Promise.resolve();
    }
    return this.track(session.save().finally(() => session.close())).then(() => {});
  }

  ensureLoaded(start: () => Promise<void>): Promise<void> {
    if (this.load !== null) return this.load;
    const load = (this.hasPendingMutations() ? this.settled().then(start) : start()).finally(() => {
      if (this.load === load) this.load = null;
    });
    this.load = load;
    return load;
  }

  scheduleAutoSave(delayMs: number, run: () => void): void {
    this.cancelAutoSave();
    this.autoSaveTimer = window.setTimeout(() => {
      this.autoSaveTimer = undefined;
      run();
    }, delayMs);
  }

  cancelAutoSave(): void {
    if (this.autoSaveTimer === undefined) return;
    window.clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = undefined;
  }
}

export class DocumentControllers {
  private readonly controllers = new Map<NoteId, DocumentController>();

  for(id: NoteId): DocumentController {
    let controller = this.controllers.get(id);
    if (controller === undefined) {
      controller = new DocumentController();
      this.controllers.set(id, controller);
    }
    return controller;
  }

  release(id: NoteId): void {
    const controller = this.controllers.get(id);
    if (controller === undefined) return;
    controller.retire();
    this.forgetWhenSettled(id, controller);
  }

  close(id: NoteId, session: ClosableSession, disposition: CloseDisposition): Promise<void> {
    const controller = this.for(id);
    const closing = controller.close(session, disposition);
    this.forgetWhenSettled(id, controller);
    return closing;
  }

  private forgetWhenSettled(id: NoteId, controller: DocumentController): void {
    if (!controller.hasPendingMutations()) {
      if (this.controllers.get(id) === controller) this.controllers.delete(id);
      return;
    }
    void controller.settled().then(() => {
      if (this.controllers.get(id) === controller && !controller.hasPendingMutations()) this.controllers.delete(id);
    });
  }

  cancelAutoSaves(): void {
    for (const controller of this.controllers.values()) controller.cancelAutoSave();
  }

  disposeAll(): void {
    this.cancelAutoSaves();
    for (const controller of this.controllers.values()) controller.detachSession();
    this.controllers.clear();
  }
}
