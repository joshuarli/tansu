import { once } from "node:events";

export async function stopProcessGroup(child) {
  if (child.pid === undefined) throw new Error("server child has no process id");
  const groupId = child.pid;
  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : once(child, "exit");
  signal(groupId, "SIGTERM");
  const stopped = await waitForExit(exited, 5_000);
  if (!stopped || processGroupExists(groupId)) signal(groupId, "SIGKILL");
  await exited;
  await waitForProcessGroupExit(groupId);
}

function signal(groupId, signalName) {
  try {
    process.kill(-groupId, signalName);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function processGroupExists(groupId) {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessGroupExit(groupId) {
  const deadline = Date.now() + 5_000;
  while (processGroupExists(groupId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (processGroupExists(groupId)) throw new Error(`server process group ${groupId} did not exit`);
}

async function waitForExit(exited, milliseconds) {
  let timeoutId;
  try {
    return await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}
