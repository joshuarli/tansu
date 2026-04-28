import { emit } from "./events.ts";

export function describeError(error: unknown, fallback = "Unknown error"): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function reportActionError(action: string, error: unknown): void {
  emit("notification", {
    msg: `${action}: ${describeError(error)}`,
    type: "error",
  });
}
