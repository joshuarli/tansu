import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, ".."),
  defuddleRepositoryRoot = resolve(
    process.env.DEFUDDLE_RS_DIR || resolve(repositoryRoot, "../defuddle-rs"),
  ),
  cargoTargetDirectory = resolve(
    process.env.CARGO_TARGET_DIR || resolve(repositoryRoot, ".work/target-defuddle-wasm"),
  ),
  cargoHome = process.env.CARGO_HOME || resolve(homedir(), ".cargo"),
  wasmBindgenCandidates = [
    process.env.WASM_BINDGEN,
    "wasm-bindgen",
    resolve(cargoHome, "bin/wasm-bindgen"),
  ].filter((wasmBindgenCandidate) => wasmBindgenCandidate),
  wasmSourcePath = resolve(
    cargoTargetDirectory,
    "wasm32-unknown-unknown/wasm-release/defuddle_wasm.wasm",
  ),
  generatedWasmDirectory = resolve(repositoryRoot, "extension-loupe/.generated/defuddle-wasm"),
  wasmOptCandidates = [
    process.env.WASM_OPT,
    "wasm-opt",
    "/opt/homebrew/opt/binaryen/bin/wasm-opt",
    "/usr/local/opt/binaryen/bin/wasm-opt",
  ].filter((wasmOptCandidate) => wasmOptCandidate);

const prebuiltWasmBindgenReleases = {
  "0.2.129": {
    "aarch64-apple-darwin": "81d4a23d56b3c3eb8187658329116d50e0b228a93b343825fb71f70179051cd1",
    "x86_64-apple-darwin": "7e028879a68ec53dae14048b55cc5215f6df75b17a9c1426fac8fa086d3202fd",
    "aarch64-unknown-linux-musl": "2ed4351c35dd9440308bbb02767d47ea278efe851a52465300f3c94f5b6c2a87",
    "x86_64-unknown-linux-musl": "82d12bb940e2d4e72e0d5605387fc1b8ca179044e012b620f0ce4e7440e8320e",
  },
};

function prebuiltWasmBindgenTarget() {
  const hostArchitecture =
    process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : undefined;
  if (!hostArchitecture) {
    return undefined;
  }
  if (process.platform === "darwin") {
    return `${hostArchitecture}-apple-darwin`;
  }
  if (process.platform === "linux") {
    return `${hostArchitecture}-unknown-linux-musl`;
  }
  return undefined;
}

function wasmBindgenHostTarget() {
  return prebuiltWasmBindgenTarget() || `${process.platform}-${process.arch}`;
}

function wasmBindgenCacheDirectory(version, target) {
  return resolve(cargoHome, "wasm-bindgen-cli", version, target);
}

function cachedWasmBindgen(version, target) {
  const assetDirectory = `wasm-bindgen-${version}-${target}`;
  return resolve(wasmBindgenCacheDirectory(version, target), assetDirectory, "wasm-bindgen");
}

function cargoInstallWasmBindgenRoot(version, target) {
  return resolve(wasmBindgenCacheDirectory(version, target), "cargo-install");
}

function cachedCargoInstallWasmBindgen(version, target) {
  return resolve(cargoInstallWasmBindgenRoot(version, target), "bin", "wasm-bindgen");
}

if (!existsSync(defuddleRepositoryRoot)) {
  throw new Error(
    `Could not find defuddle-rs at ${defuddleRepositoryRoot}. Set DEFUDDLE_RS_DIR to its path.`,
  );
}

function readWasmBindgenCrateVersion() {
  try {
    const cargoLock = readFileSync(resolve(defuddleRepositoryRoot, "Cargo.lock"), "utf8");
    return cargoLock.match(/^name = "wasm-bindgen"\nversion = "([^"]+)"/m)?.[1];
  } catch {
    return undefined;
  }
}

function readWasmBindgenVersion(candidate) {
  try {
    return execFileSync(candidate, ["--version"], { encoding: "utf8" })
      .trim()
      .match(/^wasm-bindgen\s+(\S+)$/)?.[1];
  } catch {
    return undefined;
  }
}

function findWasmBindgen(crateVersion) {
  const candidates = [...wasmBindgenCandidates];
  const version = crateVersion || "unlocked",
    target = wasmBindgenHostTarget();
  candidates.push(cachedCargoInstallWasmBindgen(version, target));
  if (crateVersion && prebuiltWasmBindgenTarget()) {
    candidates.push(cachedWasmBindgen(crateVersion, target));
  }
  return candidates.find((candidate) => {
    const version = readWasmBindgenVersion(candidate);
    return crateVersion ? version === crateVersion : version;
  });
}

