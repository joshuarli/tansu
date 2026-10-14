import { blake3 } from "@noble/hashes/blake3.js";

import type { SaveNoteDeltaRequest, TextEdit, TextPosition } from "./types.generated.ts";

export async function buildSaveNoteDeltaRequest(
  baseContent: string,
  nextContent: string,
  baseSeq: number,
  baseHash: string,
  checkpoint: boolean | null,
): Promise<SaveNoteDeltaRequest> {
  const base = normalizeMarkdownNewlines(baseContent);
  const next = normalizeMarkdownNewlines(nextContent);
  return {
    baseSeq,
    baseHash,
    contentHash: await canonicalContentHash(next),
    edits: computeTextEdits(base, next),
    checkpoint,
  };
}

export function computeTextEdits(base: string, next: string): TextEdit[] {
  if (base === next) {
    return [];
  }
  let start = commonPrefixLength(base, next);
  start = retreatToCodePointBoundary(base, retreatToCodePointBoundary(next, start));

  let suffix = commonSuffixLength(base, next, start);
  suffix = trimSuffixToCodePointBoundary(base, next, suffix);
  while (suffix > 0 && (base.length - suffix < start || next.length - suffix < start)) {
    suffix -= 1;
    suffix = trimSuffixToCodePointBoundary(base, next, suffix);
  }

  const end = base.length - suffix;
  const nextEnd = next.length - suffix;
  return [
    {
      start: offsetToPosition(base, start),
      end: offsetToPosition(base, end),
      text: next.slice(start, nextEnd),
    },
  ];
}

export async function canonicalContentHash(content: string): Promise<string> {
  return canonicalSourceHash(content);
}

export async function canonicalSourceHash(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizeMarkdownNewlines(content));
  return `blake3-v3:${hex(blake3(bytes))}`;
}

function normalizeMarkdownNewlines(markdown: string): string {
  return markdown.replaceAll(/\r\n?/g, "\n");
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.codePointAt(index) === right.codePointAt(index)) {
    index += 1;
  }
  return index;
}

function commonSuffixLength(left: string, right: string, prefixLength: number): number {
  const limit = Math.min(left.length - prefixLength, right.length - prefixLength);
  let suffix = 0;
  while (
    suffix < limit &&
    left.codePointAt(left.length - suffix - 1) === right.codePointAt(right.length - suffix - 1)
  ) {
    suffix += 1;
  }
  return suffix;
}

function offsetToPosition(content: string, offset: number): TextPosition {
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < offset; index++) {
    if (content.codePointAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, character: offset - lineStart };
}

function retreatToCodePointBoundary(content: string, offset: number): number {
  if (
    offset > 0 &&
    offset < content.length &&
    isHighSurrogate(content.charCodeAt(offset - 1)) &&
    isLowSurrogate(content.charCodeAt(offset))
  ) {
    return offset - 1;
  }
  return offset;
}

function trimSuffixToCodePointBoundary(base: string, next: string, suffix: number): number {
  let safeSuffix = suffix;
  while (
    safeSuffix > 0 &&
    (!isCodePointBoundary(base, base.length - safeSuffix) ||
      !isCodePointBoundary(next, next.length - safeSuffix))
  ) {
    safeSuffix -= 1;
  }
  return safeSuffix;
}

function isCodePointBoundary(content: string, offset: number): boolean {
  return (
    offset <= 0 ||
    offset >= content.length ||
    !(isHighSurrogate(content.charCodeAt(offset - 1)) && isLowSurrogate(content.charCodeAt(offset)))
  );
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
