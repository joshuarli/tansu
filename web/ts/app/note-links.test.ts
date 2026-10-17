import { describe, expect, it } from "vitest";

import { createNoteLinksLoader, createNotePreviewCache, type NoteLinksOutcome } from "./note-links.ts";
import type { V2NoteLinksResponse } from "../types.generated.ts";

const empty: V2NoteLinksResponse = { backlinks: [], outgoing: [] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("note links loader", () => {
  it("drops a superseded response and aborts its request", async () => {
    const requests = new Map<string, ReturnType<typeof deferred<V2NoteLinksResponse>>>();
    const signals = new Map<string, AbortSignal>();
    const outcomes: NoteLinksOutcome[] = [];
    const loader = createNoteLinksLoader((id, signal) => {
      const request = deferred<V2NoteLinksResponse>();
      requests.set(id, request);
      signals.set(id, signal);
      return request.promise;
    }, (outcome) => outcomes.push(outcome));

    loader.load("a");
    loader.load("b");
    expect(signals.get("a")!.aborted).toBe(true);
    requests.get("a")!.resolve(empty);
    requests.get("b")!.resolve(empty);
    await Promise.resolve();
    await Promise.resolve();
    expect(outcomes).toStrictEqual([{ noteId: "b", phase: "ready", links: empty }]);
  });

  it("reports failures for the current request and stays silent after cancel", async () => {
    const outcomes: NoteLinksOutcome[] = [];
    const failing = deferred<V2NoteLinksResponse>();
    const loader = createNoteLinksLoader(() => failing.promise, (outcome) => outcomes.push(outcome));
    loader.load("a");
    failing.reject(new Error("offline"));
    await failing.promise.catch(() => undefined);
    await Promise.resolve();
    expect(outcomes).toStrictEqual([{ noteId: "a", phase: "error", message: "offline" }]);

    const late = deferred<V2NoteLinksResponse>();
    const cancelled = createNoteLinksLoader(() => late.promise, (outcome) => outcomes.push(outcome));
    cancelled.load("b");
    cancelled.cancel();
    late.resolve(empty);
    await late.promise;
    await Promise.resolve();
    expect(outcomes).toHaveLength(1);
  });
});

describe("note preview cache", () => {
  it("serves repeats from cache, shares in-flight requests, and evicts least recently used", async () => {
    const calls: string[] = [];
    const cache = createNotePreviewCache(async (id) => {
      calls.push(id);
      return `preview ${id}`;
    }, 2);
    const [first, second] = await Promise.all([cache.load("a"), cache.load("a")]);
    expect(first).toBe(second);
    expect(calls).toStrictEqual(["a"]);

    await cache.load("b");
    await cache.load("a");
    await cache.load("c");
    await cache.load("a");
    expect(calls).toStrictEqual(["a", "b", "c"]);
    await cache.load("b");
    expect(calls).toStrictEqual(["a", "b", "c", "b"]);
  });

  it("does not cache failures or results that finish after a clear", async () => {
    let fail = true;
    const late = deferred<string>();
    const calls: string[] = [];
    const cache = createNotePreviewCache((id) => {
      calls.push(id);
      if (id === "slow") return late.promise;
      if (fail) return Promise.reject(new Error("nope"));
      return Promise.resolve("ok");
    });
    await expect(cache.load("a")).rejects.toThrow("nope");
    fail = false;
    await expect(cache.load("a")).resolves.toBe("ok");

    const pending = cache.load("slow");
    cache.clear();
    late.resolve("stale");
    await pending;
    await cache.load("slow");
    expect(calls.filter((id) => id === "slow")).toHaveLength(2);
  });
});
