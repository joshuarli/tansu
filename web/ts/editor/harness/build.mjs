import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const harnessDirectory = dirname(fileURLToPath(import.meta.url));
const rootDirectory = resolve(harnessDirectory, "../../../..");
const outDirectory = resolve(rootDirectory, ".work/tmp/editor-harness");

await mkdir(outDirectory, { recursive: true });
const result = await build({
  configFile: false,
  root: harnessDirectory,
  base: "./",
  build: {
    outDir: outDirectory,
    emptyOutDir: true,
    target: "es2022",
    minify: false,
  },
});
const outputs = Array.isArray(result) ? result.flatMap((output) => output.output) : result.output;
const chunks = outputs.filter((output) => output.type === "chunk");
const inputs = chunks.flatMap((chunk) => Object.keys(chunk.modules));
const stateInputs = inputs.filter((path) => /node_modules\/@codemirror\/state\//.test(path));
if (stateInputs.length !== 1) {
  throw new Error(`Expected one @codemirror/state input, found ${stateInputs.length}`);
}
if (inputs.some((path) => /(^|\/)node_modules\/react(?:\/|$)/.test(path))) {
  throw new Error("Editor fixture bundle includes React");
}

const html = await readFile(resolve(outDirectory, "index.html"), "utf8");
if (!/<script[^>]+src="[^"]+\.js"/.test(html) || !/<link[^>]+href="[^"]+\.css"/.test(html)) {
  throw new Error("Editor fixture page does not reference its Vite outputs");
}
