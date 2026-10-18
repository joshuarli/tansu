import {
  TANSU_CHANNEL,
  TANSU_PING_INTERVAL_MS,
  TANSU_PROTOCOL_VERSION,
  type TansuImportPayload,
  type TansuPageOutcome,
} from "./tansu-wire.ts";

export interface TansuMessageEvent {
  source: unknown;
  origin: string;
  data: unknown;
}

export interface TansuMessageWindow {
  location: { origin: string };
  postMessage(message: unknown, targetOrigin: string): void;
  addEventListener(type: "message", listener: (event: TansuMessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: TansuMessageEvent) => void): void;
}

export interface TansuPageProtocolOptions {
  createRequestId?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTansuMessage(data: unknown, type: string): data is Record<string, unknown> {
  return (
    isRecord(data) &&
    data["channel"] === TANSU_CHANNEL &&
    data["version"] === TANSU_PROTOCOL_VERSION &&
    data["type"] === type
  );
}

function listenForTansuMessage(
  win: TansuMessageWindow,
  accept: (data: Record<string, unknown>) => boolean,
  type: string,
  timeoutMs: number,
  onStart: () => void,
  onFinish: () => void,
): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    function finish(message: Record<string, unknown> | undefined): void {
      clearTimeout(timeout);
      win.removeEventListener("message", listener);
      onFinish();
      resolve(message);
    }

    const listener = (event: TansuMessageEvent): void => {
      if (event.source !== win || event.origin !== win.location.origin) {
        return;
      }
      if (isTansuMessage(event.data, type) && accept(event.data)) {
        finish(event.data);
      }
    };
    const timeout = setTimeout(() => finish(undefined), timeoutMs);
    win.addEventListener("message", listener);
    onStart();
  });
}

export async function waitForTansuReady(
  win: TansuMessageWindow,
  timeoutMs: number,
): Promise<boolean> {
  let pingInterval: ReturnType<typeof setInterval> | undefined;
  const ping = (): void => {
    win.postMessage({ channel: TANSU_CHANNEL, type: "import.ping" }, win.location.origin);
  };
  const ready = await listenForTansuMessage(
    win,
    () => true,
    "import.ready",
    timeoutMs,
    () => {
      ping();
      pingInterval = setInterval(ping, TANSU_PING_INTERVAL_MS);
    },
    () => clearInterval(pingInterval),
  );
  return ready !== undefined;
}

export async function requestTansuImport(
  win: TansuMessageWindow,
  payload: TansuImportPayload,
  timeoutMs: number,
  options: TansuPageProtocolOptions = {},
): Promise<TansuPageOutcome> {
  const requestId = (options.createRequestId ?? (() => crypto.randomUUID()))(),
    message = await listenForTansuMessage(
      win,
      (data) => data["requestId"] === requestId,
      "import.result",
      timeoutMs,
      () => {
        win.postMessage(
          {
            channel: TANSU_CHANNEL,
            version: TANSU_PROTOCOL_VERSION,
            type: "import.request",
            requestId,
            ...payload,
          },
          win.location.origin,
        );
      },
      () => undefined,
    );
  return message === undefined
    ? { kind: "timeout", phase: "result" }
    : { kind: "message", message };
}
