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
  it("creates the journal lazily and tears it down exactly once", async () => {
    const fake = workspace();
    const handle = new JournalHandle(fake, () => {});
    expect(fake.createJournal).not.toHaveBeenCalled();

    await handle.flushAll();
    expect(fake.flushAll).not.toHaveBeenCalled();

    expect(handle.get()).toBe(fake.journal);
    expect(handle.get()).toBe(fake.journal);
    expect(fake.createJournal).toHaveBeenCalledTimes(1);
    expect(fake.attachVisibilityFlush).toHaveBeenCalledTimes(1);

    await handle.dispose();
    await handle.dispose();
    expect(fake.flushAll).toHaveBeenCalledTimes(1);
    expect(fake.detach).toHaveBeenCalledTimes(1);
    expect(() => handle.get()).toThrow("disposed");
    expect(fake.createJournal).toHaveBeenCalledTimes(1);
  });

  it("never creates an unused journal and reports a failed flush", async () => {
    const unused = workspace();
    const pristine = new JournalHandle(unused, () => {});
    await pristine.dispose();
    expect(() => pristine.get()).toThrow("disposed");
    expect(unused.createJournal).not.toHaveBeenCalled();

    const fake = workspace();
    fake.flushAll.mockRejectedValueOnce(new Error("quota"));
    const handle = new JournalHandle(fake, () => {});
    handle.get();
    await expect(handle.dispose()).rejects.toThrow("quota");
    expect(fake.detach).toHaveBeenCalledTimes(1);
  });
});
