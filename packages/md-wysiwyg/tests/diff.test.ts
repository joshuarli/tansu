import { computeDiff, renderDiff, type DiffHunk } from "../src/diff.ts";
import { setupDOM } from "./test-helper.ts";

describe("computeDiff", () => {
  it("identical texts produce no hunks", () => {
    const hunks = computeDiff("hello\nworld", "hello\nworld");
    expect(hunks).toHaveLength(0);
  });

  it("one hunk for single change", () => {
    const hunks = computeDiff("hello\nworld", "hello\nearth");
    expect(hunks).toHaveLength(1);
    const { lines } = hunks[0]!;
    expect(lines.some((l) => l.type === "del" && l.text === "world")).toBeTruthy();
    expect(lines.some((l) => l.type === "add" && l.text === "earth")).toBeTruthy();
    expect(lines.some((l) => l.type === "ctx" && l.text === "hello")).toBeTruthy();
  });

  it("one hunk for addition", () => {
    const hunks = computeDiff("a\nb", "a\nb\nc");
    expect(hunks).toHaveLength(1);
    const addLines = hunks[0]!.lines.filter((l) => l.type === "add");
    expect(addLines).toHaveLength(1);
    expect(addLines[0]!.text).toBe("c");
  });

  it("one hunk for deletion", () => {
    const hunks = computeDiff("a\nb\nc", "a\nb");
    expect(hunks).toHaveLength(1);
    const delLines = hunks[0]!.lines.filter((l) => l.type === "del");
    expect(delLines).toHaveLength(1);
    expect(delLines[0]!.text).toBe("c");
  });

  it("far apart changes produce multiple hunks", () => {
    const oldLines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const newLines = [...oldLines];
    newLines[2] = "changed 2";
    newLines[17] = "changed 17";
    const hunks = computeDiff(oldLines.join("\n"), newLines.join("\n"));
    expect(hunks.length).toBeGreaterThanOrEqual(2);
  });

  it("one hunk for all-add", () => {
    const hunks = computeDiff("", "hello\nworld");
    expect(hunks).toHaveLength(1);
    const addLines = hunks[0]!.lines.filter((l) => l.type === "add");
    expect(addLines.length).toBeGreaterThanOrEqual(1);
  });

  it("one hunk for all-del", () => {
    const hunks = computeDiff("hello\nworld", "");
    expect(hunks).toHaveLength(1);
    const delLines = hunks[0]!.lines.filter((l) => l.type === "del");
    expect(delLines.length).toBeGreaterThanOrEqual(1);
  });
});

describe("renderDiff", () => {
  let cleanup: () => void;

  beforeAll(() => {
    cleanup = setupDOM();
  });

  afterAll(() => {
    cleanup();
  });

  it("empty hunks renders 'No changes.' text", () => {
    const el = renderDiff([]);
    expect(el.className).toBe("diff-view");
    expect(el.textContent).toBe("No changes.");
    expect(el.children).toHaveLength(0);
  });

  it("renders hunk header with correct line numbers", () => {
    const hunks: DiffHunk[] = [
      {
        oldStart: 0,
        newStart: 0,
        lines: [
          { type: "ctx", text: "hello" },
          { type: "del", text: "world" },
          { type: "add", text: "earth" },
        ],
      },
    ];
    const el = renderDiff(hunks);
    expect(el.className).toBe("diff-view");

    const hunkEl = el.querySelector(".diff-hunk")!;
    expect(hunkEl !== null).toBeTruthy();

    const header = hunkEl.querySelector(".diff-hunk-header")!;
    expect(header.textContent).toBe("@@ -1 +1 @@");

    const lines = hunkEl.querySelectorAll(".diff-line");
    expect(lines).toHaveLength(3);

    expect(lines[0]!.classList.contains("diff-ctx")).toBeTruthy();
    expect(lines[0]!.textContent).toContain("hello");

    expect(lines[1]!.classList.contains("diff-del")).toBeTruthy();
    expect(lines[1]!.textContent).toContain("-");
    expect(lines[1]!.textContent).toContain("world");

    expect(lines[2]!.classList.contains("diff-add")).toBeTruthy();
    expect(lines[2]!.textContent).toContain("+");
    expect(lines[2]!.textContent).toContain("earth");
  });

  it("renders multiple hunks", () => {
    const hunks: DiffHunk[] = [
      { oldStart: 0, newStart: 0, lines: [{ type: "del", text: "a" }] },
      { oldStart: 10, newStart: 10, lines: [{ type: "add", text: "b" }] },
    ];
    const el = renderDiff(hunks);
    const hunkEls = el.querySelectorAll(".diff-hunk");
    expect(hunkEls).toHaveLength(2);

    const headers = el.querySelectorAll(".diff-hunk-header");
    expect(headers[0]!.textContent).toBe("@@ -1 +1 @@");
    expect(headers[1]!.textContent).toBe("@@ -11 +11 @@");
  });
});
