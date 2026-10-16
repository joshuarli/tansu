import type { AppServices } from "./services.ts";

type Workspace = Pick<AppServices["workspace"], "createJournal" | "attachVisibilityFlush">;
type Journal = ReturnType<Workspace["createJournal"]>;

export class JournalHandle {
  private journal: Journal | null = null;
  private detachVisibilityFlush: (() => void) | null = null;
  private disposed = false;

  constructor(
    private readonly workspace: Workspace,
    private readonly onFailure: (error: unknown) => void,
  ) {}

  get(): Journal {
    if (this.disposed) throw new Error("The draft journal was disposed");
    if (this.journal !== null) return this.journal;
    this.journal = this.workspace.createJournal(this.onFailure);
    this.detachVisibilityFlush = this.workspace.attachVisibilityFlush(this.journal);
    return this.journal;
  }

  flushAll(): Promise<void> {
    return this.journal?.flushAll() ?? Promise.resolve();
  }

  dispose(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const flushed = this.flushAll();
    this.disposed = true;
    this.detachVisibilityFlush?.();
    this.detachVisibilityFlush = null;
    return flushed;
  }
}
