import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import esbuild from "esbuild";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const entryPoint = "web/ts/main.ts";
const cssPath = resolve(REPO_ROOT, "web/static/app.css");

async function bundle(minify) {
  const result = await esbuild.build({
    absWorkingDir: REPO_ROOT,
    entryPoints: [entryPoint],
    bundle: true,
    outfile: "app.js",
    format: "esm",
    target: "esnext",
    minify,
    sourcemap: false,
    write: false,
    metafile: true,
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env.TANSU2_LOGS": JSON.stringify("off"),
    },
  });
  const output = result.outputFiles.find((file) => file.path.endsWith("app.js"));
  if (!output || !result.metafile) {
    throw new Error("esbuild did not emit the application bundle and metafile");
  }
  const metadata = Object.values(result.metafile.outputs).find((file) => file.entryPoint === entryPoint);
  if (!metadata) {
    throw new Error("esbuild metafile does not identify the application entry point");
  }
  return { output, metadata, inputs: result.metafile.inputs };
}

const [raw, minified, css, budgetsText] = await Promise.all([
  bundle(false),
  bundle(true),
  readFile(cssPath),
  readFile(resolve(REPO_ROOT, "bench/budgets.json"), "utf8"),
]);
const budgets = JSON.parse(budgetsText).productionAssets;

const inputPaths = [...new Set([...Object.keys(raw.inputs), ...Object.keys(minified.inputs)])];
const moduleSizes = inputPaths.map((path) => ({
  path,
  sourceBytes: minified.inputs[path]?.bytes ?? raw.inputs[path]?.bytes ?? 0,
  rawOutputBytes: raw.metadata.inputs[path]?.bytesInOutput ?? 0,
  minifiedOutputBytes: minified.metadata.inputs[path]?.bytesInOutput ?? 0,
})).toSorted((left, right) =>
  right.minifiedOutputBytes - left.minifiedOutputBytes || left.path.localeCompare(right.path)
);

const allInputs = inputPaths.join("\n");
if (/node_modules\/(react|solid-js|effect)(\/|@|$)/.test(allInputs)) {
  throw new Error("application bundle contains a prohibited UI or effect framework");
}
const statePackages = new Set(inputPaths.flatMap((path) => {
  const pnpmPath = path.match(/(?:^|\/)(@codemirror\+state@[^/]+)/)?.[1];
  if (pnpmPath) return [pnpmPath];
  return path.includes("node_modules/@codemirror/state/") ? ["@codemirror/state"] : [];
}));
if (statePackages.size !== 1) {
  throw new Error(`expected exactly one @codemirror/state package, found ${statePackages.size}`);
}

const report = {
  javascript: {
    rawBytes: raw.output.contents.byteLength,
    rawGzipBytes: gzipSync(raw.output.contents).byteLength,
    minifiedBytes: minified.output.contents.byteLength,
    minifiedGzipBytes: gzipSync(minified.output.contents).byteLength,
  },
  stylesheet: {
    bytes: css.byteLength,
    gzipBytes: gzipSync(css).byteLength,
  },
  modules: moduleSizes,
};

const budgetedAssets = [
  ["rawJavaScriptBytes", report.javascript.rawBytes],
  ["minifiedJavaScriptBytes", report.javascript.minifiedBytes],
  ["minifiedJavaScriptGzipBytes", report.javascript.minifiedGzipBytes],
  ["stylesheetBytes", report.stylesheet.bytes],
  ["stylesheetGzipBytes", report.stylesheet.gzipBytes],
];
const failures = budgetedAssets.flatMap(([name, actual]) => {
  const maximum = budgets?.[name]?.maxBytes;
  if (!Number.isSafeInteger(maximum)) {
    throw new Error(`production asset budget is missing: ${name}`);
  }
  return actual > maximum ? [`${name} ${actual} > ${maximum}`] : [];
});
if (failures.length > 0) {
  throw new Error(`production asset budgets failed:\n${failures.join("\n")}`);
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
