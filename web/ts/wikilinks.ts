/// marked.js extension for [[wiki-links]] and ![[image embeds]].

declare const marked: { use: (ext: unknown) => void };

const calloutIcons: Record<string, string> = {
  note: '\u{1F4DD}', info: '\u2139\uFE0F', tip: '\u{1F4A1}', hint: '\u{1F4A1}',
  important: '\u2757', warning: '\u26A0\uFE0F', caution: '\u26A0\uFE0F',
  danger: '\u{1F6A8}', bug: '\u{1F41B}', example: '\u{1F4CB}', quote: '\u{1F4AC}',
  abstract: '\u{1F4C4}', summary: '\u{1F4C4}', todo: '\u2705', question: '\u2753',
  faq: '\u2753', success: '\u2705', check: '\u2705', done: '\u2705',
  failure: '\u274C', fail: '\u274C', missing: '\u274C',
};

export function registerWikiLinkExtension(onLinkClick: (target: string) => void) {
  // Callout rendering: transform blockquotes starting with [!type]
  marked.use({
    renderer: {
      blockquote(token: { text: string }) {
        const html = token.text;
        // Match <p>[!type] optional title\n rest</p> or <p>[!type]</p>
        const m = html.match(/^<p>\[!(\w+)\]\s*(.*?)<\/p>/s);
        if (m) {
          const type = m[1]!.toLowerCase();
          const rest = m[2]!;
          const icon = calloutIcons[type] ?? '';
          // Split title from body: title is the first line after [!type]
          const lines = rest.split('\n');
          const titleText = lines[0]?.trim() || type.charAt(0).toUpperCase() + type.slice(1);
          const bodyHtml = html.slice(m[0].length).trim();
          const extraBody = lines.slice(1).join('\n').trim();
          const fullBody = extraBody ? `<p>${extraBody}</p>${bodyHtml}` : bodyHtml;
          return `<div class="callout callout-${type}" data-callout="${type}"><div class="callout-title">${icon} ${titleText}</div>${fullBody ? `<div class="callout-body">${fullBody}</div>` : ''}</div>`;
        }
        return `<blockquote>${html}</blockquote>`;
      },
    },
  });

  marked.use({
    extensions: [
      {
        name: 'wikiImage',
        level: 'inline',
        start(src: string) { return src.indexOf('![['); },
        tokenizer(src: string) {
          const match = /^!\[\[([^\]]+)\]\]/.exec(src);
          if (match) {
            return {
              type: 'wikiImage',
              raw: match[0],
              target: match[1],
            };
          }
          return undefined;
        },
        renderer(token: { target: string }) {
          const src = `/z-images/${encodeURIComponent(token.target)}`;
          const alt = token.target;
          return `<img src="${src}" alt="${alt}" data-wiki-image="${token.target}" loading="lazy">`;
        },
      },
      {
        name: 'highlight',
        level: 'inline',
        start(src: string) { return src.indexOf('=='); },
        tokenizer(src: string) {
          const match = /^==([^=]+)==/.exec(src);
          if (match) {
            return { type: 'highlight', raw: match[0], text: match[1] };
          }
          return undefined;
        },
        renderer(token: { text: string }) {
          return `<mark>${token.text}</mark>`;
        },
      },
      {
        name: 'wikiLink',
        level: 'inline',
        start(src: string) { return src.indexOf('[['); },
        tokenizer(src: string) {
          const match = /^\[\[([^\]]+)\]\]/.exec(src);
          if (match) {
            const parts = match[1]!.split('|');
            return {
              type: 'wikiLink',
              raw: match[0],
              target: parts[0]!.trim(),
              display: (parts[1] ?? parts[0])!.trim(),
            };
          }
          return undefined;
        },
        renderer(token: { target: string; display: string }) {
          return `<a class="wiki-link" data-target="${token.target}">${token.display}</a>`;
        },
      },
    ],
  });

  // Delegate click handler for wiki-links
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains('wiki-link')) {
      e.preventDefault();
      const linkTarget = target.getAttribute('data-target');
      if (linkTarget) onLinkClick(linkTarget);
    }
  });
}
