/// Click handler for [[wiki-links]] rendered by markdown.ts.

export function registerWikiLinkClickHandler(onLinkClick: (target: string) => void) {
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains('wiki-link')) {
      e.preventDefault();
      const linkTarget = target.getAttribute('data-target');
      if (linkTarget) onLinkClick(linkTarget);
    }
  });
}
