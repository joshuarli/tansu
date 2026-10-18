import { requestTansuImport, waitForTansuReady } from "./tansu-page-protocol.ts";
import { TANSU_PAGE_IMPORT_GLOBAL, type TansuImportPayload } from "./tansu-wire.ts";

Object.defineProperty(globalThis, TANSU_PAGE_IMPORT_GLOBAL, {
  configurable: true,
  value: {
    waitForReady: (timeoutMs: number) => waitForTansuReady(window, timeoutMs),
    requestImport: (payload: TansuImportPayload, timeoutMs: number) =>
      requestTansuImport(window, payload, timeoutMs),
  },
});
