import { stat } from "node:fs/promises";
import { join } from "node:path";

export const targetNotePath = "2026-02-05-claude-code-is-the-inflection-point.md";

export async function requireTargetNote(vaultPath) {
  const path = join(vaultPath, targetNotePath);
  try {
    if (!(await stat(path)).isFile()) {
      throw new Error(`cache benchmark target is not a file: ${targetNotePath}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error(`cache benchmark target is missing: ${targetNotePath}`, { cause: error });
  }
}
