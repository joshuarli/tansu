import { cp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SOURCE_ROOT = join(REPO_ROOT, "tests", "fixtures", "test-vaults");

export async function createTestFixture(root, opts = {}) {
  const fixtureRoot = resolve(root);
  const configHome = join(fixtureRoot, "config");
  const dataHome = join(fixtureRoot, "data");
  const copyVaults = opts.copyVaults ?? false;
  const generatedVaultOne = join(fixtureRoot, "vault-one");
  const generatedVaultTwo = join(fixtureRoot, "vault-two");
  const vaultOne = copyVaults ? generatedVaultOne : join(SOURCE_ROOT, "vault-one");
  const vaultTwo = copyVaults ? generatedVaultTwo : join(SOURCE_ROOT, "vault-two");

  if (copyVaults) {
    for (const path of [fixtureRoot, configHome, dataHome, vaultOne, vaultTwo]) {
      assertTestFixtureRoot(path);
    }
  }

  await rm(configHome, { recursive: true, force: true });
  await rm(dataHome, { recursive: true, force: true });
  await rm(generatedVaultOne, { recursive: true, force: true });
  await rm(generatedVaultTwo, { recursive: true, force: true });
  await rm(join(fixtureRoot, "vault"), { recursive: true, force: true });

  await mkdir(configHome, { recursive: true });
  await mkdir(dataHome, { recursive: true });
  if (copyVaults) {
    await cp(join(SOURCE_ROOT, "vault-one"), vaultOne, { recursive: true });
    await cp(join(SOURCE_ROOT, "vault-two"), vaultTwo, { recursive: true });
  }

  return { configHome, dataHome, vaultOne, vaultTwo };
}

export function assertTestFixtureRoot(path) {
  const candidate = resolve(path);
  const allowedRoots = [join(REPO_ROOT, ".work"), tmpdir()].map((root) => resolve(root));
  const allowed = allowedRoots.some((root) => {
    const fromRoot = relative(root, candidate);
    return fromRoot === "" ||
      (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
  });
  if (!allowed) {
    throw new Error("test fixture roots must be under .work or the OS temporary directory");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.argv[2];
  if (!root) {
    console.error("usage: node scripts/test-fixture.mjs <root> [--copy-vaults]");
    process.exit(2);
  }
  const fixture = await createTestFixture(root, {
    copyVaults: process.argv.includes("--copy-vaults"),
  });
  console.log(JSON.stringify(fixture));
}
