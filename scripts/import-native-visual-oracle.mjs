import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(
  process.env.TANSU_VISUAL_ORACLE_BUNDLE ?? join(repositoryRoot, "../tansu/.work/tmp/visual-parity-oracle"),
);
const destination = join(repositoryRoot, "tests/visual-parity/native-oracle/v1");
const scratchRoot = join(repositoryRoot, ".work/tmp");

const sourceHashes = await treeHashes(sourceRoot);
const manifest = await readJson(join(sourceRoot, "manifest.json"));
validateManifest(manifest);
await validateSourceFiles(sourceRoot, manifest.sourceFiles);
await validateNativeScenes(sourceRoot, manifest.scenes);
await validateDesignTargets(sourceRoot, manifest.designTargets);

if (await exists(destination)) {
  const importedFiles = await treeHashes(destination);
  const importedDerivatives = await validateBrowserDerivatives(destination);
  if (!sameBaseAndDerivatives(sourceHashes, importedFiles, importedDerivatives)) {
    throw new Error(`Refusing to replace the existing visual oracle version at ${destination}`);
  }
  process.stdout.write(`Verified unchanged native oracle v1 at ${destination}\n`);
} else {
  await mkdir(scratchRoot, { recursive: true });
  const staging = await mkdtemp(join(scratchRoot, "native-oracle-import-"));
  try {
    await cp(sourceRoot, staging, { recursive: true, verbatimSymlinks: false });
    if (!sameHashes(sourceHashes, await treeHashes(staging))) {
      throw new Error("Oracle bundle changed while it was being imported");
    }
    await mkdir(dirname(destination), { recursive: true });
    await rename(staging, destination);
  } finally {
    if (await exists(staging)) await rm(staging, { recursive: true, force: true });
  }
  process.stdout.write(
    `Imported ${manifest.scenes.length} native-current scenes and ${manifest.designTargets.length} design targets to ${destination}\n`,
  );
}

async function validateSourceFiles(root, files) {
  if (!Array.isArray(files) || files.length === 0) throw new Error("Native oracle has no source files");
  for (const file of files) {
    if (typeof file.relativePath !== "string" || !isRelativePath(file.relativePath)) {
      throw new Error(`Invalid native source path: ${file.relativePath}`);
    }
    const path = join(root, "source-fixtures", file.relativePath);
    await expectHash(path, file.sha256, `source ${file.relativePath}`);
  }
  for (const required of [
    "surface/Studio Dashboard.md",
    "surface/Gallery.md",
    "surface/Project Atlas.md",
    "surface/Reading Queue.md",
    "claude-code/claude code is the inflection point.md",
    "claude-code/Claude Search Notes.md",
  ]) {
    if (!files.some((file) => file.relativePath === required)) {
      throw new Error(`Native oracle is missing source fixture ${required}`);
    }
  }
}

async function validateNativeScenes(root, scenes) {
  if (!Array.isArray(scenes) || scenes.length === 0) throw new Error("Native oracle has no scenes");
  const seen = new Set();
  for (const scene of scenes) {
    if (seen.has(scene.sceneID)) throw new Error(`Duplicate scene ${scene.sceneID}`);
    seen.add(scene.sceneID);
    if (scene.oracleKind !== "native-current") throw new Error(`Wrong oracle kind for ${scene.sceneID}`);
    if (!new Set(["window-content", "in-context", "panel-only"]).has(scene.captureType)) {
      throw new Error(`Invalid capture type for ${scene.sceneID}`);
    }
    if (scene.backingScale !== 2 || scene.pointWidth * 2 !== scene.pixelWidth || scene.pointHeight * 2 !== scene.pixelHeight) {
      throw new Error(`Scale or dimensions do not match points for ${scene.sceneID}`);
    }
    if (scene.pixelWidth <= 0 || scene.pixelHeight <= 0) throw new Error(`Empty image dimensions for ${scene.sceneID}`);
    const sceneRoot = join(root, "native-current", scene.sceneID);
    const actual = join(sceneRoot, "actual.png");
    const repeated = join(sceneRoot, "repeat.png");
    await expectHash(actual, scene.actualSHA256, `capture ${scene.sceneID}`);
    await expectHash(repeated, scene.repeatSHA256, `repeat capture ${scene.sceneID}`);
    await expectPngDimensions(actual, scene.pixelWidth, scene.pixelHeight, scene.sceneID);
    await expectPngDimensions(repeated, scene.pixelWidth, scene.pixelHeight, `${scene.sceneID} repeat`);
    if (scene.repeatChangedPixelPercent > 1) {
      throw new Error(`Native repeat difference exceeds 1% for ${scene.sceneID}`);
    }
  }
  for (const required of [
    "chrome-900x640",
    "tabs-markdown-1040x720",
    "markdown-lower-1040x720",
    "narrow-520x720",
    "empty-900x640",
    "find-1040x720",
    "search-empty-900x640",
    "search-no-results-900x640",
    "search-results-900x640",
  ]) {
    if (!seen.has(required)) throw new Error(`Native oracle is missing scene ${required}`);
  }
}

