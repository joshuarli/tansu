/// Markdown → HTML renderer. Supports the subset used in note-taking:
/// headings, paragraphs, lists (ul/ol/task), blockquotes, callouts,
/// fenced code blocks, tables, HR, and inline formatting.

import { highlightCode } from "./highlight.js";
import { escapeHtml } from "./util.js";

const calloutIcons: Record<string, string> = {
  note: "\u{1F4DD}",
  info: "\u2139\uFE0F",
  tip: "\u{1F4A1}",
  hint: "\u{1F4A1}",
  important: "\u2757",
  warning: "\u26A0\uFE0F",
  caution: "\u26A0\uFE0F",
  danger: "\u{1F6A8}",
  bug: "\u{1F41B}",
  example: "\u{1F4CB}",
  quote: "\u{1F4AC}",
  abstract: "\u{1F4C4}",
  summary: "\u{1F4C4}",
  todo: "\u2705",
  question: "\u2753",
  faq: "\u2753",
  success: "\u2705",
  check: "\u2705",
  done: "\u2705",
  failure: "\u274C",
  fail: "\u274C",
  missing: "\u274C",
};

const CURSOR_SENTINEL = "\uFDD0";

export function renderMarkdown(src: string): string {
  if (src === "") return "";
  const lines = src.split("\n");
  const blocks = parseBlocks(lines);
  return blocks.map(renderBlock).join("\n");
}

export function renderMarkdownWithCursor(src: string, offset: number): string {
  const clamped = Math.max(0, Math.min(offset, src.length));
  return renderMarkdown(src.slice(0, clamped) + CURSOR_SENTINEL + src.slice(clamped));
}

type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "blank" }
  | { type: "code"; lang: string; text: string }
  | { type: "hr" }
  | { type: "list"; ordered: boolean; items: ListItem[] }
  | { type: "blockquote"; lines: string[] }
  | { type: "table"; header: string[]; rows: string[][] };

interface ListItem {
  text: string;
  checked: boolean | null; // null = not a task item
  nested?: ListNode[];
}

interface ListNode {
  ordered: boolean;
  items: ListItem[];
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Blank line
    if (line.trim() === "") {
      blocks.push({ type: "blank" });
      i++;
      continue;
    }

    // Fenced code block
    const fenceMatch = line.match(/^(`{3,}|~{3,})(.*)/);
    if (fenceMatch) {
      const fence = fenceMatch[1]!;
      const lang = fenceMatch[2]!.trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith(fence.charAt(0).repeat(fence.length))) {
        codeLines.push(lines[i]!);
        i++;
      }
      i++; // skip closing fence
      blocks.push({ type: "code", lang, text: codeLines.join("\n") });
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch) {
      blocks.push({ type: "heading", level: headingMatch[1]!.length, text: headingMatch[2]! });
      i++;
      continue;
    }

    // HR
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // Table: line starts with | and next line is a separator
    if (
      line.trimStart().startsWith("|") &&
      i + 1 < lines.length &&
      /^\|?[\s:]*-+[\s:]*(\|[\s:]*-+[\s:]*)*\|?\s*$/.test(lines[i + 1]!)
    ) {
      const headerCells = parseTableRow(line);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trimStart().startsWith("|")) {
        rows.push(parseTableRow(lines[i]!));
        i++;
      }
      blocks.push({ type: "table", header: headerCells, rows });
      continue;
    }

    // List (unordered, ordered, or task)
    const listStart = parseListLine(line);
    if (listStart) {
      const parsed = parseList(lines, i, listStart.indent);
      blocks.push({ type: "list", ordered: parsed.list.ordered, items: parsed.list.items });
      i = parsed.nextIndex;
      continue;
    }

    // Blockquote
    if (line.startsWith(">")) {
      const bqLines: string[] = [];
      while (
        i < lines.length &&
        (lines[i]!.startsWith(">") ||
          (lines[i]!.trim() !== "" && bqLines.length > 0 && !lines[i]!.startsWith("#")))
      ) {
        if (!lines[i]!.startsWith(">")) break;
        // Strip the leading > and optional space
        bqLines.push(lines[i]!.replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "blockquote", lines: bqLines });
      continue;
    }

    // Paragraph: collect consecutive non-blank, non-special lines
    const paraLines: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.trim() === "") break;
      if (/^(#{1,6}\s|```|~~~|>|(-{3,}|\*{3,}|_{3,})\s*$)/.test(l)) break;
      if (parseListLine(l)) break;
      if (
        l.trimStart().startsWith("|") &&
        i + 1 < lines.length &&
        /^\|?[\s:]*-+/.test(lines[i + 1] ?? "")
      )
        break;
      paraLines.push(l);
      i++;
    }
    for (const line of paraLines) {
      blocks.push({ type: "paragraph", text: line });
    }
  }

  return blocks;
}

