import { Schema } from "effect";
import { TansuSettingsSchema } from "./tansu-schemas.ts";

export interface TansuSettingsStorage {
  get(keys: string): Promise<Record<string, unknown>>;
}

export async function readTansuSettings(storage: TansuSettingsStorage) {
  return Schema.decodeUnknownSync(TansuSettingsSchema)(await storage.get("tansuOrigin"));
}
