import { performance } from "node:perf_hooks";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEditor } from "../src/editor.ts";
import { renderMarkdown } from "../src/markdown.ts";
import { domToMarkdown } from "../src/serialize.ts";
import { setupDOM } from "./test-helper.ts";

const benchDescribe = process.env["MD_WYSIWYG_BENCH"] === "1" ? describe : describe.skip;

function makeLargeNote(sectionCount = 250): string {
  const parts: string[] = [];
  for (let i = 0; i < sectionCount; i++) {
    parts.push(
      `# Section ${i + 1}`,
      "",
      `This is a paragraph for section ${i + 1} with **bold**, *italic*, and [[Wiki Link ${i + 1}]].`,
      "",
      "- item one",
      "- item two",
      "- item three",
      "",
      "```ts",
      `export const section${i + 1} = ${i + 1};`,
      "```",
      "",
    );
  }
  return parts.join("\n");
}

benchDescribe("md-wysiwyg large note benchmark", () => {
  let cleanup: () => void;

  beforeAll(() => {
    cleanup = setupDOM();
  });

  afterAll(() => {
    cleanup();
  });

  it("reports render, serialize, and editor roundtrip timings", () => {
    const markdown = makeLargeNote();

    const renderStart = performance.now();
    const html = renderMarkdown(markdown);
    const renderMs = performance.now() - renderStart;

    const host = document.createElement("div");
    host.innerHTML = html;

    const serializeStart = performance.now();
    const serialized = domToMarkdown(host);
    const serializeMs = performance.now() - serializeStart;

    const editorHost = document.createElement("div");
    document.body.append(editorHost);
    const editor = createEditor(editorHost);

    const setValueStart = performance.now();
    editor.setValue(markdown);
    const setValueMs = performance.now() - setValueStart;

    const getValueStart = performance.now();
    const roundtrip = editor.getValue();
    const getValueMs = performance.now() - getValueStart;

    console.info(
      JSON.stringify({
        benchmark: "md-wysiwyg-large-note",
        chars: markdown.length,
        renderMs: Number(renderMs.toFixed(2)),
        serializeMs: Number(serializeMs.toFixed(2)),
        editorSetValueMs: Number(setValueMs.toFixed(2)),
        editorGetValueMs: Number(getValueMs.toFixed(2)),
      }),
    );

    expect(serialized.length).toBeGreaterThan(0);
    expect(roundtrip.length).toBeGreaterThan(0);

    editor.destroy();
    editorHost.remove();
  });
});
