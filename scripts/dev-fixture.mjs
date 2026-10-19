import { execFileSync } from "node:child_process";
import { cp, lstat, mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SOURCE_ROOT = join(REPO_ROOT, "tests", "fixtures", "demo-vault");
const FIELD_NOTES_SOURCE_ROOT = join(REPO_ROOT, "tests", "fixtures", "demo-vault-field-notes");

function isWithin(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

async function assertNoSymlinkPath(root, candidate) {
  const relativePath = relative(root, candidate);
  let current = root;
  for (const segment of ["", ...relativePath.split(sep).filter(Boolean)]) {
    if (segment) current = join(current, segment);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) throw new Error(`refusing symbolic link: ${current}`);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
  }
}

const requestedRoot = process.argv[2];
if (!requestedRoot) throw new Error("usage: node scripts/dev-fixture.mjs <root>");

const fixtureRoot = resolve(requestedRoot);
const allowedRoots = [join(REPO_ROOT, ".dev"), join(REPO_ROOT, ".work", "tmp")];
const allowedRoot = allowedRoots.find((root) => isWithin(root, fixtureRoot));
if (!allowedRoot) throw new Error("development fixture roots must be under .dev or .work/tmp");
await assertNoSymlinkPath(REPO_ROOT, allowedRoot);
await assertNoSymlinkPath(allowedRoot, fixtureRoot);

const configHome = join(fixtureRoot, "config");
const dataHome = join(fixtureRoot, "data");
const vaults = [
  { name: "Demo", source: SOURCE_ROOT, root: join(fixtureRoot, "vault") },
  { name: "Field Notes", source: FIELD_NOTES_SOURCE_ROOT, root: join(fixtureRoot, "vault-field-notes") },
];
for (const path of [configHome, dataHome, ...vaults.map((vault) => vault.root)]) {
  await assertNoSymlinkPath(fixtureRoot, path);
  await rm(path, { recursive: true, force: true });
}

await mkdir(configHome, { recursive: true });
await mkdir(dataHome, { recursive: true });
for (const vault of vaults) await cp(vault.source, vault.root, { recursive: true });
const initializeArgs = ["run", "--quiet", "--bin", "tansu", "--", "config", "init"];
for (const vault of vaults) initializeArgs.push("--vault", vault.name, vault.root);
execFileSync("cargo", initializeArgs, {
  cwd: REPO_ROOT,
  env: { ...process.env, XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome },
  stdio: "inherit",
});

console.log(JSON.stringify({ configHome, dataHome, vaults: vaults.map(({ name, root }) => ({ name, root })) }));
