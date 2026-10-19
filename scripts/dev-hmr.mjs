const watchPaths = [
  "web/ts",
  "web/static",
  "web/index.html",
  "web/setup.html",
  "web/dev-hmr.js",
  "scripts/build-web.mjs",
  "scripts/webp-encoder.mjs",
];
const watcher = Deno.watchFs(watchPaths, { recursive: true });
let activeBuild;
let pendingBuild = false;
let stopping = false;

async function buildFrontend() {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["task", "build:dev"],
    env: { TANSU_WEB_HMR: "1" },
    stdout: "inherit",
    stderr: "inherit",
  });
  activeBuild = command.spawn();
  const result = await activeBuild.status;
  activeBuild = undefined;
  if (!result.success) console.error(`Frontend rebuild exited with code ${result.code}`);
}

async function drainBuilds() {
  if (activeBuild || stopping) return;
  while (pendingBuild && !stopping) {
    pendingBuild = false;
    try {
      await buildFrontend();
    } catch (error) {
      activeBuild = undefined;
      console.error("Frontend rebuild failed", error);
    }
  }
}

function requestBuild() {
  pendingBuild = true;
  void drainBuilds();
}

function stop() {
  stopping = true;
  watcher.close();
  if (activeBuild) activeBuild.kill("SIGTERM");
}

Deno.addSignalListener("SIGINT", stop);
Deno.addSignalListener("SIGTERM", stop);

try {
  for await (const event of watcher) {
    if (event.kind === "modify" || event.kind === "create" || event.kind === "remove") requestBuild();
  }
} finally {
  stop();
  if (activeBuild) await activeBuild.status;
  Deno.removeSignalListener("SIGINT", stop);
  Deno.removeSignalListener("SIGTERM", stop);
}
