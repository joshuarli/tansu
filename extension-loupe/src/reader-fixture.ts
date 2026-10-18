export function serializeReaderUi(
  readerShadowRoot: ShadowRoot,
  readerTitle: string,
  readerHostElementId: string,
): string {
  const readerFixtureTemplate = document.createElement("template");
  readerFixtureTemplate.innerHTML = readerShadowRoot.innerHTML;
  readerFixtureTemplate.content.querySelector(".loupe-reader-progress")?.remove();

  const inlineStyleElement = readerFixtureTemplate.content.querySelector("style");
  if (inlineStyleElement) {
    inlineStyleElement.textContent =
      inlineStyleElement.textContent
        ?.replaceAll(":host([hidden])", `#${readerHostElementId}[hidden]`)
        .replaceAll(":host", `#${readerHostElementId}`) ?? "";
  }

  const serializedReaderMarkup = [...readerFixtureTemplate.content.childNodes]
    .map((node) => (node instanceof Element ? node.outerHTML : node.textContent || ""))
    .join("");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(readerTitle)}</title>
    <style>
      html, body { margin: 0; min-height: 100%; }
    </style>
  </head>
  <body>
    <div id="${readerHostElementId}" style="position: fixed; inset: 0; z-index: 2147483647">
${serializedReaderMarkup
  .split("\n")
  .map((line) => `      ${line}`)
  .join("\n")}
    </div>
  </body>
</html>
`;
}

function escapeHtml(rawText: string): string {
  return rawText.replaceAll(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}
