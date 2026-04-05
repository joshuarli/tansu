import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setupDOM } from "./test-helper.ts";

describe("wikilinks", () => {
  let cleanup: () => void;
  let clickedTarget: string | null = null;

  beforeAll(async () => {
    cleanup = setupDOM();

    const { registerWikiLinkClickHandler } = await import("./wikilinks.ts");

    registerWikiLinkClickHandler((target) => {
      clickedTarget = target;
    });
  });

  afterAll(() => {
    cleanup();
  });

  test("wiki-link click handler", () => {
    const link = document.createElement("a");
    link.className = "wiki-link";
    link.setAttribute("data-target", "My Note");
    link.textContent = "My Note";
    document.body.appendChild(link);

    link.click();
    expect(clickedTarget).toBe("My Note");
  });

  test("non-wiki-link not triggered", () => {
    clickedTarget = null;
    const normalLink = document.createElement("a");
    normalLink.href = "http://example.com";
    normalLink.textContent = "normal";
    document.body.appendChild(normalLink);
    normalLink.click();
    expect(clickedTarget).toBe(null);
  });

  test("non-wiki element not triggered", () => {
    clickedTarget = null;
    const span = document.createElement("span");
    span.textContent = "inner";
    document.body.appendChild(span);
    span.click();
    expect(clickedTarget).toBe(null);
  });
});
