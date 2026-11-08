import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { stopChildProcess } from "./e2e/child-process.ts";

describe("test server shutdown", () => {
  let child: ChildProcess | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    if (child?.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    child = undefined;
  });

  it("returns immediately if the child has already exited", async () => {
    child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await once(child, "exit");
    vi.useFakeTimers();
    const stopped = vi.fn();
    void stopChildProcess(child).then(stopped);
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline after graceful exit", async () => {
    child = spawn(process.execPath, ["-e", "process.send('ready'); setInterval(() => {}, 1000)"], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    await once(child, "message");
    vi.useFakeTimers();
    await stopChildProcess(child);
    expect(child.signalCode).toBe("SIGTERM");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("kills a child that ignores graceful termination", async () => {
    child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    await once(child, "message");
    vi.useFakeTimers();
    const stopping = stopChildProcess(child);
    await vi.advanceTimersByTimeAsync(5_000);
    await stopping;
    expect(child.signalCode).toBe("SIGKILL");
    expect(vi.getTimerCount()).toBe(0);
  });
});
