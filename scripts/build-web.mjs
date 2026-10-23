import { copyFile, mkdir, readFile, rm, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "vite";
import { webpEncoderAssets, webpEncoderBaseUrl } from "./webp-encoder.mjs";

const mode = process.argv[2] === "production" ? "production" : "development";
const hmr = mode === "development" && process.env.TANSU_WEB_HMR === "1";
const root = resolve("web");
const dist = resolve(root, "dist");
const logMode = process.env.TANSU_LOGS ?? (mode === "production" ? "off" : "pretty");
const encoderBaseUrl = await webpEncoderBaseUrl();
const encoderAssets = await webpEncoderAssets();

const bundles = await build({
  configFile: false,
  root,
  base: "/",
  define: {
    "process.env.NODE_ENV": JSON.stringify(mode),
    "process.env.TANSU_LOGS": JSON.stringify(logMode),
    "process.env.TANSU_WEBP_ENCODER_URL": JSON.stringify(`${encoderBaseUrl}/encode.js`),
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
  let html = await readFile(resolve(dist, file), "utf8");
  if (hmr) html = html.replace("</body>", '    <script src="/dev-hmr.js" defer></script>\n  </body>');
  await writeFile(resolve(dist, file), html);
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

for (const bundle of Array.isArray(bundles) ? bundles : [bundles]) {
  for (const output of bundle.output) {
    if (output.type !== "chunk") continue;
    pageAssets.push({
      url: `/${output.fileName}`,
      file: output.fileName,
      contentType: "text/javascript; charset=utf-8",
      immutable: true,
    });
  }
}

if (hmr) {
  const hmrClient = resolve(root, "dev-hmr.js");
  await copyFile(hmrClient, resolve(dist, "dev-hmr.js"));
  pageAssets.push({ url: "/dev-hmr.js", file: "dev-hmr.js", contentType: "text/javascript; charset=utf-8", immutable: false });
}

for (const { source, file } of encoderAssets) {
  const target = resolve(dist, file);
  await mkdir(resolve(target, ".."), { recursive: true });
  await copyFile(resolve(source), target);
}

const manifest = {
  files: [
    ...new Map(pageAssets.map((asset) => [asset.url, asset])).values(),
    ...encoderAssets.map(({ url, file, contentType, immutable }) => ({ url, file, contentType, immutable })),
  ],
};
const manifestPath = resolve(dist, "manifest.json");
const temporaryManifestPath = resolve(dist, ".manifest.tmp");
try {
  await writeFile(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(temporaryManifestPath, manifestPath);
} finally {
  await rm(temporaryManifestPath, { force: true });
}
