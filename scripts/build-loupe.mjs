import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { build } from "vite";
import { createLoupeBuildConfigs, loupeExtension } from "../vite.loupe.config.ts";

function copyStaticSource(sourceDirectory, outputDirectory) {
  cpSync(sourceDirectory, outputDirectory, {
    recursive: true,
    filter(sourcePath) {
      const relativePath = relative(sourceDirectory, sourcePath);
      if (relativePath === "") return true;
      return relativePath !== "manifest.json" && !/\.(?:ts|html|css)$/u.test(relativePath);
    },
  });
}

for (const bundleConfig of createLoupeBuildConfigs()) {
  await build({ ...bundleConfig, configFile: false });
}

mkdirSync(loupeExtension.outputDirectory, { recursive: true });
copyStaticSource(loupeExtension.sourceDirectory, loupeExtension.outputDirectory);

const extensionManifest = JSON.parse(
  readFileSync(resolve(loupeExtension.sourceDirectory, "manifest.json"), "utf8"),
);
writeFileSync(
  resolve(loupeExtension.outputDirectory, "manifest.json"),
  `${JSON.stringify(extensionManifest, null, 2)}\n`,
);

if (!existsSync(loupeExtension.wasmPath)) {
  throw new Error(`Loupe WebAssembly module is missing at ${loupeExtension.wasmPath}. Run "deno task loupe:wasm" first.`);
}
cpSync(loupeExtension.wasmPath, resolve(loupeExtension.outputDirectory, "defuddle_wasm_bg.wasm"));
console.log(`Built Loupe in ${loupeExtension.outputDirectory}`);
