import { spawnSync } from "node:child_process";

export default async function globalSetup(): Promise<() => Promise<void>> {
  const build = spawnSync("pnpm", ["run", "bundle"], { stdio: "inherit" });
  if (build.status !== 0) {
    throw new Error("Frontend build failed");
  }
  return async () => {
    const { shutdownSharedState } = await import("./setup.ts");
    await shutdownSharedState();
  };
}
