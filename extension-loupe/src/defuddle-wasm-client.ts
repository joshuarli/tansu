import init, { list_extractors, parse_page } from "../.generated/defuddle-wasm/defuddle_wasm.js";
import { Schema } from "effect";
import { LoupeParsedPageSchema, type LoupeParsedPage } from "./tansu-schemas.ts";
import { assertPageSnapshotWithinLimit } from "./page-snapshot.ts";

let defuddleWasmInitialization: Promise<void> | undefined;

export async function parsePageWithWasm(
  pageHtml: string,
  pageUrl: string,
  extractorName: string,
): Promise<LoupeParsedPage> {
  assertPageSnapshotWithinLimit(pageHtml);
  defuddleWasmInitialization ??= init().then(() => undefined);
  await defuddleWasmInitialization;
  const parsed: unknown = JSON.parse(parse_page(pageHtml, pageUrl, extractorName));
  try {
    return Schema.decodeUnknownSync(LoupeParsedPageSchema)(parsed);
  } catch (error) {
    throw new Error("Loupe could not extract readable content from this page.", { cause: error });
  }
}

export async function listWasmExtractors(): Promise<string[]> {
  defuddleWasmInitialization ??= init().then(() => undefined);
  await defuddleWasmInitialization;
  const extractorListText = list_extractors();
  return extractorListText ? extractorListText.split("\n") : [];
}
