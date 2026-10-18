export const TANSU_CHANNEL = "tansu";
export const TANSU_PROTOCOL_VERSION = 1;
export const TANSU_IMAGE_PLACEHOLDER_SCHEME = "tansu-import-image:";
export const TANSU_READY_TIMEOUT_MS = 3 * 60_000;
export const TANSU_RESULT_TIMEOUT_MS = 2 * 60_000;
export const TANSU_PING_INTERVAL_MS = 1_000;
export const TANSU_BACKGROUND_READY_GRACE_MS = 3_000;
export const TANSU_PAGE_IMPORT_GLOBAL = "__loupeTansuImport";

export interface TansuImportImage {
  id: number;
  url: string;
  contentType: string;
  base64: string | null;
}

export interface TansuImportPayload {
  title: string;
  markdown: string;
  sourceUrl: string;
  images: TansuImportImage[];
}

export type TansuPageOutcome =
  | { kind: "message"; message: unknown }
  | { kind: "timeout"; phase: "ready" | "result" };
