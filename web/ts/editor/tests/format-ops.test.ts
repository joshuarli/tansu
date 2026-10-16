import { expect, describe, it } from "vitest";

import {
  toggleBold,
  toggleHeading,
  toggleHighlight,
  toggleItalic,
  toggleStrikethrough,
} from "../format-ops.ts";

describe("format operations", () => {
  it("wraps and unwraps single selections", () => {
    expect(toggleBold("hello", 0, 5)).toStrictEqual({ md: "**hello**", selStart: 2, selEnd: 7 });
    expect(toggleBold("**hello**", 2, 7)).toStrictEqual({ md: "hello", selStart: 0, selEnd: 5 });
    expect(toggleStrikethrough("hello", 0, 5).md).toBe("~~hello~~");
    expect(toggleHighlight("hello", 0, 5).md).toBe("==hello==");
  });

  it("handles italic without treating bold markers as italic wrappers", () => {
    expect(toggleItalic("hello", 0, 5)).toStrictEqual({ md: "*hello*", selStart: 1, selEnd: 6 });
    expect(toggleItalic("*hello*", 1, 6)).toStrictEqual({ md: "hello", selStart: 0, selEnd: 5 });
    expect(toggleItalic("**hello**", 2, 7)).toStrictEqual({
      md: "***hello***",
      selStart: 3,
      selEnd: 8,
    });
  });

  it("toggles markers across non-empty selected blocks", () => {
    expect(toggleBold("one\n\n\n\ntwo", 0, 10)).toStrictEqual({
      md: "**one**\n\n\n\n**two**",
      selStart: 0,
      selEnd: 18,
    });
    expect(toggleBold("**one**\n\n**two**", 0, 16)).toStrictEqual({
      md: "one\n\ntwo",
      selStart: 0,
      selEnd: 8,
    });
    expect(toggleItalic("*one*\n\n**two**", 0, 14).md).toBe("**one**\n\n***two***");
  });

  it("toggles heading levels at the current line", () => {
    expect(toggleHeading("one\ntwo", 4, 2)).toStrictEqual({
      md: "one\n## two",
      selStart: 7,
      selEnd: 7,
    });
    expect(toggleHeading("one\n## two", 7, 2)).toStrictEqual({
      md: "one\ntwo",
      selStart: 4,
      selEnd: 4,
    });
    expect(toggleHeading("### old", 4, 1)).toStrictEqual({
      md: "# old",
      selStart: 2,
      selEnd: 2,
    });
  });
});
