import { Effect, Schema } from "effect";
import { tansuPageCall, type TansuPageMethod } from "./tansu-page-call.ts";
import { readTansuSettings } from "./tansu-settings.ts";
import { prepareTansuImport } from "./tansu-import.ts";
import {
  TansuImportResultSchema,
  TansuPageOutcomeSchema,
  SendToTansuRequestSchema,
  type SendToTansuRequest,
  type SendToTansuResponse,
} from "./tansu-schemas.ts";
import {
  TANSU_BACKGROUND_READY_GRACE_MS,
  TANSU_PAGE_IMPORT_GLOBAL,
  TANSU_READY_TIMEOUT_MS,
  TANSU_RESULT_TIMEOUT_MS,
  type TansuImportPayload,
} from "./tansu-wire.ts";

const TAB_LOAD_TIMEOUT_MS = 60_000,
  KEEP_ALIVE_INTERVAL_MS = 20_000;

export class TansuNotConfiguredError extends Schema.TaggedError<TansuNotConfiguredError>()(
  "TansuNotConfiguredError",
  { message: Schema.String },
) {}

export class TansuSendError extends Schema.TaggedError<TansuSendError>()("TansuSendError", {
  message: Schema.String,
}) {}

function failure(message: string) {
  return new TansuSendError({ message });
}

function tryChrome<A>(operation: () => Promise<A>, message: string) {
  return Effect.tryPromise({
    try: operation,
    catch: (cause) => failure(`${message} ${cause instanceof Error ? cause.message : String(cause)}`),
  });
}

const loadTansuOrigin = Effect.gen(function* () {
  const settings = yield* tryChrome(
    () => readTansuSettings(chrome.storage.local),
    "Loupe could not read the saved Tansu URL. Open Loupe settings.",
  );
  if (settings.tansuOrigin === undefined) {
    return yield* Effect.fail(
      new TansuNotConfiguredError({ message: "Set the Tansu URL in Loupe settings." }),
    );
  }
  return settings.tansuOrigin;
});

async function findTansuTab(origin: string): Promise<chrome.tabs.Tab | undefined> {
  const { protocol, hostname } = new URL(origin),
    tabs = await chrome.tabs.query({ url: `${protocol}//${hostname}/*` });
  return tabs.find(
    (tab) => tab.id !== undefined && tab.url !== undefined && new URL(tab.url).origin === origin,
  );
}

