import type { MarkdownExtension } from "./extension.js";
import { escapeHtml } from "./util.js";

export function createWikiLinkExtension(): MarkdownExtension {
  return {
    renderInline(text, i) {
      if (text[i] !== "[" || text[i + 1] !== "[") return null;
      const end = text.indexOf("]]", i + 2);
      if (end === -1) return null;
      const inner = text.slice(i + 2, end);
      const pipe = inner.indexOf("|");
      const target = pipe !== -1 ? inner.slice(0, pipe).trim() : inner.trim();
      const display = pipe !== -1 ? inner.slice(pipe + 1).trim() : inner.trim();
      const html = `<a class="wiki-link" data-target="${escapeHtml(target)}">${escapeHtml(display)}</a>`;
      return { html, consumed: end + 2 - i };
    },

    serializeInline(el) {
      if (el.tagName !== "A" || !el.dataset["target"]) return null;
      const target = el.dataset["target"]!;
      const display = el.textContent ?? target;
      return display === target ? `[[${target}]]` : `[[${target}|${display}]]`;
    },
  };
}
