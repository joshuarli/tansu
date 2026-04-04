import { setupDOM, assertEqual } from "./test-helper.ts";
const cleanup = setupDOM();

const { registerWikiLinkClickHandler } = await import("./wikilinks.ts");

let clickedTarget: string | null = null;
registerWikiLinkClickHandler((target) => {
  clickedTarget = target;
});

// Click on a wiki-link
const link = document.createElement("a");
link.className = "wiki-link";
link.setAttribute("data-target", "My Note");
link.textContent = "My Note";
document.body.appendChild(link);

link.click();
assertEqual(clickedTarget, "My Note", "wiki-link click handler");

// Click on non-wiki-link should not trigger
clickedTarget = null;
const normalLink = document.createElement("a");
normalLink.href = "http://example.com";
normalLink.textContent = "normal";
document.body.appendChild(normalLink);
normalLink.click();
assertEqual(clickedTarget, null, "non-wiki-link not triggered");

// Click on child element of wiki-link does not bubble (no wiki-link class on child)
clickedTarget = null;
const span = document.createElement("span");
span.textContent = "inner";
document.body.appendChild(span);
span.click();
assertEqual(clickedTarget, null, "non-wiki element not triggered");

cleanup();
console.log("All wikilinks tests passed");
