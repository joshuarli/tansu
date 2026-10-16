import assert from "node:assert/strict";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, it } from "vitest";

import { webpEncoderAssets, webpEncoderBaseUrl } from "./webp-encoder.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const VENDOR_ROOT = resolve(REPO_ROOT, "web/ts/editor/vendor/jsquash-webp");

async function vendorTree(changes) {
  const root = await mkdtemp(join(REPO_ROOT, ".work", "tmp", "webp-encoder-"));
  await cp(VENDOR_ROOT, root, { recursive: true });
  for (const [name, content] of Object.entries(changes)) {
    await writeFile(resolve(root, name), content);
  }
  return root;
}

describe("webp encoder asset URLs", () => {
  it("change when any encoder file changes and stay put otherwise", async () => {
    const original = await webpEncoderBaseUrl(await vendorTree({}));
    assert.equal(original, await webpEncoderBaseUrl());
    assert.notEqual(await webpEncoderBaseUrl(await vendorTree({ "codec/enc/webp_enc.wasm": "x" })), original);
    assert.notEqual(await webpEncoderBaseUrl(await vendorTree({ "encode.js": "b" })), original);
  });

  it("place every shipped encoder file under the fingerprinted base URL", async () => {
    const baseUrl = await webpEncoderBaseUrl();
    const assets = await webpEncoderAssets();
    assert.ok(assets.length > 0);
    for (const asset of assets) {
      assert.ok(`/${asset.file}`.startsWith(`${baseUrl}/`), asset.file);
      assert.equal(asset.immutable, true);
    }
    assert.ok(assets.some((asset) => asset.file === `${baseUrl.slice(1)}/encode.js`));
  });
});
