import { describe, test, expect } from "vitest";

import { merge3 } from "../src/merge.ts";

describe("merge3", () => {
  test("no changes", () => {
    expect(merge3("a\nb\nc", "a\nb\nc", "a\nb\nc")).toBe("a\nb\nc");
  });
  test("ours changed", () => {
    expect(merge3("a\nb\nc", "a\nB\nc", "a\nb\nc")).toBe("a\nB\nc");
  });
  test("theirs changed", () => {
    expect(merge3("a\nb\nc", "a\nb\nc", "a\nB\nc")).toBe("a\nB\nc");
  });
  test("both changed different lines", () => {
    expect(merge3("a\nb\nc", "A\nb\nc", "a\nb\nC")).toBe("A\nb\nC");
  });
  test("both changed same line same way", () => {
    expect(merge3("a\nb\nc", "a\nX\nc", "a\nX\nc")).toBe("a\nX\nc");
  });
  test("conflict same line", () => {
    expect(merge3("a\nb\nc", "a\nX\nc", "a\nY\nc")).toBe(null);
  });
  test("ours deleted line", () => {
    expect(merge3("a\nb\nc", "a\nc", "a\nb\nc")).toBe("a\nc");
  });
  test("theirs deleted line", () => {
    expect(merge3("a\nb\nc", "a\nb\nc", "a\nc")).toBe("a\nc");
  });
  test("both deleted same line", () => {
    expect(merge3("a\nb\nc", "a\nc", "a\nc")).toBe("a\nc");
  });
  test("ours added at end", () => {
    expect(merge3("a\nb", "a\nb\nc\nd", "a\nb")).toBe("a\nb\nc\nd");
  });
  test("theirs added at end", () => {
    expect(merge3("a\nb", "a\nb", "a\nb\nc\nd")).toBe("a\nb\nc\nd");
  });
  test("both added same at end", () => {
    expect(merge3("a\nb", "a\nb\nc", "a\nb\nc")).toBe("a\nb\nc");
  });
  test("both added different at end", () => {
    expect(merge3("a\nb", "a\nb\nc", "a\nb\nd")).toBe(null);
  });
  test("empty base ours added", () => {
    expect(merge3("", "hello", "")).toBe("hello");
  });
  test("empty base theirs added", () => {
    expect(merge3("", "", "hello")).toBe("hello");
  });
  test("single line ours", () => {
    expect(merge3("old", "new", "old")).toBe("new");
  });
  test("single line theirs", () => {
    expect(merge3("old", "old", "new")).toBe("new");
  });
  test("single line both same", () => {
    expect(merge3("old", "new", "new")).toBe("new");
  });
  test("single line conflict", () => {
    expect(merge3("old", "a", "b")).toBe(null);
  });
  test("replace different lines", () => {
    expect(merge3("a\nb\nc\nd", "A\nb\nc\nd", "a\nb\nc\nD")).toBe("A\nb\nc\nD");
  });
  test("ours replaces all", () => {
    expect(merge3("a\nb\nc", "A\nB\nC", "a\nb\nc")).toBe("A\nB\nC");
  });
  test("theirs replaces all", () => {
    expect(merge3("a\nb\nc", "a\nb\nc", "X\nY\nZ")).toBe("X\nY\nZ");
  });
  test("both replace all same", () => {
    expect(merge3("a\nb\nc", "X\nY\nZ", "X\nY\nZ")).toBe("X\nY\nZ");
  });
  test("both replace all different", () => {
    expect(merge3("a\nb\nc", "X\nY\nZ", "A\nB\nC")).toBe(null);
  });
  test("ours deleted first", () => {
    expect(merge3("a\nb\nc", "b\nc", "a\nb\nc")).toBe("b\nc");
  });
  test("ours deleted last", () => {
    expect(merge3("a\nb\nc", "a\nb", "a\nb\nc")).toBe("a\nb");
  });
  test("ours added at start", () => {
    expect(merge3("b\nc", "a\nb\nc", "b\nc")).toBe("a\nb\nc");
  });
  test("ours edits theirs appends", () => {
    expect(merge3("a\nb", "A\nb", "a\nb\nc")).toBe("A\nb\nc");
  });
  test("all empty", () => {
    expect(merge3("", "", "")).toBe("");
  });
});
