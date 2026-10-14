import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export async function directorySize(path, fileSystem = { readdir, stat }) {
  let total = 0;
  for (const entry of await fileSystem.readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(child, fileSystem);
    } else {
      try {
        total += (await fileSystem.stat(child)).size;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  return total;
}