function installPrebuiltWasmBindgen(version) {
  const target = prebuiltWasmBindgenTarget(),
    checksum = prebuiltWasmBindgenReleases[version]?.[target];
  if (!target || !checksum) {
    return undefined;
  }

  const asset = `wasm-bindgen-${version}-${target}.tar.gz`,
    cacheDirectory = wasmBindgenCacheDirectory(version, target),
    assetDirectory = asset.slice(0, -".tar.gz".length),
    cacheParent = resolve(cacheDirectory, ".."),
    releaseUrl = `https://github.com/wasm-bindgen/wasm-bindgen/releases/download/${version}/${asset}`;
  mkdirSync(cacheParent, { recursive: true, mode: 0o700 });
  if (existsSync(cacheDirectory)) {
    const cached = cachedWasmBindgen(version, target);
    if (readWasmBindgenVersion(cached) === version) {
      return cached;
    }
    rmSync(cacheDirectory, { force: true, recursive: true });
  }

  const stagingDirectory = mkdtempSync(resolve(cacheParent, `${target}-`));
  try {
    const archivePath = resolve(stagingDirectory, asset);
    execFileSync(
      "curl",
      ["--fail", "--location", "--silent", "--show-error", "--output", archivePath, releaseUrl],
      { cwd: repositoryRoot, stdio: "inherit" },
    );
    chmodSync(archivePath, 0o600);
    const archive = readFileSync(archivePath),
      actualChecksum = createHash("sha256").update(archive).digest("hex");
    if (actualChecksum !== checksum) {
      throw new Error(
        `Checksum mismatch for ${asset}: expected ${checksum}, received ${actualChecksum}`,
      );
    }

    execFileSync("tar", ["-xzf", archivePath, "-C", stagingDirectory], {
      cwd: repositoryRoot,
      stdio: "inherit",
    });
    rmSync(archivePath);

    const stagedBinary = resolve(stagingDirectory, assetDirectory, "wasm-bindgen");
    chmodSync(stagedBinary, 0o755);
    if (readWasmBindgenVersion(stagedBinary) !== version) {
      throw new Error(`Downloaded ${asset} does not contain wasm-bindgen ${version}.`);
    }

    try {
      renameSync(stagingDirectory, cacheDirectory);
    } catch (error) {
      const cached = cachedWasmBindgen(version, target);
      if (readWasmBindgenVersion(cached) !== version) {
        throw error;
      }
      rmSync(stagingDirectory, { force: true, recursive: true });
      return cached;
    }
    return cachedWasmBindgen(version, target);
  } catch (error) {
    rmSync(stagingDirectory, { force: true, recursive: true });
    throw error;
  }
}

function ensureWasmBindgen() {
  const crateVersion = readWasmBindgenCrateVersion(),
    installed = findWasmBindgen(crateVersion);
  if (installed) {
    return installed;
  }

  if (crateVersion) {
    console.log(
      `Compatible wasm-bindgen ${crateVersion} not found. Checking for a verified prebuilt release.`,
    );
    const prebuilt = installPrebuiltWasmBindgen(crateVersion);
    if (prebuilt) {
      return prebuilt;
    }
  }

  const cacheVersion = crateVersion || "unlocked",
    hostTarget = wasmBindgenHostTarget(),
    installArgs = [
      "install",
      "wasm-bindgen-cli",
      "--force",
      "--root",
      cargoInstallWasmBindgenRoot(cacheVersion, hostTarget),
    ];
  if (crateVersion) {
    installArgs.push("--version", crateVersion);
  }
  console.log(
    `No verified prebuilt wasm-bindgen release is available. Installing with: cargo ${installArgs.join(" ")}`,
  );
  try {
    execFileSync("cargo", installArgs, { cwd: repositoryRoot, stdio: "inherit" });
  } catch (error) {
    throw new Error("Could not install wasm-bindgen-cli.", { cause: error });
  }
  const freshInstall = findWasmBindgen(crateVersion);
  if (!freshInstall) {
    throw new Error(
      `Installed wasm-bindgen-cli but could not find a compatible wasm-bindgen executable${crateVersion ? ` for version ${crateVersion}` : ""}.`,
    );
  }
  return freshInstall;
}

const wasmBindgen = ensureWasmBindgen();

