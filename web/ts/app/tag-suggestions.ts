import type { V2LinkedNote, V2NoteMeta, V2SearchHit } from "../types.generated.ts";

const MAX_SOURCE_LENGTH = 32 * 1024;
const MAX_QUERY_COUNT = 4;
const MAX_SUGGESTION_COUNT = 5;
const MAX_TERM_LENGTH = 64;
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "but",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "these",
  "this",
  "those",
  "to",
  "was",
  "were",
  "with",
]);

export type TagSuggestion = { tag: string; notes: V2LinkedNote[] };

export function tagSuggestionQueries(source: string): string[] {
  const boundedSource = source.slice(0, MAX_SOURCE_LENGTH);
  const body = withoutLeadingFrontmatter(boundedSource);
  if (body === "") return [];

  const lines = body.split(/\r?\n/);
  const priorityLines: string[] = [];
  const bodyLines: string[] = [];
  let fence: { marker: "`" | "~"; length: number } | null = null;
  let hasTitle = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const fenceMarker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== null) {
      if (
        fenceMarker !== undefined &&
        fenceMarker.startsWith(fence.marker) &&
        fenceMarker.length >= fence.length &&
        /^ {0,3}(?:`{3,}|~{3,})[ \t]*$/.test(line)
      ) {
        fence = null;
      }
      continue;
    }
    if (fenceMarker !== undefined) {
      fence = {
        marker: fenceMarker.startsWith("`") ? "`" : "~",
        length: fenceMarker.length,
      };
      continue;
    }

    const atxHeading = /^ {0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/.exec(line)?.[1];
    if (atxHeading !== undefined) {
      priorityLines.push(atxHeading);
      hasTitle = true;
      continue;
    }
    const nextLine = lines[index + 1];
    if (nextLine !== undefined && /^ {0,3}(?:=+|-+)[ \t]*$/.test(nextLine) && line.trim() !== "") {
      priorityLines.push(line);
      hasTitle = true;
      index++;
      continue;
    }
    if (!hasTitle && line.trim() !== "") {
      priorityLines.push(titleFromLine(line));
      hasTitle = true;
      continue;
    }
    bodyLines.push(line);
  }

  const headings = countTerms(cleanMarkdown(priorityLines.join("\n")));
  const bodyTerms = countTerms(cleanMarkdown(bodyLines.join("\n")));
  const prioritized = [
    ...sortedTerms(headings),
    ...sortedTerms(bodyTerms).filter((term) => !headings.has(term)),
  ];
  return prioritized.slice(0, MAX_QUERY_COUNT);
}

export function rankTagSuggestions(input: {
  notes: ReadonlyMap<string, V2NoteMeta>;
  hits: readonly V2SearchHit[];
  currentNoteId: string | null;
  existingTags: readonly string[];
}): TagSuggestion[] {
  const canonicalNotes = new Map<string, V2NoteMeta>();

  for (const hit of input.hits) {
    if (hit.identity.kind !== "canonical") continue;
    const noteId = hit.identity.noteId;
    if (noteId === input.currentNoteId || canonicalNotes.has(noteId)) continue;
    const meta = input.notes.get(noteId);
    if (
      meta === undefined ||
      meta.noteId !== noteId ||
      meta.revision !== hit.identity.revision ||
      meta.sourceHash !== hit.identity.sourceHash
    ) {
      continue;
    }
    canonicalNotes.set(noteId, meta);
  }

  const existingTags = new Set(input.existingTags);
  const supportingNotes = new Map<string, Map<string, V2LinkedNote>>();
  const orderedNotes = [...canonicalNotes.values()].toSorted((left, right) =>
    compareText(left.path, right.path) || compareText(left.noteId, right.noteId)
  );

  for (const meta of orderedNotes) {
    const linkedNote = { noteId: meta.noteId, path: meta.path, title: meta.title };
    for (const tag of new Set(meta.tags)) {
      if (tag.trim() === "" || existingTags.has(tag)) continue;
      const notes = supportingNotes.get(tag) ?? new Map<string, V2LinkedNote>();
      notes.set(meta.noteId, linkedNote);
      supportingNotes.set(tag, notes);
    }
  }

  return [...supportingNotes.entries()]
    .map(([tag, notes]) => ({ tag, notes: [...notes.values()] }))
    .toSorted((left, right) =>
      right.notes.length - left.notes.length || compareText(left.tag, right.tag)
    )
    .slice(0, MAX_SUGGESTION_COUNT);
}

function withoutLeadingFrontmatter(source: string): string {
  const withoutBom = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const firstLineEnd = withoutBom.indexOf("\n");
  const firstLine = firstLineEnd === -1 ? withoutBom : withoutBom.slice(0, firstLineEnd).replace(/\r$/, "");
  if (firstLine !== "---") return withoutBom;
  if (firstLineEnd === -1) return "";

  const lines = withoutBom.slice(firstLineEnd + 1).split(/\r?\n/);
  const closingLine = lines.indexOf("---");
  return closingLine === -1 ? "" : lines.slice(closingLine + 1).join("\n");
}

function cleanMarkdown(source: string): string {
  return source
    .replace(/<!--[^]*?-->/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[[^\]]+\]:\s*\S+.*$/gm, " ")
    .replace(/<https?:\/\/[^>]+>/gi, " ")
    .replace(/\bhttps?:\/\/[^\s)<>]+/giu, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);/giu, " ");
}

function titleFromLine(line: string): string {
  return line
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+)+/, "")
    .trim()
    .slice(0, 80);
}

function countTerms(source: string): Map<string, { count: number; firstIndex: number }> {
  const terms = new Map<string, { count: number; firstIndex: number }>();
  let firstIndex = 0;
  for (const match of source.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
    const term = match[0].toLowerCase();
    if (
      !/\p{L}/u.test(term) ||
      [...term].length > MAX_TERM_LENGTH ||
      STOPWORDS.has(term)
    ) {
      continue;
    }
    const existing = terms.get(term);
    if (existing === undefined) {
      terms.set(term, { count: 1, firstIndex });
    } else {
      existing.count++;
    }
    firstIndex++;
  }
  return terms;
}

function sortedTerms(terms: Map<string, { count: number; firstIndex: number }>): string[] {
  return [...terms.entries()]
    .toSorted(([leftTerm, left], [rightTerm, right]) =>
      right.count - left.count || left.firstIndex - right.firstIndex || compareText(leftTerm, rightTerm)
    )
    .map(([term]) => term);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
