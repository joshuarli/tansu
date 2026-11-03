import { expect, describe, it } from "vitest";

import {
  toggleBold,
  toggleHeading,
  toggleHighlight,
  toggleItalic,
  toggleStrikethrough,
  type FormatResult,
} from "../format-ops.ts";

type FormatOp = (md: string, start: number, end: number) => FormatResult;

describe("format operations", () => {
  it("toggles inline markers and heading levels around the selection", () => {
    const cases: Array<[FormatOp, string, number, number, FormatResult]> = [
      [toggleBold, "hello", 0, 5, { md: "**hello**", selStart: 2, selEnd: 7 }],
      [toggleBold, "**hello**", 2, 7, { md: "hello", selStart: 0, selEnd: 5 }],
      [toggleStrikethrough, "hello", 0, 5, { md: "~~hello~~", selStart: 2, selEnd: 7 }],
      [toggleHighlight, "hello", 0, 5, { md: "==hello==", selStart: 2, selEnd: 7 }],
      [toggleItalic, "hello", 0, 5, { md: "*hello*", selStart: 1, selEnd: 6 }],
      [toggleItalic, "*hello*", 1, 6, { md: "hello", selStart: 0, selEnd: 5 }],
      [toggleItalic, "**hello**", 2, 7, { md: "***hello***", selStart: 3, selEnd: 8 }],
      [
        toggleBold,
        "one\n\n\n\ntwo",
        0,
        10,
        { md: "**one**\n\n\n\n**two**", selStart: 0, selEnd: 18 },
      ],
      [
        toggleBold,
        "**one**\n\n**two**",
        0,
        16,
        { md: "one\n\ntwo", selStart: 0, selEnd: 8 },
      ],
      [
        toggleItalic,
        "*one*\n\n**two**",
        0,
        14,
        { md: "**one**\n\n***two***", selStart: 0, selEnd: 18 },
      ],
    ];
    for (const [op, md, start, end, expected] of cases) {
      expect(op(md, start, end)).toStrictEqual(expected);
    }
  });

  it("toggles heading levels at the current line", () => {
    const cases: Array<[string, number, 1 | 2 | 3 | 4 | 5 | 6, FormatResult]> = [
      ["one\ntwo", 4, 2, { md: "one\n## two", selStart: 7, selEnd: 7 }],
      ["one\n## two", 7, 2, { md: "one\ntwo", selStart: 4, selEnd: 4 }],
      ["### old", 4, 1, { md: "# old", selStart: 2, selEnd: 2 }],
    ];
    for (const [md, start, level, expected] of cases) {
      expect(toggleHeading(md, start, level)).toStrictEqual(expected);
    }
  });
});
