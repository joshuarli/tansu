import type { ChildProcess } from "node:child_process";
import { once } from "node:events";

export async function stopChildProcess(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const stopped = await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), 5_000);
      }),
    ]);
    if (!stopped) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  } finally {
    clearTimeout(timeout);
  }
}
