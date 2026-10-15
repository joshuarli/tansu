import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const corpusRoot = join(repositoryRoot, "tests/visual-parity/native-oracle/v1");
const derivativesRoot = join(corpusRoot, "browser-derivatives");
const scratchRoot = join(repositoryRoot, ".work/tmp");
const sourceManifest = JSON.parse(await readFile(join(corpusRoot, "manifest.json"), "utf8"));
const sources = sourceManifest.sourceFiles.filter((file) => file.role === "native-attachment" && file.relativePath.endsWith(".heic"));
if (sources.length === 0) throw new Error("Native oracle has no HEIC attachments to derive");

if (await exists(derivativesRoot)) {
  throw new Error(`Refusing to replace existing browser derivatives at ${derivativesRoot}`);
}

await mkdir(scratchRoot, { recursive: true });
const stagingRoot = await mkdtemp(join(scratchRoot, "visual-parity-derivatives-"));
try {
  const imagesRoot = join(stagingRoot, "images");
  const decodedRoot = join(stagingRoot, "decoded");
  await mkdir(imagesRoot, { recursive: true });
  await mkdir(decodedRoot, { recursive: true });
  const assets = [];
  const cwebpVersion = execFileSync("cwebp", ["-version"], { encoding: "utf8" }).trim();
  for (const source of sources) {
    const sourcePath = confinedCorpusPath(source.relativePath);
    const sourceInfo = await lstat(sourcePath);
    if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) throw new Error(`Invalid source attachment ${sourcePath}`);
    const bytes = await readFile(sourcePath);
    const sourceSHA256 = digest(bytes);
    if (sourceSHA256 !== source.sha256) throw new Error(`Source attachment SHA-256 mismatch: ${source.relativePath}`);
    const sourceName = source.relativePath.split("/").at(-1);
    const decodedPath = join(decodedRoot, `${sourceName}.png`);
    const outputPath = join(imagesRoot, `${sourceName}.webp`);
    execFileSync("sips", ["-s", "format", "png", sourcePath, "--out", decodedPath], { stdio: "ignore" });
    execFileSync("cwebp", ["-lossless", "-exact", "-metadata", "icc", decodedPath, "-o", outputPath], { stdio: "ignore" });
    const output = await readFile(outputPath);
    const dimensions = await imageDimensions(outputPath);
    const sourceMetadata = sipsMetadata(sourcePath);
    const outputMetadata = sipsMetadata(outputPath);
    assets.push({
      sourceRelativePath: `source-fixtures/${source.relativePath}`,
      sourceSHA256,
      wikiImageName: `images/${source.relativePath.split("/").at(-1)}`,
      derivativeRelativePath: `browser-derivatives/images/${sourceName}.webp`,
      derivativeSHA256: digest(output),
      widthPx: dimensions.width,
      heightPx: dimensions.height,
      sourceColorSpace: sourceMetadata.space,
      sourceColorProfile: sourceMetadata.profile,
      derivativeColorSpace: outputMetadata.space,
      derivativeColorProfile: outputMetadata.profile,
      sourceFormat: "HEIC",
      browserFormat: "WebP lossless",
    });
  }
  assets.sort((left, right) => left.wikiImageName.localeCompare(right.wikiImageName));
  const manifest = {
    schemaVersion: 1,
    method: "sips HEIC decode followed by lossless cwebp encoding",
    cwebpVersion,
    macOSVersion: execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(),
    nativeRepositoryCommit: sourceManifest.sourceCommit,
    browserUse: "The source Markdown remains unchanged. nativeParityImageMap points each HEIC wiki image at its PNG derivative for browser decoding.",
    assets,
  };
  await writeFile(join(stagingRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rm(decodedRoot, { recursive: true, force: true });
  await mkdir(dirname(derivativesRoot), { recursive: true });
  await rename(stagingRoot, derivativesRoot);
  process.stdout.write(`Generated ${assets.length} lossless WebP derivatives at ${derivativesRoot}\n`);
} finally {
  if (await exists(stagingRoot)) await rm(stagingRoot, { recursive: true, force: true });
}

function confinedCorpusPath(path) {
  if (path.length === 0 || path.startsWith("/") || path.split(/[\\/]/).includes("..")) {
    throw new Error(`Invalid oracle path ${path}`);
  }
  const candidate = resolve(corpusRoot, "source-fixtures", path);
  const fromRoot = relative(join(corpusRoot, "source-fixtures"), candidate);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || fromRoot.startsWith(sep)) {
    throw new Error(`Oracle path escaped its source directory: ${path}`);
  }
  return candidate;
}

async function imageDimensions(path) {
  const output = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], { encoding: "utf8" });
  const width = Number(output.match(/pixelWidth:\s*(\d+)/)?.[1]);
  const height = Number(output.match(/pixelHeight:\s*(\d+)/)?.[1]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Could not read derivative dimensions for ${path}`);
  }
  return { width, height };
}

function sipsMetadata(path) {
  const output = execFileSync("sips", ["-g", "space", "-g", "profile", path], { encoding: "utf8" });
  return {
    space: output.match(/\s+space:\s*(.+)/)?.[1]?.trim() ?? "unknown",
    profile: output.match(/\s+profile:\s*(.+)/)?.[1]?.trim() ?? "unknown",
  };
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
