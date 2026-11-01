import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import { tansuPageCall } from "../src/tansu-page-call.ts";
import { readTansuSettings } from "../src/tansu-settings.ts";

function runInPageWorld(call: ReturnType<typeof tansuPageCall>, page: Record<string, unknown> = {}): unknown {
  const pageFunction = runInNewContext(`(${call.func.toString()})`, page) as typeof call.func;
  return pageFunction(...structuredClone(call.args));
}

test("reads the saved origin from storage that returns nothing for an empty default object", async () => {
  const stored: Record<string, unknown> = { tansuOrigin: "http://localhost:3000" };
  const storage = {
    get: async (keys: string | object) =>
      typeof keys === "string" && keys in stored ? { [keys]: stored[keys] } : {},
  };
  await expect(readTansuSettings(storage)).resolves.toStrictEqual({
    tansuOrigin: "http://localhost:3000",
  });
});

test("delivers null image bytes to the page API", () => {
  const payload = { images: [{ id: "a", url: "u", contentType: "image/png", base64: null }] };
  const call = tansuPageCall(1, "api", "requestImport", [payload, 5]);
  const received: unknown[][] = [];
  runInPageWorld(call, {
    api: {
      requestImport: (...values: unknown[]) => received.push(values),
    },
  });
  expect(JSON.stringify(received)).toBe(JSON.stringify([[payload, 5]]));
  expect(Object.hasOwn((received[0]![0] as typeof payload).images[0]!, "base64")).toBeTruthy();
});

test("rejects malformed page calls with a descriptive error", () => {
  const call = tansuPageCall(1, "api", "requestImport", [{}]);
  for (const encoded of [
    JSON.stringify(["api", "requestImport"]),
    JSON.stringify(["api", "requestImport", [], "extra"]),
    JSON.stringify([42, "requestImport", []]),
    JSON.stringify(["api", 42, []]),
    JSON.stringify(["api", "requestImport", {}]),
    JSON.stringify("requestImport"),
  ]) {
    assert.throws(() => runInPageWorld({ ...call, args: [encoded] }), /malformed Tansu page call/, encoded);
  }
});

test("rejects page calls when the page API or method is missing", () => {
  const missingApi = tansuPageCall(1, "missing-api", "requestImport", []);
  expect(() => runInPageWorld(missingApi)).toThrow(/page API is not available/);

  const call = tansuPageCall(1, "api", "waitForReady", []);
  expect(() => runInPageWorld(call, { api: { requestImport: () => {} } }))
    .toThrow(/page API is not available/);
});
