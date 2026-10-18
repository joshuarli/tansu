import assert from "node:assert/strict";
import { test } from "vitest";
import type { LoupeParsedPage } from "../src/extension-messages.ts";
import { createReaderMarkdownFromPage } from "../src/reader-markdown.ts";

test("adds reader metadata as YAML frontmatter", () => {
  const parsedPage: LoupeParsedPage = {
    content: "<p>Article body.</p>",
    content_markdown: "Article body.",
    title: "Part 1: AI, Rockets, and the Return of Hard Contracts | Essays",
    author: "xjdr",
    description:
      "What gets cheap when implementation is abundant, and what stays stubbornly expensive",
    published: "2026-07-12",
    site: "Noumena",
    domain: "noumena.com",
    extractor_type: "default",
  };

  assert.equal(
    createReaderMarkdownFromPage(
      parsedPage.content_markdown || "",
      parsedPage,
      "https://noumena.com/essays/the-engine-shop-part-1",
      "Fallback title",
    ),
    `---
title: "Part 1: AI, Rockets, and the Return of Hard Contracts | Essays"
description: "What gets cheap when implementation is abundant, and what stays stubbornly expensive"
date: "2026-07-12"
author: "xjdr"
url: "https://noumena.com/essays/the-engine-shop-part-1"
domain: "noumena.com"
---

Article body.`,
  );
});

test("leaves unavailable Markdown empty", () => {
  const parsedPage = {
    title: "Title",
    description: "Description",
    author: "Author",
    published: "2026-07-12",
    domain: "example.com",
  } as LoupeParsedPage;

  assert.equal(createReaderMarkdownFromPage("", parsedPage, "https://example.com", "Fallback"), "");
});