async function activateTab(tab: chrome.tabs.Tab): Promise<void> {
  await chrome.tabs.update(tab.id!, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

export async function focusTansuTab(origin: string): Promise<void> {
  const existing = await findTansuTab(origin);
  if (existing) {
    await activateTab(existing);
    return;
  }
  const created = await chrome.tabs.create({ url: `${origin}/`, active: true });
  await chrome.windows.update(created.windowId, { focused: true });
}

export const focusConfiguredTansuTab = loadTansuOrigin.pipe(
  Effect.flatMap((origin) =>
    tryChrome(() => focusTansuTab(origin), "Loupe could not open the Tansu tab."),
  ),
);

function waitForTabComplete(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error): void => {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        if (error) reject(error);
        else resolve();
      },
      listener = (updatedTabId: number, changeInfo: { status?: string }): void => {
        if (updatedTabId === tabId && changeInfo.status === "complete") finish();
      },
      timeout = setTimeout(() => finish(new Error("The Tansu tab did not finish loading.")), TAB_LOAD_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs.get(tabId).then(
      (tab) => {
        if (tab.status === "complete") finish();
      },
      (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
    );
  });
}

function callPage(tabId: number, method: TansuPageMethod, callArguments: unknown[]) {
  return tryChrome(
    () =>
      chrome.scripting.executeScript(
        tansuPageCall(tabId, TANSU_PAGE_IMPORT_GLOBAL, method, callArguments),
      ),
    "Loupe could not talk to the Tansu tab.",
  ).pipe(Effect.map((results) => results[0]?.result));
}

function waitForPageReady(tabId: number, timeoutMs: number) {
  return callPage(tabId, "waitForReady", [timeoutMs]).pipe(
    Effect.map((ready) => ready === true),
  );
}

const readyTabForImport = (origin: string) =>
  Effect.gen(function* () {
    let tab = yield* tryChrome(() => findTansuTab(origin), "Loupe could not look for the Tansu tab.");
    if (!tab) {
      tab = yield* tryChrome(
        () => chrome.tabs.create({ url: `${origin}/`, active: false }),
        "Loupe could not open Tansu.",
      );
    }
    const tabId = tab.id!;
    yield* tryChrome(() => waitForTabComplete(tabId), "Tansu did not load.");
    yield* tryChrome(
      () => chrome.scripting.executeScript({ target: { tabId }, files: ["tansu-import-page.js"] }),
      "Loupe could not prepare the Tansu tab.",
    );
    if (!(yield* waitForPageReady(tabId, TANSU_BACKGROUND_READY_GRACE_MS))) {
      yield* tryChrome(() => activateTab(tab), "Loupe could not show the Tansu tab.");
      const ready = yield* waitForPageReady(tabId, TANSU_READY_TIMEOUT_MS - TANSU_BACKGROUND_READY_GRACE_MS);
      if (!ready) {
        return yield* Effect.fail(
          failure("Tansu was not ready in time. Sign in on the Tansu tab and try again."),
        );
      }
    }
    return tabId;
  });

const keepServiceWorkerAlive = Effect.acquireRelease(
  Effect.sync(() => setInterval(() => void chrome.runtime.getPlatformInfo(), KEEP_ALIVE_INTERVAL_MS)),
  (interval) => Effect.sync(() => clearInterval(interval)),
);

function sendToTansuFlow(request: SendToTansuRequest) {
  return Effect.gen(function* () {
    yield* keepServiceWorkerAlive;
    const origin = yield* loadTansuOrigin,
      [prepared, tabId] = yield* Effect.all(
        [
          tryChrome(
            () => prepareTansuImport(request.markdown, request.sourceUrl, { fetchImpl: fetch }),
            "Loupe could not prepare the images.",
          ),
          readyTabForImport(origin),
        ],
        { concurrency: 2 },
      ),
      payload: TansuImportPayload = {
        title: request.title,
        markdown: prepared.markdown,
        sourceUrl: request.sourceUrl,
        images: prepared.images,
      },
      rawOutcome = yield* callPage(tabId, "requestImport", [payload, TANSU_RESULT_TIMEOUT_MS]),
      outcome = yield* Schema.decodeUnknownEffect(TansuPageOutcomeSchema)(rawOutcome).pipe(
        Effect.mapError(() => failure("Tansu returned an unreadable response.")),
      );
    if (outcome.kind === "timeout") {
      return yield* Effect.fail(failure("Tansu did not answer the import in time."));
    }
    const result = yield* Schema.decodeUnknownEffect(TansuImportResultSchema)(outcome.message).pipe(
      Effect.mapError(() => failure("Tansu returned an unreadable import result.")),
    );
    if (!result.ok) {
      return yield* Effect.fail(failure(result.error));
    }
    return {
      ok: true,
      noteId: result.noteId,
      path: result.path,
      imagesLocalized: result.imagesLocalized,
      imagesFailed: result.imagesFailed,
    } satisfies SendToTansuResponse;
  }).pipe(Effect.scoped);
}

export function runSendToTansu(request: unknown): Promise<SendToTansuResponse> {
  return Effect.runPromise(
    Schema.decodeUnknownEffect(SendToTansuRequestSchema)(request).pipe(
      Effect.mapError(() => failure("Loupe sent an invalid Tansu import request.")),
      Effect.flatMap(sendToTansuFlow),
      Effect.catch(
        (error): Effect.Effect<SendToTansuResponse> =>
          Effect.succeed(
            error instanceof TansuNotConfiguredError
              ? { ok: false, reason: "not-configured", error: error.message }
              : { ok: false, reason: "failed", error: error.message },
          ),
      ),
    ),
  );
}

export function runFocusTansuTab(): Promise<{ ok: boolean; error?: string }> {
  return Effect.runPromise(
    focusConfiguredTansuTab.pipe(
      Effect.map(() => ({ ok: true })),
      Effect.catch((error) => Effect.succeed({ ok: false, error: error.message })),
    ),
  );
}
