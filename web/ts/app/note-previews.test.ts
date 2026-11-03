import { describe, expect, it } from "vitest";

import { createNotePreviewCache } from "./note-previews.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
