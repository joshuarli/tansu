import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { resolve } from "node:path";

export async function fileSha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node scripts/artifact-hash.mjs <artifact>");
    process.exit(2);
  }
  console.log(`sha256:${await fileSha256(path)} ${resolve(path)}`);
}
