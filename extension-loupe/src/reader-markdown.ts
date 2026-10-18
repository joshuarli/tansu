import type { LoupeParsedPage } from "./extension-messages.ts";
import { formatFrontmatterDate } from "./published-date.ts";

export interface ReaderMarkdownMetadata {
  title: string;
  description: string;
  author: string;
  published: string;
  domain: string;
  pageUrl: string;
}

export function createReaderMarkdown(
  readerMarkdown: string,
  metadata: ReaderMarkdownMetadata,
): string {
  if (!readerMarkdown.trim()) {
    return readerMarkdown;
  }

  const frontmatter: [string, string][] = [
      ["title", metadata.title],
      ["description", metadata.description],
      ["date", formatFrontmatterDate(metadata.published)],
      ["author", metadata.author],
      ["url", metadata.pageUrl],
      ["domain", metadata.domain],
    ],
    frontmatterYaml = frontmatter
      .filter(([, value]) => value.trim())
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join("\n");

  return `---\n${frontmatterYaml}\n---\n\n${readerMarkdown}`;
}

export function createReaderMarkdownFromPage(
  readerMarkdown: string,
  parsedPage: LoupeParsedPage,
  pageUrl: string,
  fallbackTitle: string,
): string {
  return createReaderMarkdown(readerMarkdown, {
    title: parsedPage.title || fallbackTitle,
    description: parsedPage.description,
    author: parsedPage.author,
    published: parsedPage.published,
    domain: parsedPage.domain,
    pageUrl,
  });
}
