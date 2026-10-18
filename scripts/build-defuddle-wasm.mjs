import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
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
  return wasmBindgenCandidates.find((candidate) => {
    const version = readWasmBindgenVersion(candidate);
    return crateVersion ? version === crateVersion : version;
  });
}

function ensureWasmBindgen() {
  const crateVersion = readWasmBindgenCrateVersion(),
    installed = findWasmBindgen(crateVersion);
  if (installed) {
    return installed;
  }

  const installArgs = ["install", "wasm-bindgen-cli", "--force"];
  if (crateVersion) {
    installArgs.push("--version", crateVersion);
  }
  console.log(
    `Compatible wasm-bindgen${crateVersion ? ` ${crateVersion}` : ""} not found. Installing with: cargo ${installArgs.join(" ")}`,
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
