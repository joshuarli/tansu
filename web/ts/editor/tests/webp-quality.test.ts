// @vitest-environment node
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import encode from "../vendor/jsquash-webp/encode.js";

function noisyImage(): ImageData {
  const width = 64;
  const height = 64;
  const data = new Uint8ClampedArray(width * height * 4);
  let seed = 7;
  for (let index = 0; index < data.length; index += 1) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    data[index] = index % 4 === 3 ? 255 : seed >>> 24;
  }
  return { width, height, data, colorSpace: "srgb" } as ImageData;
}

describe("vendored WebP encoder", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("produces a smaller file at a lower quality", async () => {
    const wasm = await readFile(new URL("../vendor/jsquash-webp/codec/enc/webp_enc.wasm", import.meta.url));
    vi.stubGlobal("fetch", async () => new Response(wasm, { headers: { "content-type": "application/wasm" } }));
    const image = noisyImage();
    const low = await encode(image, 0.1);
    const high = await encode(image, 0.95);

    expect(low.type).toBe("image/webp");
    expect(low.size).toBeLessThan(high.size);
  });
});
