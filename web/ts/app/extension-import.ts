export const EXTENSION_IMPORT_CHANNEL = "tansu";
export const EXTENSION_IMPORT_VERSION = 1;
export const IMAGE_TOKEN_PREFIX = "tansu-import-image:";

export const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 40 * 1024 * 1024;
const MAX_IMAGES = 200;
const MAX_REQUEST_ID_LENGTH = 200;
const MAX_URL_LENGTH = 4096;
const MAX_CONTENT_TYPE_LENGTH = 100;
const MAX_TITLE_LENGTH = 200;
const DEFAULT_TITLE = "Imported";

const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"]);
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export type ImportImage = {
  id: number;
  url: string;
  contentType: string;
  base64: string | null;
};

export type ImportRequest = {
  requestId: string;
  title: string;
  markdown: string;
  sourceUrl: string;
  images: ImportImage[];
};

export type ImportMessage =
  | { kind: "ping" }
  | { kind: "request"; request: ImportRequest }
  | { kind: "invalid"; requestId: string; error: string };

export type ImportResultMessage =
  | {
    channel: "tansu";
    version: 1;
    type: "import.result";
    requestId: string;
    ok: true;
    noteId: string;
    path: string;
    imagesLocalized: number;
    imagesFailed: number;
  }
  | { channel: "tansu"; version: 1; type: "import.result"; requestId: string; ok: false; error: string };

export type LocalizedImage = { markdown: string } | null;

export function readyMessage(): { channel: "tansu"; version: 1; type: "import.ready" } {
  return { channel: EXTENSION_IMPORT_CHANNEL, version: EXTENSION_IMPORT_VERSION, type: "import.ready" };
}

export function successMessage(
  requestId: string,
  note: { noteId: string; path: string },
  imagesLocalized: number,
  imagesFailed: number,
): ImportResultMessage {
  return {
    channel: EXTENSION_IMPORT_CHANNEL,
    version: EXTENSION_IMPORT_VERSION,
    type: "import.result",
    requestId,
    ok: true,
    noteId: note.noteId,
    path: note.path,
    imagesLocalized,
    imagesFailed,
  };
}

export function failureMessage(requestId: string, error: string): ImportResultMessage {
  return { channel: EXTENSION_IMPORT_CHANNEL, version: EXTENSION_IMPORT_VERSION, type: "import.result", requestId, ok: false, error };
}

export function isTrustedSender(event: { source: unknown; origin: string }, page: { location: { origin: string } }): boolean {
  return event.source === page && event.origin === page.location.origin;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function base64DecodedSize(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor(base64.length * 3 / 4) - padding;
}

export function decodeBase64(base64: string): Uint8Array {
  if (base64.length % 4 !== 0 || !BASE64_PATTERN.test(base64)) throw new TypeError("Image data is not valid base64");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function imageBlob(image: ImportImage): Blob | null {
  if (image.base64 === null) return null;
  const contentType = image.contentType.trim().toLowerCase();
  if (!SUPPORTED_IMAGE_TYPES.has(contentType)) return null;
  return new Blob([decodeBase64(image.base64) as BlobPart], { type: contentType });
}

function decodeImage(value: unknown, index: number): ImportImage | string {
  const image = record(value);
  if (image === null) return `images[${index}] must be an object`;
  if (image["id"] !== index) return `images[${index}].id must equal its index`;
  const url = httpUrl(image["url"]);
  if (url === null) return `images[${index}].url must be an absolute http(s) URL`;
  const contentType = image["contentType"];
  if (typeof contentType !== "string" || contentType.length > MAX_CONTENT_TYPE_LENGTH) {
    return `images[${index}].contentType must be a short string`;
  }
  const base64 = image["base64"];
  if (base64 !== null && typeof base64 !== "string") return `images[${index}].base64 must be a string or null`;
  return { id: index, url, contentType, base64 };
}

export function decodeImportMessage(data: unknown): ImportMessage | null {
  const body = record(data);
  if (body === null || body["channel"] !== EXTENSION_IMPORT_CHANNEL) return null;
  if (body["type"] === "import.ping") return { kind: "ping" };
  if (body["type"] !== "import.request") return null;
  const requestId = body["requestId"];
  if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > MAX_REQUEST_ID_LENGTH) return null;
  const invalid = (error: string): ImportMessage => ({ kind: "invalid", requestId, error });
  if (body["version"] !== EXTENSION_IMPORT_VERSION) return invalid("Unsupported import protocol version");
  const title = body["title"];
  if (typeof title !== "string") return invalid("title must be a string");
  const markdown = body["markdown"];
  if (typeof markdown !== "string") return invalid("markdown must be a string");
  if (markdown.length > MAX_MARKDOWN_BYTES || new TextEncoder().encode(markdown).length > MAX_MARKDOWN_BYTES) {
    return invalid("markdown exceeds the 5 MB limit");
  }
  const sourceUrl = httpUrl(body["sourceUrl"]);
  if (sourceUrl === null) return invalid("sourceUrl must be an absolute http(s) URL");
  const rawImages = body["images"];
  if (!Array.isArray(rawImages)) return invalid("images must be an array");
  if (rawImages.length > MAX_IMAGES) return invalid(`images exceeds the ${MAX_IMAGES} image limit`);
  const images: ImportImage[] = [];
  let totalBytes = 0;
  for (const [index, raw] of rawImages.entries()) {
    const image = decodeImage(raw, index);
    if (typeof image === "string") return invalid(image);
    if (image.base64 !== null) {
      const size = base64DecodedSize(image.base64);
      if (size > MAX_IMAGE_BYTES) return invalid(`images[${index}] exceeds the 10 MB limit`);
      totalBytes += size;
      if (totalBytes > MAX_TOTAL_IMAGE_BYTES) return invalid("images exceed the 40 MB total limit");
    }
    images.push(image);
  }
  return { kind: "request", request: { requestId, title, markdown, sourceUrl, images } };
}

export function importTitle(request: Pick<ImportRequest, "title" | "sourceUrl">): string {
  const title = request.title.replaceAll(/\p{Cc}+/gu, " ").replaceAll(/\s+/g, " ").trim().slice(0, MAX_TITLE_LENGTH).trim();
  if (title !== "") return title;
  try {
    const host = new URL(request.sourceUrl).hostname;
    if (host !== "") return host;
  } catch {
    return DEFAULT_TITLE;
  }
  return DEFAULT_TITLE;
}

function remoteImageUrl(images: readonly ImportImage[], id: string): string {
  const url = images[Number(id)]?.url ?? "";
  return url.replaceAll("(", "%28").replaceAll(")", "%29");
}

const IMAGE_EMBED_PATTERN = /!\[((?:\\.|(?!\]\()[^\\\n])*)\]\(tansu-import-image:(\d+)\)/g;
const IMAGE_TOKEN_PATTERN = /\]\(tansu-import-image:(\d+)\)/g;

export function rewriteImageTokens(
  markdown: string,
  images: readonly ImportImage[],
  localized: readonly LocalizedImage[],
): string {
  return markdown
    .replaceAll(IMAGE_EMBED_PATTERN, (_match, alt: string, id: string) => {
      const local = localized[Number(id)];
      return local === null || local === undefined ? `![${alt}](${remoteImageUrl(images, id)})` : local.markdown;
    })
    .replaceAll(IMAGE_TOKEN_PATTERN, (_match, id: string) => `](${remoteImageUrl(images, id)})`);
}
