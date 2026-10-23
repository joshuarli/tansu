import type { DocumentSessionState, Selection } from "./document-session.ts";
import { documentIdentityKey, type DocumentIdentity, type NoteId } from "./identity.ts";

export type DirtySnapshot = {
  draft: string | null;
  selection: Selection | undefined;
  dirty: boolean;
  saving: boolean;
  conflict: boolean;
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
    conflict: value.status === "conflict",
    title: "title" in value ? value.titleDraft ?? value.title : undefined,
    path: "path" in value ? value.path : undefined,
  };
}

export type SessionSource = {
  readonly identity: DocumentIdentity;
  subscribe(listener: (state: DocumentSessionState) => void): () => void;
};

export type ControllerTask = {
  readonly signal: AbortSignal;
  deliver(completion: () => void): boolean;
  cancel(): void;
  finish(): void;
};

export type ClosableSession = {
  save(): Promise<unknown>;
  close(): void;
};

export type CloseDisposition = "flush" | "discard";

export class DocumentController {
  private load: Promise<void> | null = null;
  private readonly mutations = new Set<Promise<unknown>>();
  private readonly tasks = new Set<ControllerTask>();
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
    this.cancelTasks();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.session = null;
  }

  beginTask(session: SessionSource): ControllerTask {
    if (this.session !== session) throw new TypeError("Cannot issue a task for a detached document session");
    const identityKey = documentIdentityKey(session.identity);
    const controller = new AbortController();
    let active = true;
    const end = (cancel: boolean) => {
      if (!active) return;
      active = false;
      this.tasks.delete(task);
      if (cancel) controller.abort();
    };
    const task: ControllerTask = {
      signal: controller.signal,
      deliver: (completion) => {
        if (!active || controller.signal.aborted || this.session !== session ||
          documentIdentityKey(this.session.identity) !== identityKey) {
          end(true);
          return false;
        }
        completion();
        return true;
      },
      cancel: () => end(true),
      finish: () => end(false),
    };
    this.tasks.add(task);
    return task;
  }

  track<T>(mutation: Promise<T>): Promise<T> {
    const tracked = mutation.finally(() => this.mutations.delete(tracked));
    tracked.catch(() => undefined);
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
    const pending = [...this.mutations];
    const closing = Promise.allSettled(pending)
      .then(() => session.save())
      .finally(() => session.close());
    return this.track(closing).then(() => undefined);
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

  private cancelTasks(): void {
    for (const task of this.tasks) task.cancel();
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

  hasPendingMutations(): boolean {
    return [...this.controllers.values()].some((controller) => controller.hasPendingMutations());
  }

  async settled(): Promise<void> {
    for (;;) {
      const pending = [...this.controllers.values()].filter((controller) => controller.hasPendingMutations());
      if (pending.length === 0) return;
      await Promise.all(pending.map((controller) => controller.settled()));
    }
  }

  disposeAll(): void {
    this.cancelAutoSaves();
    for (const controller of this.controllers.values()) controller.detachSession();
    this.controllers.clear();
  }
}