function activeRustToolchain() {
  try {
    const activeToolchain = execFileSync("rustup", ["show", "active-toolchain"], {
      cwd: defuddleRepositoryRoot,
      encoding: "utf8",
    });
    return activeToolchain.split(/\s/, 1)[0];
  } catch {
    throw new Error(
      "Could not determine the active Rust toolchain. Install the wasm32-unknown-unknown target with: rustup target add wasm32-unknown-unknown",
    );
  }
}

function ensureWasmTarget() {
  const toolchain = activeRustToolchain();
  try {
    const installedTargets = execFileSync(
      "rustup",
      ["target", "list", "--toolchain", toolchain, "--installed"],
      { encoding: "utf8" },
    );
    if (installedTargets.split(/\s+/).includes("wasm32-unknown-unknown")) {
      return;
    }
  } catch {
    throw new Error(
      "Could not list Rust targets. Install the wasm32-unknown-unknown target with: rustup target add wasm32-unknown-unknown",
    );
  }
  console.log(
    `wasm32-unknown-unknown target not found for ${toolchain}. Installing with: rustup target add --toolchain ${toolchain} wasm32-unknown-unknown`,
  );
  try {
    execFileSync("rustup", ["target", "add", "--toolchain", toolchain, "wasm32-unknown-unknown"], {
      cwd: repositoryRoot,
      stdio: "inherit",
    });
  } catch (error) {
    throw new Error("Could not install the wasm32-unknown-unknown Rust target.", {
      cause: error,
    });
  }
}

ensureWasmTarget();

execFileSync(
  "cargo",
  [
    "build",
    "--locked",
    "--profile",
    "wasm-release",
    "-p",
    "defuddle-wasm",
    "--target",
    "wasm32-unknown-unknown",
  ],
  {
    cwd: defuddleRepositoryRoot,
    env: { ...process.env, CARGO_TARGET_DIR: cargoTargetDirectory },
    stdio: "inherit",
  },
);

if (!existsSync(wasmSourcePath)) {
  throw new Error(`Cargo did not produce ${wasmSourcePath}`);
}

rmSync(generatedWasmDirectory, { force: true, recursive: true });
mkdirSync(generatedWasmDirectory, { recursive: true });
execFileSync(
  wasmBindgen,
  [wasmSourcePath, "--out-dir", generatedWasmDirectory, "--target", "web"],
  {
    cwd: repositoryRoot,
    stdio: "inherit",
  },
);

const generatedWasmPath = resolve(generatedWasmDirectory, "defuddle_wasm_bg.wasm"),
  optimizedWasmPath = resolve(generatedWasmDirectory, "defuddle_wasm_bg.optimized.wasm");
function ensureWasmOpt() {
  const installed = wasmOptCandidates.find((candidate) => {
    try {
      execFileSync(candidate, ["--version"], { encoding: "utf8" });
      return true;
    } catch {
      return false;
    }
  });
  if (installed) {
    return installed;
  }
  if (process.platform === "darwin") {
    try {
      execFileSync("brew", ["--version"], { encoding: "utf8" });
    } catch {
      throw new Error(
        "Could not find wasm-opt. Install Binaryen, add wasm-opt to PATH, or set WASM_OPT to its executable path.",
      );
    }
    console.log("wasm-opt not found. Installing with: brew install binaryen");
    try {
      execFileSync("brew", ["install", "binaryen"], { cwd: repositoryRoot, stdio: "inherit" });
    } catch (error) {
      throw new Error("Could not install Binaryen with Homebrew.", { cause: error });
    }
    const freshInstall = wasmOptCandidates.find((candidate) => {
      try {
        execFileSync(candidate, ["--version"], { encoding: "utf8" });
        return true;
      } catch {
        return false;
      }
    });
    if (!freshInstall) {
      throw new Error("Installed Binaryen but could not run wasm-opt.");
    }
    return freshInstall;
  }
  throw new Error(
    "Could not find wasm-opt. Install Binaryen, add wasm-opt to PATH, or set WASM_OPT to its executable path.",
  );
}

const wasmOpt = ensureWasmOpt();
execFileSync(
  wasmOpt,
  [
    generatedWasmPath,
    "-Oz",
    "--strip-debug",
    "--enable-bulk-memory",
    "--enable-bulk-memory-opt",
    "--enable-nontrapping-float-to-int",
    "-o",
    optimizedWasmPath,
  ],
  {
    cwd: repositoryRoot,
    stdio: "inherit",
  },
);
rmSync(generatedWasmPath);
renameSync(optimizedWasmPath, generatedWasmPath);

const sizeInBytes = statSync(generatedWasmPath).size;

console.log(
  `Generated optimized WASM bindings in ${generatedWasmDirectory} (${sizeInBytes} bytes)`,
);
