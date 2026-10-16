import { expect, describe, it } from "vitest";

import { canonicalSourceHash } from "./source-hash.ts";

describe("canonical source hash", () => {
  it("hashes LF-normalized editor source", async () => {
    const lf = await canonicalSourceHash("# A\n");

    await expect(canonicalSourceHash("# A\r\n")).resolves.toBe(lf);
    expect(lf).toBe("blake3-v3:83c0644fd4a5e2389d802f496de4b3a0df19f6f64ae165556fac2e91cbb14c1f");
  });
});
