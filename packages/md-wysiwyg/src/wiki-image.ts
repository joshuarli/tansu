import type { MarkdownExtension } from "./extension.js";
import { escapeHtml } from "./util.js";

export function createWikiImageExtension(opts: {
  resolveUrl: (name: string) => string;
}): MarkdownExtension {
  return {
    renderInline(text, i) {
      if (text[i] !== "!" || text[i + 1] !== "[" || text[i + 2] !== "[") return null;
      const end = text.indexOf("]]", i + 3);
      if (end === -1) return null;
      const inner = text.slice(i + 3, end);
      const pipe = inner.indexOf("|");
      const imageName = pipe !== -1 ? inner.slice(0, pipe).trim() : inner.trim();
      const widthStr = pipe !== -1 ? inner.slice(pipe + 1).trim() : "";
      const width = /^\d+$/.test(widthStr) ? widthStr : "";
      const src = opts.resolveUrl(imageName);
      const widthAttr = width ? ` width="${width}"` : "";
      const html = `<img src="${escapeHtml(src)}" alt="${escapeHtml(imageName)}" data-wiki-image="${escapeHtml(imageName)}"${widthAttr} loading="lazy">`;
      return { html, consumed: end + 2 - i };
    },

    serializeInline(el) {
      if (el.tagName !== "IMG" || !el.dataset["wikiImage"]) return null;
      const { wikiImage } = el.dataset;
      const width = el.getAttribute("width");
      return width ? `![[${wikiImage}|${width}]]` : `![[${wikiImage}]]`;
    },
  };
}
