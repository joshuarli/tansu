import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "vite";

const mode = process.argv[2] === "production" ? "production" : "development";
const root = resolve("web");
const dist = resolve(root, "dist");
const logMode = process.env.TANSU2_LOGS ?? (mode === "production" ? "off" : "pretty");
const webpEncoderAssets = [
  ["web/ts/editor/vendor/jsquash-webp/encode.js", "assets/jsquash-webp/encode.js", "text/javascript; charset=utf-8"],
  ["web/ts/editor/vendor/jsquash-webp/meta.js", "assets/jsquash-webp/meta.js", "text/javascript; charset=utf-8"],
  ["web/ts/editor/vendor/jsquash-webp/utils.js", "assets/jsquash-webp/utils.js", "text/javascript; charset=utf-8"],
  ["web/ts/editor/vendor/jsquash-webp/codec/enc/webp_enc.js", "assets/jsquash-webp/codec/enc/webp_enc.js", "text/javascript; charset=utf-8"],
  ["web/ts/editor/vendor/jsquash-webp/codec/enc/webp_enc.wasm", "assets/jsquash-webp/codec/enc/webp_enc.wasm", "application/wasm"],
];

await build({
  configFile: false,
  root,
  base: "/",
  define: {
    "process.env.NODE_ENV": JSON.stringify(mode),
    "process.env.TANSU2_LOGS": JSON.stringify(logMode),
  },
  build: {
    outDir: dist,
    emptyOutDir: true,
    chunkSizeWarningLimit: 800,
    target: "esnext",
    minify: mode === "production",
    cssMinify: mode === "production",
    rolldownOptions: {
      input: { app: resolve(root, "index.html"), setup: resolve(root, "setup.html") },
      output: {
        entryFileNames: "assets/[name].[hash].js",
        chunkFileNames: "assets/[name].[hash].js",
        assetFileNames: "assets/[name].[hash][extname]",
      },
    },
  },
});

const pages = [
  ["/", "index.html"],
  ["/setup", "setup.html"],
];
const pageAssets = [];
for (const [url, file] of pages) {
  const html = await readFile(resolve(dist, file), "utf8");
  pageAssets.push({ url, file, contentType: "text/html; charset=utf-8", immutable: false });
  for (const [, assetUrl] of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
    if (!/\.(?:js|css)$/.test(assetUrl)) continue;
    pageAssets.push({
      url: assetUrl,
      file: assetUrl.slice(1),
      contentType: assetUrl.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8",
      immutable: true,
    });
  }
}

for (const [source, file] of webpEncoderAssets) {
  const target = resolve(dist, file);
  await mkdir(resolve(target, ".."), { recursive: true });
  await copyFile(resolve(source), target);
}

const manifest = {
  files: [
    ...new Map(pageAssets.map((asset) => [asset.url, asset])).values(),
    ...webpEncoderAssets.map(([, file, contentType]) => ({
      url: `/${file}`,
      file,
      contentType,
      immutable: true,
    })),
  ],
};
await writeFile(resolve(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
