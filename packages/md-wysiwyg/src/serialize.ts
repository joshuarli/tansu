/// DOM → Markdown serialization for the WYSIWYG editor.

const BLANK_LINE_SENTINEL = "\u0000";
const CURSOR_SENTINEL = "\uFDD0";
type BlockKind =
  | "blank"
  | "paragraph"
  | "heading"
  | "list"
  | "blockquote"
  | "code"
  | "table"
  | "hr"
  | "other";

interface SerializedBlock {
  md: string;
  kind: BlockKind;
}

/// Compute the character offset of the cursor (described by `range`) within the
/// markdown string that `domToMarkdown(contentEl)` would produce.
///
/// Uses a sentinel-insert approach: temporarily inserts a [data-md-cursor] span
/// at the cursor position, serializes the full document to find where the sentinel
/// lands, then removes the span and restores the selection. This correctly handles
/// cursors inside inline elements (e.g. inside <strong>) where a naive
/// clone-up-to-cursor approach would overcount due to artificially closed markers.
export function getCursorMarkdownOffset(contentEl: HTMLElement, range: Range): number {
  const anchor = range.startContainer;
  const anchorOffset = range.startOffset;

  const marker = document.createElement("span");
  marker.dataset["mdCursor"] = "true";
  range.insertNode(marker);

  const md = domToMarkdown(contentEl);
  const offset = md.indexOf(CURSOR_SENTINEL);

  const parent = marker.parentNode;
  marker.remove();
  // Re-merge any text nodes that insertNode split
  parent?.normalize();

  // Restore the selection. After insertNode, anchor (a text node) may have been
  // split; after normalize it is extended back to its full content, so the saved
  // offset is still valid.
  const sel = window.getSelection();
  if (sel) {
    try {
      const r = document.createRange();
      const safeOffset =
        anchor.nodeType === Node.TEXT_NODE
          ? Math.min(anchorOffset, (anchor as Text).length)
          : Math.min(anchorOffset, anchor.childNodes.length);
      r.setStart(anchor, safeOffset);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    } catch {
      // If the anchor was removed from the DOM, leave selection as-is
    }
  }

  return offset !== -1 ? offset : domToMarkdown(contentEl).length;
}

export function domToMarkdown(root: HTMLElement): string {
  const blocks: SerializedBlock[] = [];
  for (const child of root.children) {
    const block = blockToMd(child as HTMLElement);
    if (block !== null && block.md !== "") {
      blocks.push(block);
    }
  }
  return joinBlocks(blocks);
}

function blockToMd(el: HTMLElement): SerializedBlock | null {
  const tag = el.tagName;

  if (tag === "H1") {
    return { md: `# ${inlineToMd(el)}`, kind: "heading" };
  }
  if (tag === "H2") {
    return { md: `## ${inlineToMd(el)}`, kind: "heading" };
  }
  if (tag === "H3") {
    return { md: `### ${inlineToMd(el)}`, kind: "heading" };
  }
  if (tag === "H4") {
    return { md: `#### ${inlineToMd(el)}`, kind: "heading" };
  }
  if (tag === "H5") {
    return { md: `##### ${inlineToMd(el)}`, kind: "heading" };
  }
  if (tag === "H6") {
    return { md: `###### ${inlineToMd(el)}`, kind: "heading" };
  }
  if (el.classList.contains("callout")) {
    const type = el.dataset["callout"] ?? "note";
    const titleEl = el.querySelector(".callout-title");
    const bodyEl = el.querySelector(".callout-body");
    const icon = titleEl?.textContent?.match(/^.\s*/)?.[0] ?? "";
    const titleText = (titleEl?.textContent ?? "").replace(icon, "").trim();
    const defaultTitle = type.charAt(0).toUpperCase() + type.slice(1);
    const titleSuffix = titleText && titleText !== defaultTitle ? ` ${titleText}` : "";
    let lines = `> [!${type}]${titleSuffix}`;
    if (bodyEl) {
      const bodyBlocks: SerializedBlock[] = [];
      for (const child of bodyEl.children) {
        const inner = blockToMd(child as HTMLElement);
        if (inner !== null && inner.md !== "") {
          bodyBlocks.push(inner);
        }
      }
      const bodyMd = joinBlocks(bodyBlocks);
      if (bodyMd !== "") {
        lines += `\n${quoteMarkdown(bodyMd)}`;
      }
    }
    return { md: lines, kind: "blockquote" };
  }

  if (tag === "P" || tag === "DIV") {
    if (isBlankLineBlock(el)) {
      return { md: BLANK_LINE_SENTINEL, kind: "blank" };
    }
    return {
      md: hasDirectBlockChildren(el) ? containerToMd(el) : inlineToMd(el),
      kind: "paragraph",
    };
  }
  if (tag === "HR") {
    return { md: "---", kind: "hr" };
  }

  if (tag === "UL") {
    return { md: listToMd(el, 0, false), kind: "list" };
  }

  if (tag === "OL") {
    return { md: listToMd(el, 0, true), kind: "list" };
  }

  if (tag === "BLOCKQUOTE") {
    const innerBlocks: SerializedBlock[] = [];
    for (const child of el.children) {
      const md = blockToMd(child as HTMLElement);
      if (md !== null && md.md !== "") {
        innerBlocks.push(md);
      }
    }
    return { md: quoteMarkdown(joinBlocks(innerBlocks)), kind: "blockquote" };
  }

  if (tag === "PRE") {
    const code = el.querySelector("code");
    const text = code?.textContent ?? el.textContent ?? "";
    const lang = code?.className?.match(/language-(\S+)/)?.[1] ?? "";
    return { md: `\`\`\`${lang}\n${text.replace(/\n$/, "")}\n\`\`\``, kind: "code" };
  }

  if (tag === "TABLE") {
    return { md: tableToMd(el), kind: "table" };
  }

  // Fallback
  return { md: inlineToMd(el), kind: "other" };
}

