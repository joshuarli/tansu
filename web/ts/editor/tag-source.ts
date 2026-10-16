export type SourceEdit = {
  from: number;
  to: number;
  insert: string;
};

type SourceLine = {
  from: number;
  to: number;
  end: number;
  text: string;
};

type Frontmatter = {
  lines: SourceLine[];
  close: SourceLine;
  lineBreak: string;
};

type TagField = {
  first: SourceLine;
  last: SourceLine;
};

type TagSource = {
  frontmatter: Frontmatter | null;
  tagField: TagField | null;
  hasOtherContent: boolean;
  lineBreak: string;
  bom: number;
};

export function canMutateTags(source: string): boolean {
  return inspectTagSource(source) !== null;
}

export function tagsSourceEdit(source: string, values: readonly string[]): SourceEdit | null {
  const tagSource = inspectTagSource(source);
  if (tagSource === null) return null;

  const tags = [...new Set(values.map(normalizeTag).filter((tag): tag is string => tag !== null))];
  const { frontmatter, tagField, lineBreak, bom } = tagSource;
  if (frontmatter === null) {
    if (tags.length === 0) return null;
    const prefix = ["---", "tags:", ...tags.map((tag) => `  - ${yamlScalar(tag)}`), "---", "", ""].join(lineBreak);
    return { from: bom, to: bom, insert: prefix };
  }

  if (tagField === null) {
    if (tags.length === 0) return null;
    const replacement = ["tags:", ...tags.map((tag) => `  - ${yamlScalar(tag)}`), ""].join(lineBreak);
    return { from: frontmatter.close.from, to: frontmatter.close.from, insert: replacement };
  }

  if (tags.length === 0) {
    if (!tagSource.hasOtherContent) {
      return { from: bom, to: frontmatter.close.to, insert: "" };
    }
    return { from: tagField.first.from, to: tagField.last.end, insert: "" };
  }

  const replacement = ["tags:", ...tags.map((tag) => `  - ${yamlScalar(tag)}`), ""].join(lineBreak);
  const current = source.slice(tagField.first.from, tagField.last.end);
  return current === replacement
    ? null
    : { from: tagField.first.from, to: tagField.last.end, insert: replacement };
}

function inspectTagSource(source: string): TagSource | null {
  const bom = source.startsWith("\uFEFF") ? 1 : 0;
  const lineBreak = source.includes("\r\n") ? "\r\n" : "\n";
  const frontmatter = findFrontmatter(source);
  if (frontmatter === null) {
    if (source.startsWith("---") || source.startsWith("\uFEFF---")) return null;
    return { frontmatter: null, tagField: null, hasOtherContent: false, lineBreak, bom };
  }

  let tagField: TagField | null = null;
  let activeTagBlock = false;
  let activeInlineTag = false;
  let currentRootKey = false;
  let hasOtherContent = false;

  for (const line of frontmatter.lines) {
    const trimmed = line.text.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("#")) {
      hasOtherContent = true;
      if (activeTagBlock || activeInlineTag) return null;
      continue;
    }

    if (!/^\s/.test(line.text)) {
      activeTagBlock = false;
      activeInlineTag = false;
      if (/^(?:"tags"|'tags')[ \t]*:/u.test(line.text)) return null;
      const property = /^([A-Za-z0-9_-]+)[ \t]*:(?:[ \t]*(.*))?$/u.exec(line.text);
      if (property === null) return null;
      currentRootKey = true;
      if (property[1] !== "tags") {
        hasOtherContent = true;
        continue;
      }
      if (tagField !== null) return null;

      const value = property[2] ?? "";
      if (value === "") {
        tagField = { first: line, last: line };
        activeTagBlock = true;
        continue;
      }
      if (!supportedInlineTagValue(value)) return null;
      tagField = { first: line, last: line };
      activeInlineTag = true;
      continue;
    }

    if (!currentRootKey) return null;
    if (activeInlineTag) return null;
    if (activeTagBlock) {
      const item = /^ +-[ \t]*(.*)$/.exec(line.text);
      if (item === null || !supportedTagScalar(item[1]!)) return null;
      tagField!.last = line;
    } else {
      hasOtherContent = true;
    }
  }

  return { frontmatter, tagField, hasOtherContent, lineBreak: frontmatter.lineBreak, bom };
}

function supportedInlineTagValue(value: string): boolean {
  if (value.includes("#") || value.includes("{") || value.includes("}") || value.includes("|") || value.includes(">")) {
    return false;
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (inner === "") return true;
    return inner.split(",").every(supportedTagScalar);
  }
  if (value.includes("[") || value.includes("]")) return false;
  return value.split(",").every(supportedTagScalar);
}

function supportedTagScalar(value: string): boolean {
  const scalar = value.trim();
  if (scalar === "") return true;
  if (scalar.startsWith("'") || scalar.startsWith('"')) {
    const quote = scalar[0]!;
    return scalar.length >= 2 && scalar.endsWith(quote) && !scalar.slice(1, -1).includes(quote);
  }
  return !/(?:^|\s)#|:\s|[\[\]{}|>]|^[-?:,](?:\s|$)|^[!&*%@`]/u.test(scalar);
}

function normalizeTag(value: string): string | null {
  const tag = value.trim().replace(/^#/, "");
  if (tag === "" || /[\r\n]/.test(tag)) return null;
  return tag;
}

function yamlScalar(value: string): string {
  const simple = /^[\p{L}\p{N}_./-]+$/u.test(value);
  const typed = /^(?:null|~|true|false|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)$/i.test(value);
  return simple && !typed ? value : JSON.stringify(value);
}

function findFrontmatter(source: string): Frontmatter | null {
  const bom = source.startsWith("\uFEFF") ? 1 : 0;
  const firstBreak = source.indexOf("\n", bom);
  if (firstBreak === -1) return null;
  const firstLine = source.slice(bom, firstBreak).replace(/\r$/u, "");
  if (firstLine !== "---") return null;

  const lineBreak = source.includes("\r\n") ? "\r\n" : "\n";
  const lines: SourceLine[] = [];
  let position = firstBreak + 1;
  while (position <= source.length) {
    const nextBreak = source.indexOf("\n", position);
    const rawTo = nextBreak === -1 ? source.length : nextBreak;
    const to = rawTo > position && source[rawTo - 1] === "\r" ? rawTo - 1 : rawTo;
    const text = source.slice(position, to);
    const line: SourceLine = {
      from: position,
      to,
      end: nextBreak === -1 ? source.length : nextBreak + 1,
      text,
    };
    if (text === "---") {
      return { lines, close: line, lineBreak };
    }
    lines.push(line);
    if (nextBreak === -1) break;
    position = nextBreak + 1;
  }
  return null;
}
