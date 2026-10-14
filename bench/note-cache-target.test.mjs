import { resolve } from "node:path";
import { test } from "node:test";

import { requireTargetNote } from "./note-cache-target.mjs";

const FIXTURE_VAULT = resolve(import.meta.dirname, "../tests/fixtures/test-vaults/vault-one");

test("cache benchmark target exists in the copied vault fixture", async () => {
  await requireTargetNote(FIXTURE_VAULT);
});
