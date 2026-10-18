import init, { list_extractors, parse_page } from "../.generated/defuddle-wasm/defuddle_wasm.js";
import { assertPageSnapshotWithinLimit } from "./page-snapshot.ts";
import type { LoupeParsedPage } from "./extension-messages.ts";

let defuddleWasmInitialization: Promise<void> | undefined;

export async function parsePageWithWasm(
  pageHtml: string,
  pageUrl: string,
  extractorName: string,
): Promise<LoupeParsedPage> {
  assertPageSnapshotWithinLimit(pageHtml);
  defuddleWasmInitialization ??= init().then(() => undefined);
  await defuddleWasmInitialization;
  return JSON.parse(parse_page(pageHtml, pageUrl, extractorName)) as LoupeParsedPage;
}

export async function listWasmExtractors(): Promise<string[]> {
  defuddleWasmInitialization ??= init().then(() => undefined);
  await defuddleWasmInitialization;
  const extractorListText = list_extractors();
  return extractorListText ? extractorListText.split("\n") : [];
}
