import { blake3 } from "@noble/hashes/blake3.js";

export async function canonicalSourceHash(content: string): Promise<string> {
  const normalized = content.replaceAll(/\r\n?/g, "\n");
  const bytes = new TextEncoder().encode(normalized);
  return `blake3-v3:${Array.from(blake3(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
