import { findLoupeImageOccurrences, resolveLoupeImageUrl } from "./loupe-image-scanner.ts";
import { TANSU_IMAGE_PLACEHOLDER_SCHEME, type TansuImportImage } from "./tansu-wire.ts";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 40 * 1024 * 1024;
export const MAX_IMAGES = 200;
export const IMAGE_FETCH_CONCURRENCY = 4;
export const IMAGE_REQUEST_TIMEOUT_MS = 30_000;
export const IMAGE_ACCEPT_HEADER =
  "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";
export const IMAGE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

function imageResourceUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.hostname !== "substackcdn.com" || !parsed.pathname.startsWith("/image/fetch/")) {
    return parsed.href;
  }
  try {
    const source = new URL(
      decodeURIComponent(parsed.pathname.slice(parsed.pathname.lastIndexOf("/") + 1)),
    );
    return source.protocol === "http:" || source.protocol === "https:" ? source.href : parsed.href;
  } catch {
    return parsed.href;
  }
}

function linkedImageTargetsSameResource(
  linkDestination: string,
  imageUrl: string,
  sourceUrl: string,
): boolean {
  const linkedUrl = resolveLoupeImageUrl(linkDestination, sourceUrl);
  return linkedUrl !== null && imageResourceUrl(linkedUrl) === imageResourceUrl(imageUrl);
}

export interface ExponentialBackoffOptions {
  attempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  sleep?: (delayMs: number) => Promise<void>;
}

export const IMAGE_RETRY_OPTIONS: ExponentialBackoffOptions = {
  attempts: 3,
  initialDelayMs: 500,
  maxDelayMs: 4_000,
};

export interface PlannedTansuImages {
  markdown: string;
  urls: string[];
}

export type ImageFetchOutcome =
  | { status: "fetched"; contentType: string; bytes: Uint8Array }
  | {
      status: "failed";
      reason: "network" | "http" | "empty" | "not-image" | "too-large" | "total-cap";
    };

export function planTansuImages(markdown: string, sourceUrl: string): PlannedTansuImages {
  const urls: string[] = [],
    idByUrl = new Map<string, number>(),
    replacements: { start: number; end: number; text: string }[] = [];
  for (const occurrence of findLoupeImageOccurrences(markdown)) {
    const resolvedUrl = resolveLoupeImageUrl(occurrence.destination, sourceUrl);
    if (resolvedUrl === null) {
      continue;
    }
    const replacementRange = occurrence.linkedImage !== undefined &&
        linkedImageTargetsSameResource(occurrence.linkedImage.destination, resolvedUrl, sourceUrl)
      ? occurrence.linkedImage
      : occurrence;
    let id = idByUrl.get(resolvedUrl);
    if (id === undefined) {
      if (urls.length >= MAX_IMAGES) continue;
      id = urls.length;
      urls.push(resolvedUrl);
      idByUrl.set(resolvedUrl, id);
    }
    replacements.push({
      start: replacementRange.start,
      end: replacementRange.end,
      text: `![${occurrence.alt}](${TANSU_IMAGE_PLACEHOLDER_SCHEME}${id})`,
    });
  }
  let rewritten = markdown;
  for (const replacement of replacements.toReversed()) {
    rewritten =
      rewritten.slice(0, replacement.start) + replacement.text + rewritten.slice(replacement.end);
  }
  return { markdown: rewritten, urls };
}

export function isRetryableImageStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

export async function retryWithExponentialBackoff<T>(
  operation: () => Promise<T>,
  shouldRetryResult: (result: T) => boolean,
  options: ExponentialBackoffOptions,
): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.attempts)),
    sleep =
      options.sleep ??
      ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const result = await operation();
      if (attempt === attempts - 1 || !shouldRetryResult(result)) {
        return result;
      }
    } catch (error) {
      if (attempt === attempts - 1) {
        throw error;
      }
    }
    await sleep(Math.min(options.maxDelayMs, options.initialDelayMs * 2 ** attempt));
  }

  throw new Error("Retry operation did not produce a result.");
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function readImageContentType(headers: Headers): string {
  return (headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    return;
  }
}

export interface FetchTansuImageOptions {
  maxImageBytes?: number;
  shouldStop?: () => boolean;
}

