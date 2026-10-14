export type SourceEdit = {
  from: number;
  to: number;
  insert: string;
};

export function tagsSourceEdit(source: string, values: readonly string[]): SourceEdit | null {
  const tags = [...new Set(values.map(normalizeTag).filter((tag): tag is string => tag !== null))];
  const frontmatter = findFrontmatter(source);
  if (frontmatter === null) {
    if (source.startsWith("---") || source.startsWith("\uFEFF---")) return null;
    if (tags.length === 0) return null;
    const prefix = ["---", "tags:", ...tags.map((tag) => `  - ${yamlScalar(tag)}`), "---", "", ""].join("\n");
    const bom = source.startsWith("\uFEFF") ? 1 : 0;
    return { from: bom, to: bom, insert: prefix };
  }

  const lines = frontmatter.lines;
  const tagIndex = lines.findIndex((line) => line.text.trim() === "tags:");
  let listEnd = tagIndex;
  if (tagIndex !== -1) {
    listEnd = tagIndex;
    while (listEnd + 1 < lines.length && /^\s+-/.test(lines[listEnd + 1]!.text)) listEnd++;
    if (lines.some((line, index) => {
      if (index === tagIndex || (index > tagIndex && index <= listEnd)) return false;
      return line.text.trim() !== "";
    })) return null;
  } else if (lines.some((line) => line.text.trim() !== "")) {
    return null;
  }

  if (tagIndex === -1 && tags.length === 0) return null;
  if (tagIndex !== -1 && tags.length === 0) {
    const bom = source.startsWith("\uFEFF") ? 1 : 0;
    return { from: bom, to: frontmatter.close.to, insert: "" };
  }

  const replacement = ["tags:", ...tags.map((tag) => `  - ${yamlScalar(tag)}`)].join("\n");
  if (tagIndex === -1) {
    return { from: frontmatter.close.from, to: frontmatter.close.from, insert: `${replacement}\n` };
  }

  const from = lines[tagIndex]!.from;
  const to = lines[listEnd]!.to;
  const current = source.slice(from, to);
  return current === replacement ? null : { from, to, insert: replacement };
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

function findFrontmatter(source: string): {
  lines: { from: number; to: number; text: string }[];
  close: { from: number; to: number };
} | null {
  const bom = source.startsWith("\uFEFF") ? 1 : 0;
  const lineBreak = source.indexOf("\n", bom);
  const openTo = lineBreak === -1 ? source.length : lineBreak;
  if (source.slice(bom, openTo).replace(/\r$/, "") !== "---") return null;

  const lines: { from: number; to: number; text: string }[] = [];
  let position = lineBreak === -1 ? source.length : lineBreak + 1;
  while (position <= source.length) {
    const nextBreak = source.indexOf("\n", position);
    const to = nextBreak === -1 ? source.length : nextBreak;
    const text = source.slice(position, to).replace(/\r$/, "");
    if (text === "---") return { lines, close: { from: position, to } };
    lines.push({ from: position, to, text });
    if (nextBreak === -1) break;
    position = nextBreak + 1;
  }
  return null;
}
