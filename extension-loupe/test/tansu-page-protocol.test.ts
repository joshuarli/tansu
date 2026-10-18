import assert from "node:assert/strict";
import { test } from "vitest";
import {
  requestTansuImport,
  waitForTansuReady,
  type TansuMessageEvent,
  type TansuMessageWindow,
} from "../src/tansu-page-protocol.ts";
import type { TansuImportPayload } from "../src/tansu-wire.ts";

const ORIGIN = "https://tansu.example.com",
  ready = { channel: "tansu", version: 1, type: "import.ready" },
  payload: TansuImportPayload = {
    title: "T",
    markdown: "# T",
    sourceUrl: "https://example.com/a",
    images: [],
  };

class FakeWindow implements TansuMessageWindow {
  location = { origin: ORIGIN };
  posted: { message: Record<string, unknown>; targetOrigin: string }[] = [];
  listeners = new Set<(event: TansuMessageEvent) => void>();
  onPost: (message: Record<string, unknown>) => void = () => {};

  postMessage(message: unknown, targetOrigin: string): void {
    const record = message as Record<string, unknown>;
    this.posted.push({ message: record, targetOrigin });
    queueMicrotask(() => this.onPost(record));
  }
  addEventListener(_type: "message", listener: (event: TansuMessageEvent) => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "message", listener: (event: TansuMessageEvent) => void): void {
    this.listeners.delete(listener);
  }
  deliver(data: unknown, overrides: Partial<TansuMessageEvent> = {}): void {
    for (const listener of [...this.listeners]) {
      listener({ source: this, origin: ORIGIN, data, ...overrides });
    }
  }
}

test("pings and resolves when Tansu answers import.ready", async () => {
  const win = new FakeWindow();
  win.onPost = (message) => {
    if (message["type"] === "import.ping") win.deliver(ready);
  };

  assert.equal(await waitForTansuReady(win, 1_000), true);
  assert.deepEqual(win.posted[0], {
    message: { channel: "tansu", type: "import.ping" },
    targetOrigin: ORIGIN,
  });
  assert.equal(win.listeners.size, 0);
});

test("resolves when Tansu announces readiness on its own after a delay", async () => {
  const win = new FakeWindow();
  setTimeout(() => win.deliver(ready), 20);

  assert.equal(await waitForTansuReady(win, 1_000), true);
});

test("times out when Tansu never becomes ready and detaches its listener", async () => {
  const win = new FakeWindow();

  assert.equal(await waitForTansuReady(win, 30), false);
  assert.equal(win.listeners.size, 0);
});

test("ignores readiness from other sources, origins, versions, and channels", async () => {
  const win = new FakeWindow();
  setTimeout(() => {
    win.deliver(ready, { source: {} });
    win.deliver(ready, { origin: "https://evil.example" });
    win.deliver({ ...ready, version: 2 });
    win.deliver({ ...ready, channel: "other" });
    win.deliver("import.ready");
    win.deliver(null);
  }, 5);

  assert.equal(await waitForTansuReady(win, 60), false);
});

test("posts the request with a fresh id and returns the matching result", async () => {
  const win = new FakeWindow();
  win.onPost = (message) => {
    if (message["type"] !== "import.request") return;
    win.deliver({
      channel: "tansu",
      version: 1,
      type: "import.result",
      requestId: "someone-else",
      ok: false,
      error: "wrong",
    });
    win.deliver({
      channel: "tansu",
      version: 1,
      type: "import.result",
      requestId: message["requestId"],
      ok: true,
    });
  };

  const outcome = await requestTansuImport(win, payload, 1_000, { createRequestId: () => "r1" });

  assert.deepEqual(win.posted[0], {
    message: { channel: "tansu", version: 1, type: "import.request", requestId: "r1", ...payload },
    targetOrigin: ORIGIN,
  });
  assert.equal(outcome.kind, "message");
  assert.equal(
    (outcome.kind === "message" ? (outcome.message as Record<string, unknown>)["ok"] : undefined),
    true,
  );
  assert.equal(win.listeners.size, 0);
});

test("a result from a foreign origin is ignored and the request times out", async () => {
  const win = new FakeWindow();
  win.onPost = (message) => {
    win.deliver(
      { channel: "tansu", version: 1, type: "import.result", requestId: message["requestId"], ok: true },
      { origin: "https://evil.example" },
    );
  };

  assert.deepEqual(await requestTansuImport(win, payload, 30), { kind: "timeout", phase: "result" });
  assert.equal(win.listeners.size, 0);
});