async function readCappedImage(
  response: Response,
  maxImageBytes: number,
  shouldStop: () => boolean,
): Promise<ImageFetchOutcome> {
  if (shouldStop()) {
    await cancelBody(response);
    return { status: "failed", reason: "total-cap" };
  }
  if (!response.ok) {
    await cancelBody(response);
    return { status: "failed", reason: "http" };
  }
  const contentType = readImageContentType(response.headers);
  if (!contentType.startsWith("image/")) {
    await cancelBody(response);
    return { status: "failed", reason: "not-image" };
  }
  if (Number(response.headers.get("content-length")) > maxImageBytes) {
    await cancelBody(response);
    return { status: "failed", reason: "too-large" };
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return { status: "failed", reason: "empty" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (shouldStop()) {
        await reader.cancel();
        return { status: "failed", reason: "total-cap" };
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;
      if (total + value.byteLength > maxImageBytes) {
        await reader.cancel();
        return { status: "failed", reason: "too-large" };
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return { status: "failed", reason: shouldStop() ? "total-cap" : "network" };
  }
  if (total === 0) return { status: "failed", reason: "empty" };
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { status: "fetched", contentType, bytes };
}

export async function fetchTansuImage(
  url: string,
  fetchImpl: typeof globalThis.fetch,
  retryOptions: ExponentialBackoffOptions = IMAGE_RETRY_OPTIONS,
  fetchOptions: FetchTansuImageOptions = {},
): Promise<ImageFetchOutcome> {
  const maxImageBytes = fetchOptions.maxImageBytes ?? MAX_IMAGE_BYTES;
  const shouldStop = fetchOptions.shouldStop ?? (() => false);
  let response: Response;
  try {
    response = await retryWithExponentialBackoff(
      async () => {
        const candidate = await fetchImpl(url, {
          method: "GET",
          headers: { Accept: IMAGE_ACCEPT_HEADER, "User-Agent": IMAGE_USER_AGENT },
          signal: AbortSignal.timeout(IMAGE_REQUEST_TIMEOUT_MS),
        });
        if (isRetryableImageStatus(candidate.status)) await cancelBody(candidate);
        return candidate;
      },
      (candidate) => isRetryableImageStatus(candidate.status),
      retryOptions,
    );
  } catch {
    return { status: "failed", reason: "network" };
  }
  return readCappedImage(response, maxImageBytes, shouldStop);
}

export async function downloadTansuImages(
  urls: readonly string[],
  fetchImpl: typeof globalThis.fetch,
  retryOptions: ExponentialBackoffOptions,
  limits: { maxImageBytes: number; maxTotalBytes: number },
): Promise<ImageFetchOutcome[]> {
  const outcomes: ImageFetchOutcome[] = new Array(urls.length);
  const pending = new Map<number, ImageFetchOutcome>();
  let settled = 0;
  let retained = 0;
  let capReached = false;
  const shouldStop = () => capReached;
  const discard = (outcome: ImageFetchOutcome): ImageFetchOutcome =>
    outcome.status === "fetched" ? { status: "failed", reason: "total-cap" } : outcome;
  const absorb = (): void => {
    while (settled < urls.length) {
      const outcome = outcomes[settled] ?? pending.get(settled);
      if (outcome === undefined) return;
      pending.delete(settled);
      if (
        capReached ||
        (outcome.status === "fetched" && retained + outcome.bytes.byteLength > limits.maxTotalBytes)
      ) {
        capReached = true;
        outcomes[settled] = discard(outcome);
      } else {
        outcomes[settled] = outcome;
        if (outcome.status === "fetched") retained += outcome.bytes.byteLength;
        if (retained >= limits.maxTotalBytes) capReached = true;
      }
      settled += 1;
    }
  };
  await mapWithConcurrency(urls, IMAGE_FETCH_CONCURRENCY, async (url, index) => {
    if (capReached) {
      outcomes[index] = { status: "failed", reason: "total-cap" };
      absorb();
      return;
    }
    const outcome = await fetchTansuImage(url, fetchImpl, retryOptions, {
      maxImageBytes: limits.maxImageBytes,
      shouldStop,
    });
    pending.set(index, capReached ? discard(outcome) : outcome);
    absorb();
  });
  return outcomes;
}

export function applyTotalImageCap(outcomes: readonly ImageFetchOutcome[]): ImageFetchOutcome[] {
  let total = 0;
  return outcomes.map((outcome): ImageFetchOutcome => {
    if (outcome.status !== "fetched") {
      return outcome;
    }
    if (total + outcome.bytes.byteLength > MAX_TOTAL_IMAGE_BYTES) {
      return { status: "failed", reason: "total-cap" };
    }
    total += outcome.bytes.byteLength;
    return outcome;
  });
}

export function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export interface PrepareTansuImportOptions {
  fetchImpl: typeof globalThis.fetch;
  retryOptions?: ExponentialBackoffOptions;
}

export interface PreparedTansuImport {
  markdown: string;
  images: TansuImportImage[];
}

export async function prepareTansuImport(
  markdown: string,
  sourceUrl: string,
  options: PrepareTansuImportOptions,
): Promise<PreparedTansuImport> {
  const planned = planTansuImages(markdown, sourceUrl),
    outcomes = await downloadTansuImages(
      planned.urls,
      options.fetchImpl,
      options.retryOptions ?? IMAGE_RETRY_OPTIONS,
      { maxImageBytes: MAX_IMAGE_BYTES, maxTotalBytes: MAX_TOTAL_IMAGE_BYTES },
    );
  return {
    markdown: planned.markdown,
    images: planned.urls.map((url, id): TansuImportImage => {
      const outcome = outcomes[id];
      return outcome !== undefined && outcome.status === "fetched"
        ? { id, url, contentType: outcome.contentType, base64: bytesToBase64(outcome.bytes) }
        : { id, url, contentType: "", base64: null };
    }),
  };
}
