export type TansuPageMethod = "waitForReady" | "requestImport";

export function tansuPageCall(
  tabId: number,
  globalName: string,
  method: TansuPageMethod,
  methodArguments: unknown[],
) {
  return {
    target: { tabId },
    args: [JSON.stringify([globalName, method, methodArguments])] as [string],
    func: (encoded: string) => {
      const [name, methodName, parsedArguments] = JSON.parse(encoded) as [string, string, unknown[]];
      const api = (globalThis as unknown as Record<string, Record<string, (...values: unknown[]) => unknown>>)[
        name
      ]!;
      return api[methodName]!(...parsedArguments);
    },
  };
}
