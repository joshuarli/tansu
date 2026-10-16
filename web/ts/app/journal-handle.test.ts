import { describe, expect, it, vi } from "vitest";
import { JournalHandle } from "./journal-handle.ts";
import type { AppServices } from "./services.ts";

function workspace() {
  const detach = vi.fn();
  const flushAll = vi.fn(async () => {});
  const journal = { flushAll } as unknown as ReturnType<AppServices["workspace"]["createJournal"]>;
  const createJournal = vi.fn(() => journal);
  const attachVisibilityFlush = vi.fn(() => detach);
  return { createJournal, attachVisibilityFlush, detach, flushAll, journal };
}

describe("JournalHandle", () => {
  it("creates the journal lazily, once, and attaches visibility flush once", () => {
    const fake = workspace();
    const handle = new JournalHandle(fake, () => {});
    expect(fake.createJournal).not.toHaveBeenCalled();

    expect(handle.get()).toBe(fake.journal);
    expect(handle.get()).toBe(fake.journal);

    expect(fake.createJournal).toHaveBeenCalledTimes(1);
    expect(fake.attachVisibilityFlush).toHaveBeenCalledTimes(1);
  });

  it("flushes nothing before the journal exists", async () => {
    const fake = workspace();
    await new JournalHandle(fake, () => {}).flushAll();
    expect(fake.flushAll).not.toHaveBeenCalled();
  });

  it("dispose flushes, detaches visibility flush, and refuses to recreate a journal", async () => {
    const fake = workspace();
    const handle = new JournalHandle(fake, () => {});
    handle.get();

    await handle.dispose();
    await handle.dispose();

    expect(fake.flushAll).toHaveBeenCalledTimes(1);
    expect(fake.detach).toHaveBeenCalledTimes(1);
    expect(() => handle.get()).toThrow("disposed");
    expect(fake.createJournal).toHaveBeenCalledTimes(1);
  });

  it("dispose before first use never creates a journal", async () => {
    const fake = workspace();
    const handle = new JournalHandle(fake, () => {});
    await handle.dispose();
    expect(() => handle.get()).toThrow("disposed");
    expect(fake.createJournal).not.toHaveBeenCalled();
  });

  it("reports a failed flush to the caller of dispose", async () => {
    const fake = workspace();
    fake.flushAll.mockRejectedValueOnce(new Error("quota"));
    const handle = new JournalHandle(fake, () => {});
    handle.get();
    await expect(handle.dispose()).rejects.toThrow("quota");
    expect(fake.detach).toHaveBeenCalledTimes(1);
  });
});
