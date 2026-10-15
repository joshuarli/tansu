import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { expect, afterEach, describe, test } from "vitest";

import { createCodeMirrorEditor } from "../codemirror-adapter.ts";

const benchDescribe = process.env["MD_WYSIWYG_BENCH"] === "1" ? describe : describe.skip;
const FIXTURE_VAULT = resolve(import.meta.dirname, "../../../../tests/fixtures/demo-vault");
const RESULTS_DIR = resolve(import.meta.dirname, "../../../../.work/tmp/bench-results");
let disposeEditor: (() => void) | null = null;

function fixtureCorpus(): string {
  return readdirSync(FIXTURE_VAULT)
    .filter((name) => name.endsWith(".md"))
    .toSorted((a, b) => a.localeCompare(b))
    .map((name) => readFileSync(resolve(FIXTURE_VAULT, name), "utf8"))
    .join("\n\n");
}

benchDescribe("Tansu CodeMirror large note benchmark", () => {
  afterEach(() => disposeEditor?.());

  test("reports mount, source replacement, and snapshot timings", () => {
    const markdown = fixtureCorpus();
    const host = document.createElement("div");
    document.body.append(host);
    const mountStart = performance.now();
    const editor = createCodeMirrorEditor(host);
    const session = editor.createSession("large-note", "");
    editor.attachSession(session);
    const mountMs = performance.now() - mountStart;
    disposeEditor = () => {
      editor.dispose();
      host.remove();
      disposeEditor = null;
    };

    const replacementStart = performance.now();
    const reload = editor.reloadIfClean(session, markdown);
    const replaceSourceMs = performance.now() - replacementStart;
    const snapshotStart = performance.now();
    const snapshot = editor.getSnapshot();
    const snapshotMs = performance.now() - snapshotStart;
    const result = {
      benchmark: "tansu-codemirror-large-note",
      generatedAt: new Date().toISOString(),
      chars: markdown.length,
      mountMs: Number(mountMs.toFixed(2)),
      replaceSourceMs: Number(replaceSourceMs.toFixed(2)),
      snapshotMs: Number(snapshotMs.toFixed(2)),
    };

    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(
      resolve(RESULTS_DIR, `editor-large-note-${Date.now()}.json`),
      `${JSON.stringify(result, null, 2)}\n`,
      "utf8",
    );
    console.info(JSON.stringify(result));

    expect(reload.kind).toBe("reloaded");
    expect(snapshot?.source).toBe(markdown);
    expect(snapshot?.dirty).toBeFalsy();
  }, 20_000);
});
