import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, ".."),
  watchedDirectories = ["web/ts", "web/static"],
  watchedFiles = [
    "web/index.html",
    "web/setup.html",
    "web/dev-hmr.js",
    "scripts/build-web.mjs",
    "scripts/webp-encoder.mjs",
  ];

const watchers = [];
let activeBuild;
let pendingBuild = false;
let draining;
let stopping = false;
let watcherError;
let stopSignal;
let resolveStop;
const stopRequested = new Promise((resolve) => {
  resolveStop = resolve;
});

function buildFrontend() {
  const child = spawn("pnpm", ["run", "build:dev"], {
    cwd: repositoryRoot,
    detached: process.platform !== "win32",
    env: { ...process.env, TANSU_WEB_HMR: "1" },
    stdio: "inherit",
  });
  activeBuild = child;
  return new Promise((resolve, reject) => {
    child.once("error", (error) => {
      activeBuild = undefined;
      reject(error);
    });
    child.once("exit", (code, signal) => {
      activeBuild = undefined;
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Frontend rebuild exited with ${signal ?? `code ${code}`}`));
      }
    });
  });
}

async function drainBuilds() {
  while (pendingBuild && !stopping) {
    pendingBuild = false;
    try {
      await buildFrontend();
    } catch (error) {
      console.error("Frontend rebuild failed", error);
    }
  }
  draining = undefined;
  if (pendingBuild && !stopping) startBuildDrain();
}

function startBuildDrain() {
  if (draining || stopping) return;
  draining = drainBuilds();
}

function requestBuild() {
  if (stopping) return;
  pendingBuild = true;
  startBuildDrain();
}

function requestStop(reason) {
  if (stopSignal !== undefined) return;
  stopSignal = reason;
  stopping = true;
  resolveStop(reason);
}

function closeWatchers() {
  for (const watcher of watchers) watcher.close();
}

function stopBuild() {
  if (activeBuild === undefined || activeBuild.exitCode !== null || activeBuild.signalCode !== null) return;
  try {
    if (process.platform === "win32" || activeBuild.pid === undefined) {
      activeBuild.kill("SIGTERM");
    } else {
      process.kill(-activeBuild.pid, "SIGTERM");
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
    console.error("Could not stop the frontend rebuild", error);
  }
}

function shutdown() {
  stopping = true;
  closeWatchers();
  stopBuild();
  return draining;
}

function onSignal(signal) {
  requestStop(signal);
}

function onWatcherError(error) {
  watcherError = error;
  requestStop("watcher error");
}

process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

try {
  for (const directory of watchedDirectories) {
    const watcher = watch(resolve(repositoryRoot, directory), { recursive: true }, requestBuild);
    watcher.once("error", onWatcherError);
    watchers.push(watcher);
  }
  for (const file of watchedFiles) {
    const watcher = watch(resolve(repositoryRoot, file), requestBuild);
    watcher.once("error", onWatcherError);
    watchers.push(watcher);
  }
  await stopRequested;
} finally {
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  const activeDrain = shutdown();
  if (activeDrain !== undefined) await activeDrain;
}

if (watcherError !== undefined) throw watcherError;
