import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import esbuild from "esbuild";

const mode = process.argv[2] === "production" ? "production" : "development";
const dist = resolve("web/dist");
const logMode = process.env.TANSU2_LOGS ?? (mode === "production" ? "off" : "pretty");

const result = await esbuild.build({
  entryPoints: ["web/ts/main.ts"],
  bundle: true,
  outfile: "app.js",
  format: "esm",
  target: "esnext",
  minify: mode === "production",
  sourcemap: false,
  write: false,
  define: {
    "process.env.NODE_ENV": JSON.stringify(mode),
    "process.env.TANSU2_LOGS": JSON.stringify(logMode),
  },
});

const javascript = result.outputFiles.find((file) => file.path.endsWith("app.js"));
if (!javascript) {
  throw new Error("esbuild did not emit app.js");
}

const stylesheetResult = await esbuild.build({
  entryPoints: ["web/static/app.css"],
  bundle: true,
  outfile: "app.css",
  minify: mode === "production",
  write: false,
});
const stylesheet = stylesheetResult.outputFiles.find((file) => file.path.endsWith(".css"));
if (!stylesheet) {
  throw new Error("esbuild did not emit app.css");
}
const fingerprint = (content) => createHash("sha256").update(content).digest("hex").slice(0, 16);
const javascriptName = `app.${fingerprint(javascript.contents)}.js`;
const stylesheetName = `app.${fingerprint(stylesheet.contents)}.css`;
const webpEncoderAssets = [
  ["web/ts/editor/vendor/jsquash-webp/encode.js", "assets/jsquash-webp/encode.js", "text/javascript; charset=utf-8"],
  ["web/ts/editor/vendor/jsquash-webp/meta.js", "assets/jsquash-webp/meta.js", "text/javascript; charset=utf-8"],
  ["web/ts/editor/vendor/jsquash-webp/utils.js", "assets/jsquash-webp/utils.js", "text/javascript; charset=utf-8"],
  ["web/ts/editor/vendor/jsquash-webp/codec/enc/webp_enc.js", "assets/jsquash-webp/codec/enc/webp_enc.js", "text/javascript; charset=utf-8"],
  ["web/ts/editor/vendor/jsquash-webp/codec/enc/webp_enc.wasm", "assets/jsquash-webp/codec/enc/webp_enc.wasm", "application/wasm"],
];
const shell = await readFile("web/index.html", "utf8");
const rewrittenShell = shell
  .replace('href="/static/app.css"', `href="/assets/${stylesheetName}"`)
  .replace('src="/static/app.js"', `src="/assets/${javascriptName}"`);

if (rewrittenShell === shell || rewrittenShell.includes("/static/app.")) {
  throw new Error("HTML shell did not contain both expected asset references");
}

await rm(dist, { recursive: true, force: true });
await mkdir(resolve(dist, "assets"), { recursive: true });
await writeFile(resolve(dist, "index.html"), rewrittenShell);
await writeFile(resolve(dist, "assets", javascriptName), javascript.contents);
await writeFile(resolve(dist, "assets", stylesheetName), stylesheet.contents);
for (const [source, file] of webpEncoderAssets) {
  const target = resolve(dist, file);
  await mkdir(resolve(target, ".."), { recursive: true });
  await copyFile(resolve(source), target);
}

const manifest = {
  files: [
    { url: "/", file: "index.html", contentType: "text/html; charset=utf-8", immutable: false },
    { url: `/assets/${javascriptName}`, file: `assets/${javascriptName}`, contentType: "text/javascript; charset=utf-8", immutable: true },
    { url: `/assets/${stylesheetName}`, file: `assets/${stylesheetName}`, contentType: "text/css; charset=utf-8", immutable: true },
    ...webpEncoderAssets.map(([, file, contentType]) => ({
      url: `/${file}`,
      file,
      contentType,
      immutable: true,
    })),
  ],
};
await writeFile(resolve(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
