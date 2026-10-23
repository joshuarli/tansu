type SourceLine = {
  text: string;
  start: number;
  contentEnd: number;
  end: number;
  newline: string;
};

type TagField = {
  line: SourceLine;
  colon: number;
  rest: string;
  kind: "block" | "inline" | "scalar";
  values: readonly string[];
  blockInsert: number;
};

type FrontmatterParse =
  | { kind: "absent" }
  | { kind: "invalid" }
  | {
    kind: "closed";
    lines: readonly SourceLine[];
    closingLine: SourceLine;
    tags: readonly string[];
    tagField: TagField | null;
  };

type TagEditPlan =
  | { kind: "applied"; source: string }
  | { kind: "unchanged" }
  | { kind: "unavailable"; message: string };

function* sourceLines(source: string): Generator<SourceLine> {
  let start = 0;
  const lineEnding = /\r\n?|\n/g;
  while (start <= source.length) {
    lineEnding.lastIndex = start;
    const ending = lineEnding.exec(source);
    const newlineAt = ending?.index ?? -1;
    const newlineLength = ending?.[0].length ?? 0;
    const contentEnd = newlineAt === -1 ? source.length : newlineAt;
    const end = newlineAt === -1 ? source.length : newlineAt + newlineLength;
    yield {
      text: source.slice(start, contentEnd),
      start,
      contentEnd,
      end,
      newline: newlineAt === -1 ? "" : source.slice(newlineAt, end),
    };
    if (newlineAt === -1) break;
    start = end;
  }
}

function trimFrontmatterQuotes(value: string): string {
  return value.replace(/^"+|"+$/g, "").replace(/^'+|'+$/g, "");
}

function trimFrontmatterBrackets(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && (value[start] === "[" || value[start] === "]")) start++;
  while (end > start && (value[end - 1] === "[" || value[end - 1] === "]")) end--;
  return value.slice(start, end);
}

function parseFrontmatter(source: string): FrontmatterParse {
  const openingStart = source.startsWith("\uFEFF") ? 1 : 0;
  if (source.slice(openingStart, openingStart + 3) !== "---") return { kind: "absent" };
  const firstLineEnding = source[openingStart + 3];
  if (firstLineEnding !== undefined && firstLineEnding !== "\n" && firstLineEnding !== "\r") {
    return { kind: "absent" };
  }

  const lineReader = sourceLines(source);
  const firstResult = lineReader.next();
  if (firstResult.done) return { kind: "absent" };
  const first = firstResult.value;
  const opening = first.text.startsWith("\uFEFF") ? first.text.slice(1) : first.text;
  if (opening !== "---") return { kind: "absent" };

  const lines = [first];
  let tags: string[] = [];
  let tagField: TagField | null = null;
  let inTagsList = false;
  for (const line of lineReader) {
    lines.push(line);
    if (line.text === "---") {
      return { kind: "closed", lines, closingLine: line, tags, tagField };
    }
    const trimmed = line.text.trim();
    if (trimmed === "") {
      if (inTagsList && tagField !== null) tagField.blockInsert = line.end;
      continue;
    }
    if (trimmed.startsWith("#")) {
      if (inTagsList && tagField !== null) tagField.blockInsert = line.end;
      continue;
    }
    if (line.text[0] !== " " && line.text[0] !== "\t") {
      if (inTagsList && tagField !== null) tagField.blockInsert = line.start;
      inTagsList = false;
      const colon = line.text.indexOf(":");
      if (colon === -1) return { kind: "invalid" };
      if (line.text.slice(0, colon).trim() !== "tags") continue;
      if (tagField !== null) return { kind: "invalid" };
      const rest = line.text.slice(colon + 1).trim();
      if (rest === "") {
        inTagsList = true;
        tagField = { line, colon, rest, kind: "block", values: [], blockInsert: line.end };
        continue;
      }
      if (rest.startsWith("[") && rest.endsWith("]")) {
        tags = trimFrontmatterBrackets(rest)
          .split(",")
          .map((tag) => trimFrontmatterQuotes(tag.trim()))
          .filter((tag) => tag !== "");
        tagField = { line, colon, rest, kind: "inline", values: tags, blockInsert: line.end };
      } else if (rest.startsWith("[") || rest.endsWith("]")) {
        return { kind: "invalid" };
      } else {
        tags = rest.split(",").map((tag) => tag.trim()).filter((tag) => tag !== "");
        tagField = { line, colon, rest, kind: "scalar", values: tags, blockInsert: line.end };
      }
      continue;
    }
    if (inTagsList && trimmed.startsWith("-")) {
      const tag = trimFrontmatterQuotes(trimmed.slice(1).trim());
      if (tag !== "") tags.push(tag);
      if (tagField !== null) {
        tagField.values = tags;
        tagField.blockInsert = line.end;
      }
      continue;
    }
    if (inTagsList && !trimmed.startsWith("#")) return { kind: "invalid" };
  }
  return { kind: "invalid" };
}

export function readNoteTags(source: string): readonly string[] {
  const parsed = parseFrontmatter(source);
  return parsed.kind === "closed" ? parsed.tags : [];
}

function tagUnavailable(message: string): TagEditPlan {
  return { kind: "unavailable", message };
}

function appliedTagAddition(source: string, existingTags: readonly string[], tag: string): TagEditPlan {
  const result = parseFrontmatter(source);
  const expectedTags = [...existingTags, tag];
  if (
    result.kind !== "closed" ||
    result.tags.length !== expectedTags.length ||
    result.tags.some((value, index) => value !== expectedTags[index])
  ) {
    return tagUnavailable("This edit would change an existing tag value.");
  }
  return { kind: "applied", source };
}

