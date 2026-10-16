type LogLevel = "debug" | "info" | "warn" | "error";

type LogSource = "server" | "client" | "harness";

type LogEventInput = {
  source: LogSource;
  level: LogLevel;
  kind: string;
  requestId?: string;
} & Record<string, unknown>;

const LOG_MODE = process.env["TANSU2_LOGS"] ?? "off";
const FLUSH_DELAY_MS = 100;
const MAX_BATCH_EVENTS = 32;

let eventSeq = 0;
let flushTimer: number | undefined;
let disabled = LOG_MODE === "off";
const pending: LogEventInput[] = [];

export function logClientEvent(
  level: LogLevel,
  kind: string,
  fields: Record<string, unknown> = {},
  requestId?: string,
): void {
  if (disabled) {
    return;
  }
  const event: LogEventInput = {
    source: "client",
    level,
    kind,
    client: { seq: ++eventSeq, url: globalThis.location?.href },
    ...fields,
  };
  if (requestId !== undefined) {
    event.requestId = requestId;
  }
  enqueue(event);
}

export function installClientLogCapture(): void {
  if (disabled || typeof window === "undefined") {
    return;
  }
  window.addEventListener("error", (event) => {
    logClientEvent("error", "client.error", {
      error: errorInfo(event.error, event.message),
      page: { url: window.location.href },
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    logClientEvent("error", "client.error", {
      error: errorInfo(event.reason, "unhandled rejection"),
      page: { url: window.location.href },
    });
  });
  window.addEventListener("beforeunload", () => flushLogs(true));
}

function enqueue(event: LogEventInput): void {
  pending.push(event);
  if (pending.length >= MAX_BATCH_EVENTS) {
    flushLogs(false);
    return;
  }
  if (flushTimer !== undefined || typeof window === "undefined") {
    return;
  }
  flushTimer = window.setTimeout(() => {
    flushTimer = undefined;
    flushLogs(false);
  }, FLUSH_DELAY_MS);
}

export function flushLogs(sync: boolean): void {
  if (disabled || pending.length === 0) {
    return;
  }
  if (flushTimer !== undefined && typeof window !== "undefined") {
    window.clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  const events = pending.splice(0, pending.length);
  const body = JSON.stringify({ events });
  if (sync && typeof navigator !== "undefined" && "sendBeacon" in navigator) {
    const sent = navigator.sendBeacon(
      "/api/dev/logs",
      new Blob([body], { type: "application/json" }),
    );
    if (sent) {
      return;
    }
  }
  void fetch("/api/dev/logs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Tansu-Log": "1" },
    body,
    keepalive: sync,
  })
    .then((response) => {
      if (!response.ok) {
        disabled = true;
      }
    })
    .catch(() => {
      disabled = true;
    });
}

function errorInfo(error: unknown, fallback: string): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return {
    message: typeof error === "string" ? error : fallback,
    value: safeString(error),
  };
}

function safeString(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
