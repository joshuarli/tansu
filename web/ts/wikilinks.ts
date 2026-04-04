/// marked.js extension for [[wiki-links]] and ![[image embeds]].

declare const marked: { use: (ext: unknown) => void };

export function registerWikiLinkExtension(onLinkClick: (target: string) => void) {
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
