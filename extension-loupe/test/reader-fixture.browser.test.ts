import { expect, test } from "vitest";
import fixtureScript from "../../build/browser-test/reader-fixture.js?raw";

test("reader fixture serialization preserves browser-rendered content", () => {
  const script = document.createElement("script");
  script.textContent = fixtureScript;
  document.body.append(script);

  expect(document.body.textContent).toContain("Rendered title");
  expect(document.body.textContent).toContain("color: red");
  expect(document.body.textContent).not.toContain("loupe-reader-progress");
  expect(document.body.textContent).toContain("loupe-reader-toolbar");
});
