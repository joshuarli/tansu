import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "vite";
import { createSingleFileBundleConfig, repositoryRoot } from "../vite.loupe.config.ts";

const outputDirectory = resolve(repositoryRoot, "build", "browser-test");
mkdirSync(outputDirectory, { recursive: true });

for (const [source, output] of [
  [
    resolve(repositoryRoot, "extension-loupe", "src", "reader-content-script.ts"),
    resolve(outputDirectory, "reader-content.js"),
  ],
  [
    resolve(repositoryRoot, "extension-loupe", "test", "reader-fixture-browser-entry.ts"),
    resolve(outputDirectory, "reader-fixture.js"),
  ],
]) {
  await build({ ...createSingleFileBundleConfig(source, output), configFile: false });
}
