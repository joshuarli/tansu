import type { MarkdownExtension, BlockKind } from "./extension.js";
import { escapeHtml } from "./util.js";

const DEFAULT_ICONS: Record<string, string> = {
  note: "\u{1F4DD}",
  info: "ℹ️",
  tip: "\u{1F4A1}",
  hint: "\u{1F4A1}",
  important: "❗",
  warning: "⚠️",
  caution: "⚠️",
  danger: "\u{1F6A8}",
  bug: "\u{1F41B}",
  example: "\u{1F4CB}",
  quote: "\u{1F4AC}",
  abstract: "\u{1F4C4}",
  summary: "\u{1F4C4}",
  todo: "✅",
  question: "❓",
  faq: "❓",
  success: "✅",
  check: "✅",
  done: "✅",
  failure: "❌",
  fail: "❌",
  missing: "❌",
};

export function createCalloutExtension(opts?: {
  icons?: Record<string, string>;
}): MarkdownExtension {
  const icons = { ...DEFAULT_ICONS, ...opts?.icons };
  return {
    renderBlockquote(lines, renderLines) {
      const first = lines[0] ?? "";
      const match = first.match(/^\[!(\w+)\]\s*(.*)/);
      if (!match) return null;
      const type = match[1]!.toLowerCase();
      const titleText = match[2]!.trim() || type.charAt(0).toUpperCase() + type.slice(1);
      const icon = icons[type] ?? "";
      const bodyLines = lines.slice(1);
      const bodyHtml = renderLines(bodyLines);
      return `<div class="callout callout-${escapeHtml(type)}" data-callout="${escapeHtml(type)}"><div class="callout-title">${icon} ${escapeHtml(titleText)}</div>${bodyHtml ? `<div class="callout-body">${bodyHtml}</div>` : ""}</div>`;
    },

    serializeBlock(el, serializeChildren) {
      if (!el.classList.contains("callout")) return null;
      const type = el.dataset["callout"] ?? "note";
      const titleEl = el.querySelector(".callout-title");
      const bodyEl = el.querySelector(".callout-body");
      const icon = titleEl?.textContent?.match(/^.\s*/)?.[0] ?? "";
      const titleText = (titleEl?.textContent ?? "").replace(icon, "").trim();
      const defaultTitle = type.charAt(0).toUpperCase() + type.slice(1);
      const titleSuffix = titleText && titleText !== defaultTitle ? ` ${titleText}` : "";
      let lines = `> [!${type}]${titleSuffix}`;
      if (bodyEl) {
        const bodyMd = serializeChildren(bodyEl as HTMLElement);
        if (bodyMd !== "") {
          lines += `\n${quoteMarkdown(bodyMd)}`;
        }
      }
      return { md: lines, kind: "blockquote" as BlockKind };
    },

    isBlock(el) {
      return el.classList.contains("callout");
    },
  };
}

function quoteMarkdown(md: string): string {
  return md
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}
