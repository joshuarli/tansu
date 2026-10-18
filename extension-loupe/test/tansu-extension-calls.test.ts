import { expect, test } from "vitest";
import { tansuPageCall } from "../src/tansu-page-call.ts";
import { readTansuSettings } from "../src/tansu-settings.ts";

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
  (globalThis as Record<string, unknown>)["api"] = {
    requestImport: (...values: unknown[]) => received.push(values),
  };
  call.func(...(structuredClone(call.args) as [string]));
  delete (globalThis as Record<string, unknown>)["api"];
  expect(received).toStrictEqual([[payload, 5]]);
  expect(Object.hasOwn((received[0]![0] as typeof payload).images[0]!, "base64")).toBeTruthy();
});
