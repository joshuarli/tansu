import { expect, describe, it } from "vitest";

import { normalizeTag } from "./markdown-tags.ts";

describe("tag normalization", () => {
  it("normalizes user-entered tag values", () => {
    expect(normalizeTag(" #alpha ")).toBe("alpha");
    expect(normalizeTag("")).toBeNull();
    expect(normalizeTag("bad\ntag")).toBeNull();
  });
});
