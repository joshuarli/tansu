export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function logLoupeError(
  logMessage: string,
  error: unknown,
  context?: Record<string, unknown>,
): void {
  const normalized = error instanceof Error ? error : new Error(String(error));
  if (context) {
    console.error(logMessage, normalized, context);
  } else {
    console.error(logMessage, normalized);
  }
}