function quotedTag(tag: string): string | null {
  if (tag.startsWith("'") || tag.startsWith('"') || tag.endsWith("'") || tag.endsWith('"')) return null;
  if (!tag.includes("'")) return `'${tag}'`;
  if (!tag.includes('"') && !tag.includes("\\")) return `"${tag}"`;
  return null;
}

function inlineTag(tag: string): string | null {
  if (tag.includes(",") || tag.includes("[") || tag.includes("]")) return null;
  if (/^[\p{L}\p{N}_./ -]+$/u.test(tag) && tag === tag.trim()) return tag;
  return quotedTag(tag);
}

function blockTag(tag: string): string | null {
  if (/^[\p{L}\p{N}_./ -]+$/u.test(tag) && tag === tag.trim()) return tag;
  return quotedTag(tag);
}

function addToBlockField(source: string, field: TagField, tag: string, newline: string): TagEditPlan {
  const encoded = blockTag(tag);
  if (encoded === null) return tagUnavailable("This tag cannot be represented safely in frontmatter.");
  return {
    kind: "applied",
    source: `${source.slice(0, field.blockInsert)}  - ${encoded}${newline}${source.slice(field.blockInsert)}`,
  };
}

function rewriteTagFieldAsBlock(source: string, field: TagField, values: readonly string[], newline: string): TagEditPlan {
  const encoded = values.map(blockTag);
  if (encoded.some((tag) => tag === null)) {
    return tagUnavailable("An existing tag cannot be represented safely in frontmatter.");
  }
  const prefix = field.line.text.slice(0, field.colon + 1);
  const replacement = `${prefix}${newline}${encoded.map((tag) => `  - ${tag}`).join(newline)}`;
  return {
    kind: "applied",
    source: `${source.slice(0, field.line.start)}${replacement}${source.slice(field.line.contentEnd)}`,
  };
}

function newTagField(tag: string, newline: string): string | null {
  const inline = inlineTag(tag);
  if (inline !== null) return `tags: [${inline}]${newline}`;
  const block = blockTag(tag);
  return block === null ? null : `tags:${newline}  - ${block}${newline}`;
}

function hasLineBreakOrControl(tag: string): boolean {
  for (const character of tag) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined || codePoint === 0x0a || codePoint === 0x0d || codePoint === 0x85 ||
      codePoint === 0x2028 || codePoint === 0x2029 || codePoint <= 0x08 || codePoint === 0x0b ||
      codePoint === 0x0c || (codePoint >= 0x0e && codePoint <= 0x1f) || codePoint === 0x7f
    ) return true;
  }
  return false;
}

export function planTagAddition(source: string, tag: string): TagEditPlan {
  if (tag.trim() === "") return tagUnavailable("Tag must not be empty.");
  if (hasLineBreakOrControl(tag)) {
    return tagUnavailable("Tag must not contain line breaks or control characters.");
  }

  const parsed = parseFrontmatter(source);
  if (parsed.kind === "invalid") {
    return tagUnavailable("Tags cannot be changed because the frontmatter is malformed or unsupported.");
  }
  if (parsed.kind === "absent") {
    const newline = "\n";
    const field = newTagField(tag, newline);
    if (field === null) return tagUnavailable("This tag cannot be represented safely in frontmatter.");
    const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
    return appliedTagAddition(
      `${bom}---${newline}${field}---${newline}${source.slice(bom.length)}`,
      [],
      tag,
    );
  }
  if (parsed.tags.includes(tag)) return { kind: "unchanged" };

  const newline = parsed.lines[0]?.newline || parsed.closingLine.newline || "\n";
  const field = parsed.tagField;
  if (field === null) {
    const newField = newTagField(tag, newline);
    if (newField === null) return tagUnavailable("This tag cannot be represented safely in frontmatter.");
    return appliedTagAddition(
      `${source.slice(0, parsed.closingLine.start)}${newField}${source.slice(parsed.closingLine.start)}`,
      parsed.tags,
      tag,
    );
  }
  if (field.kind === "block") {
    const plan = addToBlockField(source, field, tag, newline);
    return plan.kind === "applied" ? appliedTagAddition(plan.source, parsed.tags, tag) : plan;
  }

  const encoded = inlineTag(tag);
  if (encoded === null) {
    const plan = rewriteTagFieldAsBlock(source, field, [...field.values, tag], newline);
    return plan.kind === "applied" ? appliedTagAddition(plan.source, parsed.tags, tag) : plan;
  }

  const rawAfterColon = field.line.text.slice(field.colon + 1);
  const leading = rawAfterColon.slice(0, rawAfterColon.length - rawAfterColon.trimStart().length);
  const trailing = rawAfterColon.slice(rawAfterColon.trimEnd().length);
  let rest: string;
  if (field.kind === "inline") {
    const inner = field.rest.slice(1, -1).trim();
    rest = `[${inner === "" ? encoded : `${inner}, ${encoded}`}]`;
  } else {
    const scalarTagSafe = /^[\p{L}\p{N}_./ -]+$/u.test(tag) && tag === tag.trim();
    if (!scalarTagSafe) {
      const plan = rewriteTagFieldAsBlock(source, field, [...field.values, tag], newline);
      return plan.kind === "applied" ? appliedTagAddition(plan.source, parsed.tags, tag) : plan;
    }
    rest = `${field.rest}, ${tag}`;
  }
  const replacement = `${field.line.text.slice(0, field.colon + 1)}${leading}${rest}${trailing}`;
  return appliedTagAddition(
    `${source.slice(0, field.line.start)}${replacement}${source.slice(field.line.contentEnd)}`,
    parsed.tags,
    tag,
  );
}
