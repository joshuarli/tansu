import type { LoupeParsedPage, SendToTansuRequest } from "./tansu-schemas.ts";

export interface ListExtractorsResponse {
  extractorNames: string[];
}

export interface ParsePageRequest {
  action: "parsePage";
  pageHtml: string;
  pageUrl: string;
  extractorName: string;
}

export interface ListExtractorsRequest {
  action: "listExtractors";
}

export interface DownloadReaderFixturesRequest {
  action: "downloadFixtures";
  rawPageHtml: string;
  extractedContentHtml: string;
  extractedContentMarkdown: string | null;
  readerUiHtml: string;
  downloadSlug: string;
  extractorName: string;
}

export type DownloadReaderFixturesResponse = { ok: true } | { ok: false; error: string };

export interface OpenObsidianUrlRequest {
  action: "openObsidian";
  obsidianUrl: string;
}

export type OpenObsidianUrlResponse = { ok: true } | { ok: false; error: string };

export interface OpenOptionsRequest {
  action: "openOptions";
}

export interface OpenTansuTabRequest {
  action: "openTansuTab";
}

export interface ToggleReaderMessage {
  action: "toggle";
}

export interface SendPageToTansuMessage {
  action: "sendPageToTansu";
}

export type ContentScriptMessage = ToggleReaderMessage | SendPageToTansuMessage;

export type ServiceWorkerRequest =
  | ParsePageRequest
  | ListExtractorsRequest
  | DownloadReaderFixturesRequest
  | OpenObsidianUrlRequest
  | SendToTansuRequest
  | OpenOptionsRequest
  | OpenTansuTabRequest;

export type ParsePageResponse =
  | { ok: true; parsedPage: LoupeParsedPage }
  | { ok: false; error: string };
