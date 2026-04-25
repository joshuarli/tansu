import { normalizeTagInput } from "./tag-autocomplete.ts";

export type Frontmatter = {
  hasFrontmatter: boolean;
  tags: string[];
  body: string;
};

export function splitFrontmatter(src: string): Frontmatter {
  const firstBreak = src.indexOf("\n");
  const firstLine = (firstBreak === -1 ? src : src.slice(0, firstBreak)).replace(/\r$/, "");
  if (firstLine.trim() !== "---") {
    return { hasFrontmatter: false, tags: [], body: src };
  }

  let offset = firstBreak === -1 ? src.length : firstBreak + 1;
  let tags: string[] = [];

  while (offset < src.length) {
    const { line, nextOffset } = readLine(src, offset);
    if (line.trim() === "---") {
      let bodyStart = nextOffset;
      if (bodyStart < src.length) {
        const { line: maybeBlank, nextOffset: afterBlank } = readLine(src, bodyStart);
        if (maybeBlank === "") {
          bodyStart = afterBlank;
        }
      }
      return { hasFrontmatter: true, tags, body: src.slice(bodyStart) };
    }

    const parsedTags = parseTagsLine(line);
    if (parsedTags !== null) {
      tags = parsedTags;
    }
    offset = nextOffset;
  }

  return { hasFrontmatter: false, tags: [], body: src };
}

export function buildFrontmatter(tags: readonly string[]): string {
  if (tags.length === 0) {
    return "";
  }
  return `---\ntags: [${tags.join(", ")}]\n---\n\n`;
}

export function withFrontmatter(body: string, tags: readonly string[]): string {
  return tags.length === 0 ? body : `${buildFrontmatter(tags)}${body}`;
}

function readLine(src: string, offset: number): { line: string; nextOffset: number } {
  const next = src.indexOf("\n", offset);
  if (next === -1) {
    return { line: src.slice(offset).replace(/\r$/, ""), nextOffset: src.length };
  }
  return { line: src.slice(offset, next).replace(/\r$/, ""), nextOffset: next + 1 };
}

function parseTagsLine(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("tags:")) {
    return null;
  }
  const rest = trimmed.slice("tags:".length).trim();
  if (rest === "") {
    return [];
  }
  const inner = rest.startsWith("[") && rest.endsWith("]") ? rest.slice(1, -1) : rest;
  return inner
    .split(",")
    .map((tag) => normalizeTagInput(tag))
    .filter((tag) => tag.length > 0);
}
