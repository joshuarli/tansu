import type { ServerIdentity, WorkspaceId } from "./identity.ts";

export class OwnershipGate {
  private open = false;
  private active = 0;
  private idle: Array<() => void> = [];

  allow(): void {
    this.open = true;
  }

  get accepts(): boolean {
    return this.open;
  }

  run<T>(operation: () => Promise<T>, refused: T): Promise<T> {
    if (!this.open) return Promise.resolve(refused);
    this.active += 1;
    return operation().finally(() => {
      this.active -= 1;
      if (!this.open && this.active === 0) this.resolveIdle();
    });
  }

  close(): void {
    this.open = false;
    if (this.active === 0) this.resolveIdle();
  }

  drain(): Promise<void> {
    if (this.active === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.idle.push(resolve);
    });
  }

  private resolveIdle(): void {
    const waiting = this.idle.splice(0);
    for (const resolve of waiting) resolve();
  }
}

export type WorkspaceLockGrant = { name: string } | null;

export type WorkspaceLockManager = {
  request(
    name: string,
    options: { mode?: "exclusive"; ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: WorkspaceLockGrant) => Promise<void>,
  ): Promise<void>;
};

export type WorkspaceWriteGate = {
  run<T>(operation: () => Promise<T>, refused: T): Promise<T>;
};

const WAITER_LIMIT = 32;

function aborted(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

export function workspaceLockName(identity: ServerIdentity, workspaceId: WorkspaceId): string {
  return `tansu-workspace:${identity.serverInstanceId}:${identity.vaultId}:${workspaceId}`;
}

export function workspaceLocks(): WorkspaceLockManager | null {
  const locks = globalThis.navigator?.locks as WorkspaceLockManager | null | undefined;
  if (locks !== null && locks !== undefined && typeof locks.request === "function") return locks;
  return null;
}

export function acquireWorkspaceLock(
  locks: WorkspaceLockManager,
  name: string,
  options: { ifAvailable: boolean; signal?: AbortSignal },
): Promise<{ release(): void } | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error("Workspace lock request failed"));
    };
    if (options.signal?.aborted) {
      fail(aborted(options.signal));
      return;
    }
    const requestOptions = options.signal === undefined
      ? { mode: "exclusive" as const, ifAvailable: options.ifAvailable }
      : { mode: "exclusive" as const, ifAvailable: options.ifAvailable, signal: options.signal };
    void locks.request(
      name,
      requestOptions,
      (lock) => {
        if (lock === null || options.signal?.aborted) {
          if (!settled) {
            settled = true;
            if (options.signal?.aborted) reject(aborted(options.signal));
            else resolve(null);
          }
          return Promise.resolve();
        }
        return new Promise<void>((release) => {
          const finish = () => release();
          if (settled) {
            finish();
            return;
          }
          settled = true;
          resolve({ release: finish });
        });
      },
    ).catch(fail);
  });
}

export class SharedLockManager implements WorkspaceLockManager {
  private readonly holders = new Set<string>();
  private readonly queues = new Map<string, Array<() => void>>();

  request(
    name: string,
    options: { mode?: "exclusive"; ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: WorkspaceLockGrant) => Promise<void>,
  ): Promise<void> {
    if (options.mode !== undefined && options.mode !== "exclusive") {
      return Promise.reject(new Error("Workspace locks are exclusive"));
    }
    if (options.signal?.aborted) return Promise.reject(aborted(options.signal));
    const unavailable = options.ifAvailable === true && (this.holders.has(name) || this.queued(name));
    if (unavailable) return Promise.resolve(callback(null)).then(() => undefined);
    if (this.holders.has(name)) return this.enqueue(name, options.signal, callback);
    return this.start(name, callback);
  }

  private queued(name: string): boolean {
    return (this.queues.get(name)?.length ?? 0) > 0;
  }

  private enqueue(
    name: string,
    signal: AbortSignal | undefined,
    callback: (lock: WorkspaceLockGrant) => Promise<void>,
  ): Promise<void> {
    const queue = this.queues.get(name) ?? [];
    if (queue.length >= WAITER_LIMIT) {
      return Promise.reject(new Error("Too many windows are waiting for this workspace"));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const start = () => {
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) {
          fail(aborted(signal));
          this.queues.get(name)?.shift()?.();
          return;
        }
        this.start(name, callback).then((value) => {
          if (!settled) {
            settled = true;
            resolve(value);
          }
        }, fail);
      };
      const onAbort = () => {
        if (signal === undefined) return;
        const current = this.queues.get(name);
        const index = current?.indexOf(start) ?? -1;
        if (index !== -1) current?.splice(index, 1);
        fail(aborted(signal));
      };
      if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });
      queue.push(start);
      this.queues.set(name, queue);
    });
  }

  private start(name: string, callback: (lock: WorkspaceLockGrant) => Promise<void>): Promise<void> {
    this.holders.add(name);
    return Promise.resolve(callback({ name })).then(() => undefined).finally(() => {
      this.holders.delete(name);
      this.queues.get(name)?.shift()?.();
    });
  }
}

const transferListeners = new Map<string, Set<() => void>>();

export function requestWorkspaceTransfer(name: string): void {
  transferListeners.get(name)?.forEach((listener) => listener());
  if (typeof BroadcastChannel !== "function") return;
  const channel = new BroadcastChannel(name);
  channel.postMessage("transfer");
  channel.close();
}

export function listenForWorkspaceTransfer(name: string, listener: () => void): () => void {
  const group = transferListeners.get(name) ?? new Set<() => void>();
  group.add(listener);
  transferListeners.set(name, group);
  let channel: BroadcastChannel | null = null;
  if (typeof BroadcastChannel === "function") {
    channel = new BroadcastChannel(name);
    channel.onmessage = () => listener();
  }
  return () => {
    group.delete(listener);
    channel?.close();
  };
}
