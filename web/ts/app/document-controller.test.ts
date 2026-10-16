import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentControllers } from "./document-controller.ts";
import { noteId } from "./identity.ts";

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
