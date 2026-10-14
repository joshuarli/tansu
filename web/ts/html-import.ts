import { importHtml, type HtmlImportParseResult, type ImportPath } from "./html-importer.ts";

export type ImportedHtml = NonNullable<Awaited<ReturnType<typeof importHtml>>>;

export async function pickHtmlImport(notes: Iterable<ImportPath>): Promise<ImportedHtml | null> {
  const file = await pickHtmlFile();
  if (file === null) {
    return null;
  }
  const html = await file.text();
  return importHtml({ html, fallbackTitle: file.name, notes, parse: parseHtml });
}

async function parseHtml(html: string): Promise<HtmlImportParseResult> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const metadata = (name: string): string | undefined =>
    doc.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? undefined;
  const site = doc.querySelector('meta[property="og:site_name"]')?.getAttribute("content");
  const author = metadata("author");
  const published = metadata("date") ?? metadata("publish_date");
  const description = metadata("description");
  const contentMarkdown = (doc.body.innerText || doc.body.textContent)?.trim() || undefined;
  return {
    ...(doc.title ? { title: doc.title } : {}),
    ...(author ? { author } : {}),
    ...(site ? { site } : {}),
    ...(published ? { published } : {}),
    ...(description ? { description } : {}),
    ...(contentMarkdown ? { contentMarkdown } : {}),
  };
}

function pickHtmlFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".html,.htm,text/html";
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
    input.click();
  });
}
