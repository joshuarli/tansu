import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { expect, afterAll, describe, beforeAll, test } from "vitest";

import { createEditor } from "../editor.ts";
import { renderMarkdown } from "../markdown.ts";
import { domToMarkdown } from "../serialize.ts";
import { setupDOM } from "./test-helper.ts";

const benchDescribe = process.env["MD_WYSIWYG_BENCH"] === "1" ? describe : describe.skip;
const FIXTURE_VAULT = resolve(
  import.meta.dirname,
  "../../../../tests/fixtures/test-vaults/vault-one",
);
const RESULTS_DIR = resolve(import.meta.dirname, "../../../../bench/results");

function fixtureCorpus(): string {
  return readdirSync(FIXTURE_VAULT)
    .filter((name) => name.endsWith(".md"))
    .toSorted((a, b) => a.localeCompare(b))
    .map((name) => readFileSync(resolve(FIXTURE_VAULT, name), "utf8"))
    .join("\n\n");
}

benchDescribe("Tansu editor large note benchmark", () => {
  let cleanup: () => void;

  beforeAll(() => {
    cleanup = setupDOM();
  });

  afterAll(() => {
    cleanup();
  });

  test("reports render, serialize, and editor roundtrip timings", () => {
    const markdown = fixtureCorpus();

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

    const result = {
      benchmark: "tansu-editor-large-note",
      generatedAt: new Date().toISOString(),
      chars: markdown.length,
      renderMs: Number(renderMs.toFixed(2)),
      serializeMs: Number(serializeMs.toFixed(2)),
      editorSetValueMs: Number(setValueMs.toFixed(2)),
      editorGetValueMs: Number(getValueMs.toFixed(2)),
    };
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(
      resolve(RESULTS_DIR, `editor-large-note-${Date.now()}.json`),
      `${JSON.stringify(result, null, 2)}\n`,
      "utf8",
    );
    console.info(JSON.stringify(result));

    expect(serialized.length).toBeGreaterThan(0);
    expect(roundtrip.length).toBeGreaterThan(0);

    editor.destroy();
    editorHost.remove();
  }, 20_000);
});
