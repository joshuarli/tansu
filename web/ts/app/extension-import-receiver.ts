import { webpAssetMarkdown } from "../editor/image-webp.ts";
import {
  decodeImportMessage,
  failureMessage,
  imageBlob,
  importTitle,
  isTrustedSender,
  readyMessage,
  rewriteImageTokens,
  successMessage,
  type ImportImage,
  type ImportRequest,
  type ImportResultMessage,
  type LocalizedImage,
} from "./extension-import.ts";

const IMAGE_CONCURRENCY = 4;

export type ExtensionImportHost = {
  isReady(): boolean;
  imageWebpQuality(): number;
  convertToWebp(image: Blob, quality: number): Promise<Blob>;
  uploadImage(image: Blob, signal: AbortSignal): Promise<{ name: string; markdown: string }>;
  createNote(note: { title: string; markdown: string }): Promise<{ noteId: string; path: string }>;
};

type ImportPage = Pick<Window, "addEventListener" | "removeEventListener" | "postMessage"> & {
  location: { origin: string };
};

export type ExtensionImportReceiver = {
  announceReady(): void;
  cancel(): void;
  dispose(): void;
};

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) throw new Error("Concurrency worker ran past the end of its items");
      results[index] = await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function localizeImages(
  images: readonly ImportImage[],
  host: Pick<ExtensionImportHost, "imageWebpQuality" | "convertToWebp" | "uploadImage">,
  signal: AbortSignal,
): Promise<LocalizedImage[]> {
  const quality = host.imageWebpQuality();
  return mapWithConcurrency(images, IMAGE_CONCURRENCY, async (image): Promise<LocalizedImage> => {
    try {
      signal.throwIfAborted();
      const blob = imageBlob(image);
      if (blob === null) return null;
      const webp = await host.convertToWebp(blob, quality);
      signal.throwIfAborted();
      const upload = await host.uploadImage(webp, signal);
      return { markdown: webpAssetMarkdown(upload) };
    } catch (error) {
      if (signal.aborted) throw error;
      return null;
    }
  });
}

export async function importRequest(
  request: ImportRequest,
  host: ExtensionImportHost,
  signal: AbortSignal,
): Promise<ImportResultMessage> {
  const localized = await localizeImages(request.images, host, signal);
  signal.throwIfAborted();
  const markdown = rewriteImageTokens(request.markdown, request.images, localized);
  const note = await host.createNote({ title: importTitle(request), markdown });
  const imagesLocalized = localized.filter((image) => image !== null).length;
  return successMessage(request.requestId, note, imagesLocalized, localized.length - imagesLocalized);
}

export function createExtensionImportReceiver(page: ImportPage, host: ExtensionImportHost): ExtensionImportReceiver {
  let epoch = 0;
  let controller = new AbortController();
  let queue: Promise<void> = Promise.resolve();

  const post = (message: unknown) => page.postMessage(message, page.location.origin);

  const run = async (request: ImportRequest, requestEpoch: number) => {
    let result: ImportResultMessage;
    try {
      if (requestEpoch !== epoch || !host.isReady()) throw new Error("Import was canceled because the vault changed");
      result = await importRequest(request, host, controller.signal);
    } catch (error) {
      result = failureMessage(request.requestId, error instanceof Error ? error.message : "Import failed");
    }
    post(result);
  };

  const onMessage = (event: MessageEvent) => {
    if (!isTrustedSender(event, page)) return;
    const message = decodeImportMessage(event.data);
    if (message === null || !host.isReady()) return;
    if (message.kind === "ping") {
      post(readyMessage());
    } else if (message.kind === "invalid") {
      post(failureMessage(message.requestId, message.error));
    } else {
      const requestEpoch = epoch;
      queue = queue.then(() => run(message.request, requestEpoch));
    }
  };

  page.addEventListener("message", onMessage);
  return {
    announceReady() {
      if (host.isReady()) post(readyMessage());
    },
    cancel() {
      epoch += 1;
      controller.abort();
      controller = new AbortController();
    },
    dispose() {
      page.removeEventListener("message", onMessage);
      epoch += 1;
      controller.abort();
    },
  };
}
