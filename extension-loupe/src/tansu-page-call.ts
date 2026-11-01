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
      const decoded: unknown = JSON.parse(encoded);
      if (!Array.isArray(decoded) || decoded.length !== 3) {
        throw new Error("Loupe received a malformed Tansu page call.");
      }
      const [name, methodName, parsedArguments] = decoded;
      if (typeof name !== "string" || typeof methodName !== "string" || !Array.isArray(parsedArguments)) {
        throw new Error("Loupe received a malformed Tansu page call.");
      }
      const api: unknown = (globalThis as unknown as Record<string, unknown>)[name];
      if (typeof api !== "object" || api === null) {
        throw new Error("The Tansu page API is not available.");
      }
      const apiMethod: unknown = (api as Record<string, unknown>)[methodName];
      if (typeof apiMethod !== "function") {
        throw new Error("The Tansu page API is not available.");
      }
      return apiMethod(...parsedArguments);
    },
  };
}
