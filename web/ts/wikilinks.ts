/// Click handler for [[wiki-links]] rendered by markdown.ts.

export function registerWikiLinkClickHandler(onLinkClick: (target: string) => void): () => void {
  const onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains("wiki-link")) {
      e.preventDefault();
      const linkTarget = target.dataset["target"];
      if (linkTarget) {
        onLinkClick(linkTarget);
      }
    }
  };

  document.addEventListener("click", onClick);
  return () => {
    document.removeEventListener("click", onClick);
  };
}