function inlineToMd(el: HTMLElement): string {
  return inlineNodesToMd(el.childNodes);
}

function containerToMd(el: HTMLElement): string {
  const blocks: SerializedBlock[] = [];
  const inlineNodes: Node[] = [];

  const flushInline = () => {
    if (inlineNodes.length === 0) {
      return;
    }
    const inline = inlineNodesToMd(inlineNodes).replaceAll(/^\n+|\n+$/g, "");
    if (inline !== "") {
      blocks.push({ md: inline, kind: "paragraph" });
    }
    inlineNodes.length = 0;
  };

  for (const child of el.childNodes) {
    if (child instanceof HTMLElement && isBlockElement(child)) {
      flushInline();
      const block = blockToMd(child);
      if (block !== null && block.md !== "") {
        blocks.push(block);
      }
      continue;
    }

    inlineNodes.push(child);
  }

  flushInline();
  return joinBlocks(blocks);
}

function inlineNodesToMd(nodes: Iterable<Node>, skip?: (node: Node) => boolean): string {
  let md = "";
  for (const node of nodes) {
    if (skip?.(node)) {
      continue;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      md += (node.textContent ?? "").replaceAll("​", "");
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const child = node as HTMLElement;
      const childTag = child.tagName;

      if (child.dataset["mdCursor"] === "true") {
        md += CURSOR_SENTINEL;
        continue;
      }

      if (childTag === "STRONG" || childTag === "B") {
        md += `**${inlineToMd(child)}**`;
      } else if (childTag === "DEL" || childTag === "S") {
        md += `~~${inlineToMd(child)}~~`;
      } else if (childTag === "EM" || childTag === "I") {
        md += `*${inlineToMd(child)}*`;
      } else if (childTag === "MARK") {
        md += `==${inlineToMd(child)}==`;
      } else if (childTag === "CODE") {
        md += `\`${child.textContent ?? ""}\``;
      } else if (childTag === "A") {
        const { target } = child.dataset;
        if (target) {
          const display = child.textContent ?? target;
          md += display === target ? `[[${target}]]` : `[[${target}|${display}]]`;
        } else {
          const href = child.getAttribute("href") ?? "";
          const text = child.textContent ?? "";
          // Bare autolinked URL: preserve as plain text so it round-trips
          md += text === href && /^https?:\/\//.test(href) ? href : `[${text}](${href})`;
        }
      } else if (childTag === "IMG") {
        const { wikiImage } = child.dataset;
        if (wikiImage) {
          const width = child.getAttribute("width");
          md += width ? `![[${wikiImage}|${width}]]` : `![[${wikiImage}]]`;
        } else {
          const src = child.getAttribute("src") ?? "";
          const alt = child.getAttribute("alt") ?? "";
          md += `![${alt}](${src})`;
        }
      } else if (childTag === "INPUT") {
        // Skip — task list checkboxes are handled at the block level
      } else if (childTag === "BR") {
        md += "\n";
      } else {
        md += inlineToMd(child);
      }
    }
  }
  return md;
}