function renderBlock(block: Block): string {
  switch (block.type) {
    case "heading":
      return `<h${block.level}>${inline(block.text)}</h${block.level}>`;
    case "paragraph":
      return `<p>${inline(block.text)}</p>`;
    case "blank":
      return '<p data-md-blank="true"><br></p>';
    case "hr":
      return "<hr>";
    case "code": {
      const highlighted = block.lang
        ? highlightCode(block.text, block.lang)
        : escapeHtml(block.text);
      const cls = block.lang ? ` class="language-${escapeHtml(block.lang)}"` : "";
      return `<pre><code${cls}>${highlighted}</code></pre>`;
    }
    case "list": {
      return renderListNode({ ordered: block.ordered, items: block.items });
    }
    case "blockquote":
      return renderBlockquote(block.lines);
    case "table": {
      const head = block.header.map((c) => `<th>${inline(c)}</th>`).join("");
      const body = block.rows
        .map((row) => "<tr>" + row.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>")
        .join("\n");
      return `<table>\n<tr>${head}</tr>\n${body}\n</table>`;
    }
  }
}

function renderBlockquote(bqLines: string[]): string {
  // Check for callout: first line matches [!type]
  const first = bqLines[0] ?? "";
  const calloutMatch = first.match(/^\[!(\w+)\]\s*(.*)/);
  if (calloutMatch) {
    const type = calloutMatch[1]!.toLowerCase();
    const titleText = calloutMatch[2]!.trim() || type.charAt(0).toUpperCase() + type.slice(1);
    const icon = calloutIcons[type] ?? "";
    const bodyLines = bqLines.slice(1);
    const bodyBlocks = parseBlocks(bodyLines);
    const bodyHtml = bodyBlocks.map(renderBlock).join("\n");
    return (
      `<div class="callout callout-${escapeHtml(type)}" data-callout="${escapeHtml(type)}">` +
      `<div class="callout-title">${icon} ${escapeHtml(titleText)}</div>` +
      (bodyHtml ? `<div class="callout-body">${bodyHtml}</div>` : "") +
      `</div>`
    );
  }
  // Regular blockquote: recursively parse inner content
  const innerBlocks = parseBlocks(bqLines);
  return `<blockquote>${innerBlocks.map(renderBlock).join("\n")}</blockquote>`;
}

function renderListNode(list: ListNode): string {
  const tag = list.ordered ? "ol" : "ul";
  const items = list.items
    .map((item) => {
      const textHtml =
        item.checked !== null
          ? `<input type="checkbox"${item.checked ? " checked disabled" : " disabled"}> ${inline(item.text)}`
          : inline(item.text);
      const nestedHtml = item.nested?.map(renderListNode).join("\n") ?? "";
      const contentHtml = textHtml || nestedHtml ? textHtml : "<br>";
      return nestedHtml ? `<li>${contentHtml}\n${nestedHtml}</li>` : `<li>${contentHtml}</li>`;
    })
    .join("\n");
  return `<${tag}>\n${items}\n</${tag}>`;
}

function parseList(
  lines: readonly string[],
  startIndex: number,
  baseIndent: number,
): { list: ListNode; nextIndex: number } {
  const first = parseListLine(lines[startIndex]!);
  if (!first) {
    return { list: { ordered: false, items: [] }, nextIndex: startIndex };
  }

  const items: ListItem[] = [];
  let i = startIndex;

  while (i < lines.length) {
    const parsed = parseListLine(lines[i]!);
    if (!parsed) break;

    if (parsed.indent < baseIndent) break;

    if (parsed.indent > baseIndent) {
      const lastItem = items[items.length - 1];
      if (!lastItem) break;
      const nested = parseList(lines, i, parsed.indent);
      lastItem.nested ??= [];
      lastItem.nested.push(nested.list);
      i = nested.nextIndex;
      continue;
    }

    if (parsed.ordered !== first.ordered) break;

    items.push({ text: parsed.text, checked: parsed.checked });
    i++;
  }

  return { list: { ordered: first.ordered, items }, nextIndex: i };
}

function parseListLine(
  line: string,
): { indent: number; ordered: boolean; text: string; checked: boolean | null } | null {
  const match = line.match(/^([ \t]*)([-*+]|\d+\.)(?:\s(.*))?$/);
  if (!match) return null;

  let text = match[3] ?? "";
  let checked: boolean | null = null;
  const taskMatch = text.match(/^\[([ xX])\]\s(.*)/);
  if (taskMatch) {
    checked = taskMatch[1] !== " ";
    text = taskMatch[2]!;
  }

  return {
    indent: countIndent(match[1]!),
    ordered: /\d+\./.test(match[2]!),
    text,
    checked,
  };
}

function countIndent(indent: string): number {
  let width = 0;
  for (const ch of indent) {
    width += ch === "\t" ? 2 : 1;
  }
  return width;
}

function parseTableRow(line: string): string[] {
  // Strip leading/trailing pipe and split
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

/// Inline rendering: handles bold, italic, strikethrough, code, highlight,
/// wiki-links, wiki-images, links, images, and escaped characters.
function inline(text: string): string {
  let out = "";
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i]!;

    // Escaped character
    if (ch === "\\" && i + 1 < len) {
      const next = text[i + 1]!;
      if ("\\`*_{}[]()#+-.!~=|".includes(next)) {
        out += escapeHtml(next);
        i += 2;
        continue;
      }
    }

    if (ch === CURSOR_SENTINEL) {
      out += '<span data-md-cursor="true"></span>';
      i++;
      continue;
    }

    // Inline code (backtick) — no nesting
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        out += `<code>${escapeHtml(text.slice(i + 1, end))}</code>`;
        i = end + 1;
        continue;
      }
    }

    // Wiki-image: ![[target]] or ![[target|width]]
    if (ch === "!" && text[i + 1] === "[" && text[i + 2] === "[") {
      const end = text.indexOf("]]", i + 3);
      if (end !== -1) {
        const inner = text.slice(i + 3, end);
        const pipe = inner.indexOf("|");
        const imageName = pipe !== -1 ? inner.slice(0, pipe).trim() : inner.trim();
        const widthStr = pipe !== -1 ? inner.slice(pipe + 1).trim() : "";
        const width = /^\d+$/.test(widthStr) ? widthStr : "";
        const src = `/z-images/${encodeURIComponent(imageName)}`;
        const widthAttr = width ? ` width="${width}"` : "";
        out += `<img src="${src}" alt="${escapeHtml(imageName)}" data-wiki-image="${escapeHtml(imageName)}"${widthAttr} loading="lazy">`;
        i = end + 2;
        continue;
      }
    }

    // Wiki-link: [[target]] or [[target|display]]
    if (ch === "[" && text[i + 1] === "[") {
      const end = text.indexOf("]]", i + 2);
      if (end !== -1) {
        const inner = text.slice(i + 2, end);
        const pipe = inner.indexOf("|");
        const target = pipe !== -1 ? inner.slice(0, pipe).trim() : inner.trim();
        const display = pipe !== -1 ? inner.slice(pipe + 1).trim() : inner.trim();
        out += `<a class="wiki-link" data-target="${escapeHtml(target)}">${escapeHtml(display)}</a>`;
        i = end + 2;
        continue;
      }
    }

    // Image: ![alt](src)
    if (ch === "!" && text[i + 1] === "[") {
      const m = text.slice(i).match(/^!\[([^\]]*)\]\(([^)]+)\)/);
      if (m) {
        out += `<img src="${escapeHtml(m[2]!)}" alt="${escapeHtml(m[1]!)}">`;
        i += m[0].length;
        continue;
      }
    }

    // Link: [text](url)
    if (ch === "[") {
      const m = text.slice(i).match(/^\[([^\]]*)\]\(([^)]+)\)/);
      if (m) {
        out += `<a href="${escapeHtml(m[2]!)}">${inline(m[1]!)}</a>`;
        i += m[0].length;
        continue;
      }
    }

    // Highlight: ==text==
    if (ch === "=" && text[i + 1] === "=") {
      const end = text.indexOf("==", i + 2);
      if (end !== -1) {
        out += `<mark>${inline(text.slice(i + 2, end))}</mark>`;
        i = end + 2;
        continue;
      }
    }

    // Strikethrough: ~~text~~
    if (ch === "~" && text[i + 1] === "~") {
      const end = text.indexOf("~~", i + 2);
      if (end !== -1) {
        out += `<del>${inline(text.slice(i + 2, end))}</del>`;
        i = end + 2;
        continue;
      }
    }

    // Bold: **text**
    if (ch === "*" && text[i + 1] === "*") {
      const end = text.indexOf("**", i + 2);
      if (end !== -1) {
        out += `<strong>${inline(text.slice(i + 2, end))}</strong>`;
        i = end + 2;
        continue;
      }
    }

    // Italic: *text*
    if (ch === "*") {
      const end = findClosing(text, "*", i + 1);
      if (end !== -1) {
        out += `<em>${inline(text.slice(i + 1, end))}</em>`;
        i = end + 1;
        continue;
      }
    }

    // Bare URL: http:// or https://
    if (ch === "h" && (text.slice(i, i + 7) === "http://" || text.slice(i, i + 8) === "https://")) {
      let end = i;
      while (end < len && !" \n\t<>\"'`".includes(text[end]!)) end++;
      while (end > i && ".,)!?;:".includes(text[end - 1]!)) end--;
      const url = text.slice(i, end);
      out += `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
      i = end;
      continue;
    }

    // Line break
    if (ch === "\n") {
      out += "<br>";
      i++;
      continue;
    }

    if (ch === "\t") {
      out += '<span class="md-tab">\t</span>';
      i++;
      continue;
    }

    // HTML special chars
    if (ch === "&") {
      out += "&amp;";
      i++;
      continue;
    }
    if (ch === "<") {
      out += "&lt;";
      i++;
      continue;
    }
    if (ch === ">") {
      out += "&gt;";
      i++;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/// Find closing delimiter, skipping escaped characters.
function findClosing(text: string, delim: string, start: number): number {
  for (let i = start; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === delim) return i;
  }
  return -1;
}
