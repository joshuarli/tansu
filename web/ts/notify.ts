import { uiStore } from "./ui-store.ts";

export function describeError(error: unknown, fallback = "Unknown error"): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function reportActionError(action: string, error: unknown): void {
  uiStore.showNotification(`${action}: ${describeError(error)}`, "error");
}
