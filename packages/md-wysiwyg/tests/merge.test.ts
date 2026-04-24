import { merge3 } from "../src/merge.ts";

describe("merge3", () => {
  it("no changes", () => {
    expect(merge3("a\nb\nc", "a\nb\nc", "a\nb\nc")).toBe("a\nb\nc");
  });
  it("ours changed", () => {
    expect(merge3("a\nb\nc", "a\nB\nc", "a\nb\nc")).toBe("a\nB\nc");
  });
  it("theirs changed", () => {
    expect(merge3("a\nb\nc", "a\nb\nc", "a\nB\nc")).toBe("a\nB\nc");
  });
  it("both changed different lines", () => {
    expect(merge3("a\nb\nc", "A\nb\nc", "a\nb\nC")).toBe("A\nb\nC");
  });
  it("both changed same line same way", () => {
    expect(merge3("a\nb\nc", "a\nX\nc", "a\nX\nc")).toBe("a\nX\nc");
  });
  it("conflict same line", () => {
    expect(merge3("a\nb\nc", "a\nX\nc", "a\nY\nc")).toBeNull();
  });
  it("ours deleted line", () => {
    expect(merge3("a\nb\nc", "a\nc", "a\nb\nc")).toBe("a\nc");
  });
  it("theirs deleted line", () => {
    expect(merge3("a\nb\nc", "a\nb\nc", "a\nc")).toBe("a\nc");
  });
  it("both deleted same line", () => {
    expect(merge3("a\nb\nc", "a\nc", "a\nc")).toBe("a\nc");
  });
  it("ours added at end", () => {
    expect(merge3("a\nb", "a\nb\nc\nd", "a\nb")).toBe("a\nb\nc\nd");
  });
  it("theirs added at end", () => {
    expect(merge3("a\nb", "a\nb", "a\nb\nc\nd")).toBe("a\nb\nc\nd");
  });
  it("both added same at end", () => {
    expect(merge3("a\nb", "a\nb\nc", "a\nb\nc")).toBe("a\nb\nc");
  });
  it("both added different at end", () => {
    expect(merge3("a\nb", "a\nb\nc", "a\nb\nd")).toBeNull();
  });
  it("empty base ours added", () => {
    expect(merge3("", "hello", "")).toBe("hello");
  });
  it("empty base theirs added", () => {
    expect(merge3("", "", "hello")).toBe("hello");
  });
  it("single line ours", () => {
    expect(merge3("old", "new", "old")).toBe("new");
  });
  it("single line theirs", () => {
    expect(merge3("old", "old", "new")).toBe("new");
  });
  it("single line both same", () => {
    expect(merge3("old", "new", "new")).toBe("new");
  });
  it("single line conflict", () => {
    expect(merge3("old", "a", "b")).toBeNull();
  });
  it("replace different lines", () => {
    expect(merge3("a\nb\nc\nd", "A\nb\nc\nd", "a\nb\nc\nD")).toBe("A\nb\nc\nD");
  });
  it("ours replaces all", () => {
    expect(merge3("a\nb\nc", "A\nB\nC", "a\nb\nc")).toBe("A\nB\nC");
  });
  it("theirs replaces all", () => {
    expect(merge3("a\nb\nc", "a\nb\nc", "X\nY\nZ")).toBe("X\nY\nZ");
  });
  it("both replace all same", () => {
    expect(merge3("a\nb\nc", "X\nY\nZ", "X\nY\nZ")).toBe("X\nY\nZ");
  });
  it("both replace all different", () => {
    expect(merge3("a\nb\nc", "X\nY\nZ", "A\nB\nC")).toBeNull();
  });
  it("ours deleted first", () => {
    expect(merge3("a\nb\nc", "b\nc", "a\nb\nc")).toBe("b\nc");
  });
  it("ours deleted last", () => {
    expect(merge3("a\nb\nc", "a\nb", "a\nb\nc")).toBe("a\nb");
  });
  it("ours added at start", () => {
    expect(merge3("b\nc", "a\nb\nc", "b\nc")).toBe("a\nb\nc");
  });
  it("ours edits theirs appends", () => {
    expect(merge3("a\nb", "A\nb", "a\nb\nc")).toBe("A\nb\nc");
  });
  it("all empty", () => {
    expect(merge3("", "", "")).toBe("");
  });
});
