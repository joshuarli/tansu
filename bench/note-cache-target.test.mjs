import { resolve } from "node:path";
import { describe, it } from "vitest";

import { requireTargetNote } from "./note-cache-target.mjs";

const FIXTURE_VAULT = resolve(import.meta.dirname, "../tests/fixtures/demo-vault");

describe("cache benchmark target", () => {
  it("exists in the demo vault", async () => {
    await requireTargetNote(FIXTURE_VAULT);
  });
});
