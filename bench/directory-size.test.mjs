import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { directorySize } from "./directory-size.mjs";

describe("directory size", () => {
  it("ignores an index file that vanishes during the walk", async () => {
    const fileSystem = {
      readdir: async () => [{ name: ".tmp-index", isDirectory: () => false }],
      stat: async () => {
        const error = new Error("file disappeared");
        error.code = "ENOENT";
        throw error;
      },
    };

    assert.equal(await directorySize("/fixture", fileSystem), 0);
  });
});
