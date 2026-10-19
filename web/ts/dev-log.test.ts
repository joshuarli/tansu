import { afterEach, describe, expect, it, vi } from "vitest";

describe("dev log client", () => {
  const originalMode = process.env["TANSU_LOGS"];

  afterEach(() => {
    process.env["TANSU_LOGS"] = originalMode;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("does nothing when logging is off", async () => {
    process.env["TANSU_LOGS"] = "off";
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { installClientLogCapture, logClientEvent, flushLogs } = await import("./dev-log.ts");

    logClientEvent("info", "system.event", { system: { component: "test", action: "skip" } });
    installClientLogCapture();
    flushLogs(false);

    expect(fetch).not.toHaveBeenCalled();
  });

  it("batches enabled client events", async () => {
    vi.useFakeTimers();
    process.env["TANSU_LOGS"] = "buffer";
    const fetch = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    const { logClientEvent } = await import("./dev-log.ts");

    const requestId = "request-1";
    logClientEvent("info", "system.event", { system: { component: "test", action: "run" } }, requestId);
    vi.runOnlyPendingTimers();

    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      events: [
        {
          source: "client",
          level: "info",
          kind: "system.event",
          requestId,
          system: { component: "test", action: "run" },
        },
      ],
    });
  });

  it("disables sending after a transport failure", async () => {
    process.env["TANSU_LOGS"] = "buffer";
    const fetch = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetch);
    const { logClientEvent, flushLogs } = await import("./dev-log.ts");

    logClientEvent("warn", "system.event");
    flushLogs(false);
    await Promise.resolve();
    await Promise.resolve();
    logClientEvent("warn", "system.event");
    flushLogs(false);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("disables sending after a rejected log response", async () => {
    process.env["TANSU_LOGS"] = "buffer";
    const fetch = vi.fn(async () => ({ ok: false, status: 400 }));
    vi.stubGlobal("fetch", fetch);
    const { logClientEvent, flushLogs } = await import("./dev-log.ts");

    logClientEvent("warn", "system.event", { client: { seq: 1 } });
    flushLogs(false);
    await Promise.resolve();
    await Promise.resolve();
    logClientEvent("warn", "system.event");
    flushLogs(false);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("captures browser errors and sends pending logs with a beacon on unload", async () => {
    process.env["TANSU_LOGS"] = "buffer";
    const fetch = vi.fn(async () => ({ ok: true }));
    const sendBeacon = vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);
    vi.stubGlobal("fetch", fetch);
    const { installClientLogCapture } = await import("./dev-log.ts");
    installClientLogCapture();

    window.dispatchEvent(new ErrorEvent("error", { error: new Error("render failed"), message: "render failed" }));
    const rejection = new Event("unhandledrejection");
    Object.defineProperty(rejection, "reason", { value: "promise failed" });
    window.dispatchEvent(rejection);
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const circularRejection = new Event("unhandledrejection");
    Object.defineProperty(circularRejection, "reason", { value: circular });
    window.dispatchEvent(circularRejection);
    window.dispatchEvent(new Event("beforeunload"));

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [path, body] = sendBeacon.mock.calls[0] ?? [];
    expect(path).toBe("/api/dev/logs");
    const payload = JSON.parse(await (body as Blob).text());
    expect(payload.events).toHaveLength(3);
    expect(payload.events[0]).toMatchObject({ error: { name: "Error", message: "render failed" } });
    expect(payload.events[1]).toMatchObject({ error: { message: "promise failed", value: '"promise failed"' } });
    expect(payload.events[2]).toMatchObject({ error: { message: "unhandled rejection", value: "[object Object]" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("flushes full batches and falls back to keepalive fetch when a beacon is declined", async () => {
    process.env["TANSU_LOGS"] = "buffer";
    vi.spyOn(navigator, "sendBeacon").mockReturnValue(false);
    const fetch = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    const { logClientEvent, flushLogs } = await import("./dev-log.ts");

    for (let index = 0; index < 32; index += 1) {
      logClientEvent("debug", "system.batch", { index });
    }
    await Promise.resolve();
    await Promise.resolve();

    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).events).toHaveLength(32);

    logClientEvent("info", "system.unload");
    flushLogs(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(2);
    const [, unload] = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(unload.keepalive).toBeTruthy();
  });
});
