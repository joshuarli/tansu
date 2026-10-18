import { sanitizeDownloadFilename } from "./download-filename.ts";

function encodeNoteName(noteName: string): string {
  return encodeURIComponent(sanitizeDownloadFilename(noteName));
}

export async function sha256HexOfText(plainText: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(plainText));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The companion obsidian-webp-paste plugin registers this protocol action. The
// Article Markdown itself travels via the clipboard; the URI carries only small
// Metadata plus a SHA-256 of the exact clipboard text so the plugin can refuse
// Stale or mismatched clipboard contents.
export function createObsidianLoupeImportUri(
  noteName: string | undefined,
  sourceUrl: string,
  sha256Hex: string,
): string {
  const query = new URLSearchParams();
  if (noteName) {
    query.set("file", sanitizeDownloadFilename(noteName));
  }
  query.set("source", sourceUrl);
  query.set("sha256", sha256Hex);
  return `obsidian://loupe-import?${query}`;
}

export function createObsidianClipboardUri(noteName?: string): string {
  const fileQuery = noteName ? `file=${encodeNoteName(noteName)}&` : "",
    // &clipboard tells Obsidian to read note content from the clipboard instead
    // Of the content param. content is a fallback shown only if Obsidian can't
    // Access the clipboard.
    clipboardFallback = encodeURIComponent("Loupe could not access the clipboard.");
  return `obsidian://new?${fileQuery}clipboard&content=${clipboardFallback}`;
}

export function createObsidianImportUri(readerMarkdown: string, noteName?: string): string {
  const fileQuery = noteName ? `file=${encodeNoteName(noteName)}&` : "";
  return `obsidian://new?${fileQuery}content=${encodeURIComponent(readerMarkdown)}`;
}
