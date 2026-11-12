import { describe, expect, it } from "vitest";
import {
  acquireWorkspaceLock,
  OwnershipGate,
  SharedLockManager,
} from "./workspace-ownership.ts";

describe("workspace write ownership", () => {
  it("gives one waiter the lock and lets the next exclusive request wait", async () => {
    const locks = new SharedLockManager();
    const first = await acquireWorkspaceLock(locks, "workspace", { ifAvailable: true });
    if (first === null) throw new Error("Expected the first window to own the workspace");
    await expect(acquireWorkspaceLock(locks, "workspace", { ifAvailable: true })).resolves.toBeNull();

    const secondRelease: { current: (() => void) | null } = { current: null };
    const second = acquireWorkspaceLock(locks, "workspace", { ifAvailable: false }).then((hold) => {
      secondRelease.current = hold?.release ?? null;
      return hold !== null;
    });
    let granted = false;
    void second.then((owned) => {
      granted = owned;
    });
    await Promise.resolve();
    expect(granted).toBeFalsy();

    first.release();
    await expect(second).resolves.toBeTruthy();
    secondRelease.current?.();
  });

  it("drops an aborted waiter so the next window can take the lock", async () => {
    const locks = new SharedLockManager();
    const first = await acquireWorkspaceLock(locks, "workspace", { ifAvailable: true });
    if (first === null) throw new Error("Expected the first window to own the workspace");
    const abort = new AbortController();
    const waiting = acquireWorkspaceLock(locks, "workspace", { ifAvailable: false, signal: abort.signal });
    const outcome = waiting.then(() => "granted", () => "aborted");
    abort.abort();
    await expect(outcome).resolves.toBe("aborted");
    first.release();
    await Promise.resolve();
    await Promise.resolve();
    const next = await acquireWorkspaceLock(locks, "workspace", { ifAvailable: true });
    if (next === null) throw new Error("Expected the lock to be free after the waiter aborted");
    next.release();
  });

  it("finishes an in-flight write and refuses a write that starts after release", async () => {
    const gate = new OwnershipGate();
    gate.allow();
    let finishWrite: ((written: boolean) => void) | undefined;
    const inflight = gate.run(() => new Promise<boolean>((resolve) => {
      finishWrite = resolve;
    }), false);
    const released = gate.drain();
    gate.close();
    let drained = false;
    void released.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBeFalsy();
    await expect(gate.run(async () => true, false)).resolves.toBeFalsy();

    finishWrite?.(true);
    await expect(inflight).resolves.toBeTruthy();
    await released;
  });
});
