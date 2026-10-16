import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const vendorRoot = resolve(import.meta.dirname, "..", "web/ts/editor/vendor/jsquash-webp");
const javascript = "text/javascript; charset=utf-8";
const files = [
  ["encode.js", javascript],
  ["meta.js", javascript],
  ["utils.js", javascript],
  ["codec/enc/webp_enc.js", javascript],
  ["codec/enc/webp_enc.wasm", "application/wasm"],
];

export async function webpEncoderBaseUrl(sourceRoot = vendorRoot) {
  const digest = createHash("sha256");
  for (const [name] of files) {
    digest.update(`${name}\0`);
    digest.update(await readFile(resolve(sourceRoot, name)));
  }
  return `/assets/jsquash-webp.${digest.digest("hex").slice(0, 12)}`;
}

export async function webpEncoderAssets(sourceRoot = vendorRoot) {
  const baseUrl = await webpEncoderBaseUrl(sourceRoot);
  return files.map(([name, contentType]) => ({
    source: resolve(sourceRoot, name),
    url: `${baseUrl}/${name}`,
    file: `${baseUrl.slice(1)}/${name}`,
    contentType,
    immutable: true,
  }));
}
