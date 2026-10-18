import { serializeReaderUi } from "../src/reader-fixture.ts";

const readerHost = document.createElement("div"),
  readerShadowRoot = readerHost.attachShadow({ mode: "open" });
readerShadowRoot.innerHTML = `
  <style>:host { color: red; } .loupe-reader { display: block; }</style>
  <div class="loupe-reader">
    <div class="loupe-reader-progress"></div>
    <div class="loupe-reader-toolbar"><button>Download Fixtures</button></div>
    <article><h1>Rendered title</h1></article>
  </div>`;
document.body.append(readerHost);

const serializedFixtureOutput = document.createElement("pre");
serializedFixtureOutput.textContent = serializeReaderUi(
  readerShadowRoot,
  "Rendered title",
  "loupe-reader-host",
);
document.body.replaceChildren(serializedFixtureOutput);
