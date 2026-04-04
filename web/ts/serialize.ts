/// DOM → Markdown serialization for the WYSIWYG editor.

export function domToMarkdown(root: HTMLElement): string {
  const blocks: string[] = [];
  for (const child of root.children) {
    const md = blockToMd(child as HTMLElement);
    if (md !== null) blocks.push(md);
  }
  return blocks.join("\n\n");
}

function blockToMd(el: HTMLElement): string | null {
  const tag = el.tagName;

  if (tag === "H1") return `# ${inlineToMd(el)}`;
  if (tag === "H2") return `## ${inlineToMd(el)}`;
  if (tag === "H3") return `### ${inlineToMd(el)}`;
  if (tag === "H4") return `#### ${inlineToMd(el)}`;
  if (tag === "H5") return `##### ${inlineToMd(el)}`;
  if (tag === "H6") return `###### ${inlineToMd(el)}`;
  if (el.classList.contains("callout")) {
    const type = el.getAttribute("data-callout") ?? "note";
    const titleEl = el.querySelector(".callout-title");
    const bodyEl = el.querySelector(".callout-body");
    const icon = titleEl?.textContent?.match(/^.\s*/)?.[0] ?? "";
    const titleText = (titleEl?.textContent ?? "").replace(icon, "").trim();
    const defaultTitle = type.charAt(0).toUpperCase() + type.slice(1);
    const titleSuffix = titleText && titleText !== defaultTitle ? ` ${titleText}` : "";
    let lines = `> [!${type}]${titleSuffix}`;
    if (bodyEl) {
      for (const child of bodyEl.children) {
        const inner = blockToMd(child as HTMLElement) ?? "";
        lines +=
          "\n" +
          inner
            .split("\n")
            .map((l) => `> ${l}`)
            .join("\n");
      }
    }
    return lines;
  }

  if (tag === "P" || tag === "DIV") return inlineToMd(el);
  if (tag === "HR") return "---";

  if (tag === "UL") {
    return Array.from(el.children)
      .map((li) => {
        const checkbox = li.querySelector('input[type="checkbox"]');
        if (checkbox) {
          const checked = (checkbox as HTMLInputElement).checked;
          const text = inlineToMd(li as HTMLElement);
          return `- [${checked ? "x" : " "}] ${text}`;
        }
        return `- ${inlineToMd(li as HTMLElement)}`;
      })
      .join("\n");
  }

  if (tag === "OL") {
    return Array.from(el.children)
      .map((li, i) => `${i + 1}. ${inlineToMd(li as HTMLElement)}`)
      .join("\n");
  }

  if (tag === "BLOCKQUOTE") {
    const inner = Array.from(el.children)
      .map((child) => blockToMd(child as HTMLElement) ?? "")
      .join("\n\n");
    return inner
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
  }

  if (tag === "PRE") {
    const code = el.querySelector("code");
    const text = code?.textContent ?? el.textContent ?? "";
    const lang = code?.className?.match(/language-(\S+)/)?.[1] ?? "";
    return "```" + lang + "\n" + text.replace(/\n$/, "") + "\n```";
  }

  if (tag === "TABLE") {
    return tableToMd(el);
  }

  // Fallback
  return inlineToMd(el);
}

function inlineToMd(el: HTMLElement): string {
  let md = "";
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      md += (node.textContent ?? "").replace(/\u200B/g, "");
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const child = node as HTMLElement;
      const childTag = child.tagName;

      if (childTag === "STRONG" || childTag === "B") {
        md += `**${inlineToMd(child)}**`;
      } else if (childTag === "DEL" || childTag === "S") {
        md += `~~${inlineToMd(child)}~~`;
      } else if (childTag === "EM" || childTag === "I") {
        md += `*${inlineToMd(child)}*`;
      } else if (childTag === "MARK") {
        md += `==${inlineToMd(child)}==`;
      } else if (childTag === "CODE") {
        md += "`" + (child.textContent ?? "") + "`";
      } else if (childTag === "A") {
        const target = child.getAttribute("data-target");
        if (target) {
          const display = child.textContent ?? target;
          if (display === target) {
            md += `[[${target}]]`;
          } else {
            md += `[[${target}|${display}]]`;
          }
        } else {
          const href = child.getAttribute("href") ?? "";
          md += `[${child.textContent ?? ""}](${href})`;
        }
      } else if (childTag === "IMG") {
        const wikiImage = child.getAttribute("data-wiki-image");
        if (wikiImage) {
          md += `![[${wikiImage}]]`;
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

function tableToMd(table: HTMLElement): string {
  const rows: string[][] = [];
  for (const tr of table.querySelectorAll("tr")) {
    const cells: string[] = [];
    for (const cell of tr.querySelectorAll("th, td")) {
      cells.push((cell.textContent ?? "").trim());
    }
    rows.push(cells);
  }

  if (rows.length === 0) return "";

  const colCount = Math.max(...rows.map((r) => r.length));
  const lines: string[] = [];

  const header = rows[0] ?? [];
  lines.push("| " + Array.from({ length: colCount }, (_, i) => header[i] ?? "").join(" | ") + " |");
  lines.push("| " + Array.from({ length: colCount }, () => "---").join(" | ") + " |");

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    lines.push("| " + Array.from({ length: colCount }, (_, j) => row[j] ?? "").join(" | ") + " |");
  }

  return lines.join("\n");
}
