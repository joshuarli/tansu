const REMOVED_ELEMENTS = new Set([
  "BASE",
  "BUTTON",
  "EMBED",
  "FORM",
  "FRAME",
  "IFRAME",
  "INPUT",
  "LINK",
  "META",
  "OBJECT",
  "SCRIPT",
  "STYLE",
  "SVG",
  "TEMPLATE",
]);

export function sanitizeHtmlToMarkdown(html: string): string {
  const document = new DOMParser().parseFromString(html, "text/html");
  sanitizeTree(document.body);
  return serializeChildren(document.body).trim();
}

function sanitizeTree(root: ParentNode): void {
  for (const element of [...root.querySelectorAll("*")]) {
    if (REMOVED_ELEMENTS.has(element.tagName)) {
      element.remove();
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || name === "style" || name === "srcdoc") {
        element.removeAttribute(attribute.name);
        continue;
      }
      if ((name === "href" || name === "src" || name === "xlink:href") && !isSafeUrl(attribute.value)) {
        element.removeAttribute(attribute.name);
      }
    }
  }
}

function isSafeUrl(value: string): boolean {
  const url = value.trim().toLowerCase();
  return url === "" ||
    url.startsWith("#") ||
    url.startsWith("/") ||
    url.startsWith("./") ||
    url.startsWith("../") ||
    url.startsWith("https:") ||
    url.startsWith("http:") ||
    url.startsWith("mailto:") ||
    url.startsWith("tel:");
}

function serializeChildren(parent: ParentNode): string {
  return [...parent.childNodes].map(serializeNode).join("");
}

function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof Element)) return "";
  const content = serializeChildren(node);
  switch (node.tagName) {
    case "BR": {
      return "\n";
    }
    case "STRONG":
    case "B": {
      return `**${content}**`;
    }
    case "EM":
    case "I": {
      return `*${content}*`;
    }
    case "S":
    case "DEL": {
      return `~~${content}~~`;
    }
    case "CODE": {
      return `\`${content.replaceAll("`", "\\`")}\``;
    }
    case "PRE": {
      return serializeCodeBlock(node);
    }
    case "A": {
      const href = node.getAttribute("href");
      return href === null ? content : `[${content}](${href})`;
    }
    case "IMG": {
      const src = node.getAttribute("src");
      const alt = node.getAttribute("alt") ?? "";
      return src === null ? alt : `![${alt}](${src})`;
    }
    case "P":
    case "DIV":
    case "SECTION":
    case "ARTICLE": {
      return `${content}\n\n`;
    }
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6": {
      return `${"#".repeat(Number(node.tagName.slice(1)))} ${content}\n\n`;
    }
    case "BLOCKQUOTE": {
      return `${content.trim().split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
    }
    case "UL": {
      return `${[...node.children].filter((child) => child.tagName === "LI").map((item) => `- ${serializeChildren(item).trim()}`).join("\n")}\n\n`;
    }
    case "OL": {
      return `${[...node.children].filter((child) => child.tagName === "LI").map((item, index) => `${index + 1}. ${serializeChildren(item).trim()}`).join("\n")}\n\n`;
    }
    case "TABLE": {
      return serializeTable(node);
    }
    case "HR": {
      return "---\n\n";
    }
    default: {
      return content;
    }
  }
}

function serializeCodeBlock(pre: Element): string {
  const content = pre.textContent ?? "";
  const longestRun = Math.max(0, ...[...content.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${content.replace(/\n?$/, "\n")}${fence}\n\n`;
}

function serializeTable(table: Element): string {
  const rows = [...table.querySelectorAll("tr")].map((row) =>
    [...row.querySelectorAll("th, td")].map((cell) => serializeChildren(cell).trim())
  );
  if (rows.length === 0) return "";
  const first = rows[0];
  if (first === undefined) return "";
  const columns = Math.max(...rows.map((row) => row.length));
  const escapedPipe = String.raw`\|`;
  const serializeRow = (row: string[]) => `| ${Array.from({ length: columns }, (_, index) => (row[index] ?? "").replaceAll("|", escapedPipe)).join(" | ")} |`;
  const header = serializeRow(first);
  const separator = `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`;
  return `${[header, separator, ...rows.slice(1).map(serializeRow)].join("\n")}\n\n`;
}