async function validateDesignTargets(root, exportedTargets) {
  const targetManifest = await readJson(join(root, "design-target/manifest.json"));
  if (targetManifest.kind !== "design targets, not captured production UI") {
    throw new Error("Design targets have an incorrect oracle label");
  }
  if (!Array.isArray(exportedTargets) || !Array.isArray(targetManifest.targets)) {
    throw new Error("Design target manifest is incomplete");
  }
  const exported = new Map(exportedTargets.map((target) => [target.file, target]));
  if (exported.size !== targetManifest.targets.length) throw new Error("Design target count changed during export");
  for (const target of targetManifest.targets) {
    const exportedTarget = exported.get(target.file);
    if (exportedTarget?.sha256 !== target.sha256) throw new Error(`Design target SHA mismatch for ${target.file}`);
    if (exportedTarget.widthPx !== target.width_px || exportedTarget.heightPx !== target.height_px) {
      throw new Error(`Design target dimensions disagree for ${target.file}`);
    }
    const path = join(root, "design-target", target.file);
    await expectHash(path, target.sha256, `design target ${target.file}`);
    await expectPngDimensions(path, target.width_px, target.height_px, target.file);
  }
}

async function validateBrowserDerivatives(root) {
  const derivativeRoot = join(root, "browser-derivatives");
  if (!await exists(derivativeRoot)) return new Map();
  const manifest = await readJson(join(derivativeRoot, "manifest.json"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.assets) || manifest.method !== "sips HEIC decode followed by lossless cwebp encoding") {
    throw new Error("Browser derivative manifest is invalid");
  }
  const sources = new Map((await readJson(join(root, "manifest.json"))).sourceFiles.map((file) => [file.relativePath, file.sha256]));
  if (manifest.assets.length !== 17) throw new Error(`Expected 17 HEIC derivatives, got ${manifest.assets.length}`);
  for (const asset of manifest.assets) {
    const sourceRelativePath = asset.sourceRelativePath?.replace(/^source-fixtures\//, "");
    if (sources.get(sourceRelativePath) !== asset.sourceSHA256) {
      throw new Error(`Derivative source does not match the native fixture: ${asset.sourceRelativePath}`);
    }
    if (asset.browserFormat !== "WebP lossless" || !isRelativePath(asset.derivativeRelativePath)) {
      throw new Error(`Unsupported browser derivative for ${asset.wikiImageName}`);
    }
    const path = join(root, asset.derivativeRelativePath);
    const bytes = await readFile(path);
    if (digest(bytes) !== asset.derivativeSHA256) throw new Error(`Derivative SHA-256 mismatch: ${asset.derivativeRelativePath}`);
    const dimensions = webpDimensions(bytes);
    if (dimensions.width !== asset.widthPx || dimensions.height !== asset.heightPx) {
      throw new Error(`Derivative dimensions mismatch: ${asset.derivativeRelativePath}`);
    }
  }
  const all = await treeHashes(derivativeRoot);
  if (all.size !== manifest.assets.length + 1) throw new Error("Browser derivative directory has missing or extra files");
  return new Map([...all].map(([path, hash]) => [`browser-derivatives/${path}`, hash]));
}

function validateManifest(value) {
  if (value?.schemaVersion !== 1 || value.appearance !== "Aqua" || value.backingScale !== 2) {
    throw new Error("Native oracle manifest has an unsupported schema, appearance, or scale");
  }
  if (typeof value.sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(value.sourceCommit)) {
    throw new Error("Native oracle source commit is missing or malformed");
  }
  if (typeof value.operatingSystem !== "string" || !Array.isArray(value.sourceFiles) || !Array.isArray(value.scenes)) {
    throw new Error("Native oracle provenance is incomplete");
  }
}

async function expectHash(path, expected, label) {
  const actual = await sha256(path);
  if (actual !== expected) throw new Error(`${label} SHA-256 mismatch: expected ${expected}, got ${actual}`);
}

async function expectPngDimensions(path, width, height, label) {
  const bytes = await readFile(path);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error(`${label} is not a PNG`);
  }
  const actualWidth = bytes.readUInt32BE(16);
  const actualHeight = bytes.readUInt32BE(20);
  if (actualWidth !== width || actualHeight !== height) {
    throw new Error(`${label} dimensions are ${actualWidth}x${actualHeight}; expected ${width}x${height}`);
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function sha256(path) {
  return digest(await readFile(path));
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function treeHashes(root) {
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error(`Oracle root must be a directory, not a symlink: ${root}`);
  }
  const files = new Map();
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlink in oracle tree: ${path}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.set(relative(root, path).split(sep).join("/"), await sha256(path));
      else throw new Error(`Unsupported oracle file type: ${path}`);
    }
  }
  await visit(root);
  return files;
}

function sameHashes(left, right) {
  if (left.size !== right.size) return false;
  for (const [path, hash] of left) if (right.get(path) !== hash) return false;
  return true;
}

function sameBaseAndDerivatives(source, imported, derivatives) {
  for (const [path, hash] of source) if (imported.get(path) !== hash) return false;
  const expected = new Map([...source, ...derivatives]);
  return sameHashes(expected, imported);
}

function webpDimensions(bytes) {
  if (bytes.length < 25 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") {
    throw new Error("Browser derivative is not WebP");
  }
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
    };
  }
  if (chunk === "VP8L" && bytes[20] === 0x2f) {
    return {
      width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
      height: 1 + ((bytes[22] >> 6) | (bytes[23] << 2) | ((bytes[24] & 0x0f) << 10)),
    };
  }
  throw new Error(`Unsupported WebP header ${chunk}`);
}

function isRelativePath(path) {
  return path.length > 0 && !path.startsWith("/") && !path.split(/[\\/]/).includes("..");
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
