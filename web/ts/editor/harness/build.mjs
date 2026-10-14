import { build } from "esbuild";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const harnessDirectory = dirname(fileURLToPath(import.meta.url));
const rootDirectory = resolve(harnessDirectory, "../../../..");
const outDirectory = resolve(rootDirectory, ".work/tmp/editor-harness");

await mkdir(outDirectory, { recursive: true });
const result = await build({
  entryPoints: {
    harness: resolve(harnessDirectory, "harness.ts"),
    editor: resolve(harnessDirectory, "../editor.css"),
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outdir: outDirectory,
  metafile: true,
});

const inputs = Object.keys(result.metafile.inputs);
const stateInputs = inputs.filter((path) => /node_modules\/@codemirror\/state\//.test(path));
if (stateInputs.length !== 1) {
  throw new Error(`Expected one @codemirror/state input, found ${stateInputs.length}`);
}
if (inputs.some((path) => /(^|\/)node_modules\/react(?:\/|$)/.test(path))) {
  throw new Error("Editor fixture bundle includes React");
}

await copyFile(resolve(harnessDirectory, "index.html"), resolve(outDirectory, "index.html"));
const html = await readFile(resolve(outDirectory, "index.html"), "utf8");
if (!html.includes("./harness.js") || !html.includes("./editor.css")) {
  throw new Error("Editor fixture page does not reference its esbuild outputs");
}
