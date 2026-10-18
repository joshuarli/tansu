import { basename, dirname, resolve } from "node:path";
import type { UserConfig } from "vite";

const repositoryRoot = resolve(import.meta.dirname),
  sourceDirectory = resolve(repositoryRoot, "extension-loupe", "src"),
  production = process.env["NODE_ENV"] === "production",
  outputRootPath = resolve(repositoryRoot, production ? "dist" : "build"),
  extensionOutputDirectory = resolve(outputRootPath, "extension-loupe"),
  bundles = [
    {
      input: resolve(sourceDirectory, "service-worker.ts"),
      entryFileName: "service-worker.js",
      format: "es",
      target: "chrome150",
      emptyOutDir: true,
    },
    {
      input: resolve(sourceDirectory, "reader-content-script.ts"),
      entryFileName: "content.js",
      format: "iife",
      target: "chrome150",
      emptyOutDir: false,
    },
    {
      input: resolve(sourceDirectory, "tansu-import-page.ts"),
      entryFileName: "tansu-import-page.js",
      format: "iife",
      target: "chrome150",
      emptyOutDir: false,
    },
    {
      input: { options: resolve(sourceDirectory, "options.html") },
      entryFileName: "[name].js",
      format: "es",
      target: "chrome150",
      emptyOutDir: false,
    },
  ] as const;

export { repositoryRoot, outputRootPath };

export const loupeExtension = {
  sourceDirectory,
  outputDirectory: extensionOutputDirectory,
  bundles,
  wasmPath: resolve(
    repositoryRoot,
    "extension-loupe",
    ".generated",
    "defuddle-wasm",
    "defuddle_wasm_bg.wasm",
  ),
};

export function createLoupeBuildConfigs(isProduction = production): UserConfig[] {
  return bundles.map((bundle) => ({
    root: sourceDirectory,
    base: "./",
    define: {
      "process.env.NODE_ENV": JSON.stringify(isProduction ? "production" : "development"),
    },
    build: {
      outDir: extensionOutputDirectory,
      emptyOutDir: bundle.emptyOutDir,
      copyPublicDir: false,
      target: bundle.target,
      minify: isProduction,
      sourcemap: isProduction ? false : "inline",
      rolldownOptions: {
        input: bundle.input,
        output: {
          format: bundle.format,
          entryFileNames: bundle.entryFileName,
          chunkFileNames: "chunks/[name]-[hash].js",
          assetFileNames: "[name][extname]",
        },
      },
    },
  }));
}

export function createSingleFileBundleConfig(
  input: string,
  outputFile: string,
  target = "chrome150",
): UserConfig {
  return {
    root: repositoryRoot,
    base: "./",
    define: { "process.env.NODE_ENV": JSON.stringify("test") },
    build: {
      outDir: dirname(outputFile),
      emptyOutDir: false,
      copyPublicDir: false,
      minify: false,
      sourcemap: false,
      target,
      rolldownOptions: {
        input,
        output: {
          format: "iife",
          entryFileNames: basename(outputFile),
        },
      },
    },
  };
}

const viteLoupeConfig = { server: { forwardConsole: true } };

export default viteLoupeConfig;
