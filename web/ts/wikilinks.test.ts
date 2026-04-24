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

  it("wiki-link click handler", () => {
    const link = document.createElement("a");
    link.className = "wiki-link";
    link.dataset["target"] = "My Note";
    link.textContent = "My Note";
    document.body.append(link);

    link.click();
    expect(clickedTarget).toBe("My Note");
  });

  it("non-wiki-link not triggered", () => {
    clickedTarget = null;
    const normalLink = document.createElement("a");
    normalLink.href = "http://example.com";
    normalLink.textContent = "normal";
    document.body.append(normalLink);
    normalLink.click();
    expect(clickedTarget).toBeNull();
  });

  it("non-wiki element not triggered", () => {
    clickedTarget = null;
    const span = document.createElement("span");
    span.textContent = "inner";
    document.body.append(span);
    span.click();
    expect(clickedTarget).toBeNull();
  });
});
