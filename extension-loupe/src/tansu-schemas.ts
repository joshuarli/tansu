import { Schema } from "effect";
import { TANSU_CHANNEL, TANSU_PROTOCOL_VERSION } from "./tansu-wire.ts";

export const TANSU_ORIGIN_PATTERN = /^https?:\/\/[^/?#\s]+$/u;

export const TansuOriginSchema = Schema.String.check(Schema.isPattern(TANSU_ORIGIN_PATTERN)),
  TansuSettingsSchema = Schema.Struct({
    tansuOrigin: Schema.optional(TansuOriginSchema),
  }),
  TansuImportResultSchema = Schema.Union([
    Schema.Struct({
      channel: Schema.Literal(TANSU_CHANNEL),
      version: Schema.Literal(TANSU_PROTOCOL_VERSION),
      type: Schema.Literal("import.result"),
      requestId: Schema.String,
      ok: Schema.Literal(true),
      noteId: Schema.String,
      path: Schema.String,
      imagesLocalized: Schema.Number,
      imagesFailed: Schema.Number,
    }),
    Schema.Struct({
      channel: Schema.Literal(TANSU_CHANNEL),
      version: Schema.Literal(TANSU_PROTOCOL_VERSION),
      type: Schema.Literal("import.result"),
      requestId: Schema.String,
      ok: Schema.Literal(false),
      error: Schema.String,
    }),
  ]),
  TansuPageOutcomeSchema = Schema.Union([
    Schema.Struct({ kind: Schema.Literal("message"), message: Schema.Unknown }),
    Schema.Struct({ kind: Schema.Literal("timeout"), phase: Schema.Literals(["ready", "result"]) }),
  ]),
  SendToTansuRequestSchema = Schema.Struct({
    action: Schema.Literal("sendToTansu"),
    title: Schema.String,
    markdown: Schema.String,
    sourceUrl: Schema.String,
  }),
  SendToTansuResponseSchema = Schema.Union([
    Schema.Struct({
      ok: Schema.Literal(true),
      noteId: Schema.String,
      path: Schema.String,
      imagesLocalized: Schema.Number,
      imagesFailed: Schema.Number,
    }),
    Schema.Struct({
      ok: Schema.Literal(false),
      reason: Schema.Literals(["not-configured", "failed"]),
      error: Schema.String,
    }),
  ]);

export type TansuImportResult = Schema.Schema.Type<typeof TansuImportResultSchema>;
export type SendToTansuRequest = Schema.Schema.Type<typeof SendToTansuRequestSchema>;
export type SendToTansuResponse = Schema.Schema.Type<typeof SendToTansuResponseSchema>;

export function normalizeTansuOrigin(input: string): string | undefined {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return undefined;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
}
