import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, ".."),
  readerFixturesDirectory = resolve(repositoryRoot, "extension-loupe/test/fixtures"),
  readerOverlayStyles = readFileSync(
    resolve(repositoryRoot, "extension-loupe/src/reader-overlay.css"),
    "utf8",
  )
    .replaceAll(":host([hidden])", "#loupe-reader-host[hidden]")
    .replaceAll(":host", "#loupe-reader-host"),
  readerOverlayMarkup = readFileSync(
    resolve(repositoryRoot, "extension-loupe/src/reader-overlay.html"),
    "utf8",
  ),
  readerSampleSourceHtml = readFileSync(
    resolve(readerFixturesDirectory, "reader-sample-source.html"),
    "utf8",
  ),
  readerSampleSourceBody = readerSampleSourceHtml
    .match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1]
    .trim();
if (!readerSampleSourceBody) {
  throw new Error("reader-sample-source.html does not contain a body");
}

let sampleHeadingNumber = 0;
const readerArticleHtml = readerSampleSourceBody.replaceAll(
    /<h([1-6])([^>]*)>/gi,
    (_match, level, attrs) => {
      if (level === "1" || /\sid=/.test(attrs)) return _match;
      sampleHeadingNumber++;
      const headingId = `sample-heading-${sampleHeadingNumber}`;
      return `<h${level}${attrs} id="${headingId}">`;
    },
  ),
  readerSampleHeadings = [
    ...readerArticleHtml.matchAll(/<h([1-6])[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/gi),
  ],
  readerSampleOutlineHtml = readerSampleHeadings
    .map(([, level, headingId, headingText]) => {
      const depth = Math.min(Number(level) - 2, 4),
        headingLabel = headingText.replaceAll(/<[^>]+>/g, "").trim();
      return `<div class="loupe-reader-outline-item" data-depth="${depth}" data-heading-id="${headingId}">${headingLabel}</div>`;
    })
    .join("\n            "),
  readerOverlayMarkupWithSample = readerOverlayMarkup
    .replace(
      "<article></article>",
      `<article><h1>Quality software</h1>${readerArticleHtml}</article>`,
    )
    .replace(
      '<nav class="loupe-reader-outline" aria-label="Article outline"></nav>',
      `<nav class="loupe-reader-outline" aria-label="Article outline">${readerSampleOutlineHtml}</nav>`,
    ),
  output = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Loupe sample</title>
    <style>
      html, body { margin: 0; min-height: 100%; }
    </style>
  </head>
  <body>
    <div id="loupe-reader-host" style="position: fixed; inset: 0; z-index: 2147483647">
      <style>
${readerOverlayStyles
  .split("\n")
  .map((line) => (line.trim() ? `        ${line}` : ""))
  .join("\n")}
      </style>
${readerOverlayMarkupWithSample
  .split("\n")
  .map((line) => (line.trim() ? `      ${line}` : ""))
  .join("\n")}
    </div>
  </body>
</html>
`,
  outputPath =
    process.env.READER_SAMPLE_OUTPUT || resolve(readerFixturesDirectory, "reader-sample.html");
writeFileSync(outputPath, output);
console.log(`Generated ${outputPath}`);