function listToMd(listEl: HTMLElement, depth: number, ordered: boolean): string {
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  let hasListItem = false;

  for (const [i, child] of [...listEl.children].entries()) {
    if (!(child instanceof HTMLElement)) {
      continue;
    }

    if (child.tagName === "LI") {
      hasListItem = true;
      const checkbox = getDirectCheckbox(child);
      const text = normalizeListItemText(inlineNodesToMd(child.childNodes, isNestedListOrCheckbox));
      let prefix: string;
      if (checkbox && !ordered) {
        prefix = `- [${checkbox.checked ? "x" : " "}] `;
      } else if (ordered) {
        prefix = `${i + 1}. `;
      } else {
        prefix = "- ";
      }

      lines.push(indent + prefix + text);

      for (const nested of getDirectNestedLists(child)) {
        lines.push(listToMd(nested, depth + 1, nested.tagName === "OL"));
      }
      continue;
    }

    if (child.tagName === "UL" || child.tagName === "OL") {
      lines.push(listToMd(child, depth + (hasListItem ? 1 : 0), child.tagName === "OL"));
    }
  }

  return lines.join("\n");
}

function getDirectCheckbox(li: HTMLElement): HTMLInputElement | null {
  for (const child of li.children) {
    if (child instanceof HTMLInputElement && child.type === "checkbox") {
      return child;
    }
  }
  return null;
}

function getDirectNestedLists(li: HTMLElement): HTMLElement[] {
  return [...li.children].filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && (child.tagName === "UL" || child.tagName === "OL"),
  );
}

function isNestedListOrCheckbox(node: Node): boolean {
  if (!(node instanceof HTMLElement)) {
    return false;
  }
  return node.tagName === "UL" || node.tagName === "OL" || node.tagName === "INPUT";
}

function normalizeListItemText(text: string): string {
  const stripped = text.replaceAll("​", "");
  if (stripped.trim() === "") {
    return "";
  }
  return stripped.replaceAll(/^\n+|\n+$/g, "");
}

function joinBlocks(blocks: readonly SerializedBlock[]): string {
  let out = "";

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (i > 0) {
      const previous = blocks[i - 1]!;
      out += blockSeparator(previous, block);
    }
    if (block.md !== BLANK_LINE_SENTINEL) {
      out += block.md;
    }
  }

  return out;
}

function blockSeparator(previous: SerializedBlock, current: SerializedBlock): string {
  if (previous.md === BLANK_LINE_SENTINEL || current.md === BLANK_LINE_SENTINEL) {
    return "\n";
  }
  if (previous.kind === "paragraph" && current.kind === "paragraph") {
    return "\n";
  }
  if (
    (previous.kind === "paragraph" && current.kind === "list") ||
    (previous.kind === "list" && current.kind === "paragraph")
  ) {
    return "\n";
  }
  return "\n\n";
}

function quoteMarkdown(md: string): string {
  return md
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

function hasDirectBlockChildren(el: HTMLElement): boolean {
  return [...el.children].some(isBlockElement);
}

function isBlankLineBlock(el: HTMLElement): boolean {
  if (el.dataset["mdBlank"] === "true") {
    return true;
  }

  let sawBreak = false;
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child.textContent ?? "").replaceAll("​", "").trim() !== "") {
        return false;
      }
      continue;
    }

    if (!(child instanceof HTMLElement)) {
      return false;
    }
    if (child.tagName === "BR") {
      sawBreak = true;
      continue;
    }
    return false;
  }

  return sawBreak;
}

function isBlockElement(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) {
    return false;
  }
  if (el.classList.contains("callout")) {
    return true;
  }
  return BLOCK_TAGS.has(el.tagName);
}

const BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "UL",
  "OL",
  "BLOCKQUOTE",
  "PRE",
  "TABLE",
  "HR",
]);

function tableToMd(table: HTMLElement): string {
  const rows: string[][] = [];
  for (const tr of table.querySelectorAll("tr")) {
    const cells: string[] = [];
    for (const cell of tr.querySelectorAll("th, td")) {
      cells.push((cell.textContent ?? "").trim());
    }
    rows.push(cells);
  }

  if (rows.length === 0) {
    return "";
  }

  const colCount = Math.max(...rows.map((r) => r.length));
  const lines: string[] = [];

  const header = rows[0] ?? [];
  lines.push(`| ${Array.from({ length: colCount }, (_, i) => header[i] ?? "").join(" | ")} |`);
  lines.push(`| ${Array.from({ length: colCount }, () => "---").join(" | ")} |`);

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    lines.push(`| ${Array.from({ length: colCount }, (_, j) => row[j] ?? "").join(" | ")} |`);
  }

  return lines.join("\n");
}
