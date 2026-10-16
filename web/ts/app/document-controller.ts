import type { NoteId } from "./identity.ts";

export class DocumentController {
  private load: Promise<void> | null = null;
  private autoSaveTimer: number | undefined;

  ensureLoaded(start: () => Promise<void>): Promise<void> {
    if (this.load !== null) return this.load;
    const load = start().finally(() => {
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
    this.controllers.get(id)?.cancelAutoSave();
    this.controllers.delete(id);
  }

  cancelAutoSaves(): void {
    for (const controller of this.controllers.values()) controller.cancelAutoSave();
  }

  disposeAll(): void {
    this.cancelAutoSaves();
    this.controllers.clear();
  }
}
