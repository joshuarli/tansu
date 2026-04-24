/// Tests for pure source-text format operations in format-ops.ts.

import { describe, test, expect } from "vitest";

import {
  toggleBold,
  toggleItalic,
  toggleStrikethrough,
  toggleHighlight,
  clearInlineFormats,
  toggleHeading,
  toggleCodeFence,
  shiftIndent,
} from "./format-ops.ts";

describe("toggleBold", () => {
  test("wraps plain text selection with **", () => {
    const { md, selStart, selEnd } = toggleBold("hello world", 0, 5);
    expect(md).toBe("**hello** world");
    expect(selStart).toBe(2);
    expect(selEnd).toBe(7);
  });

  test("unwraps already-bold text", () => {
    // "**hello** world" — select inside the bold (offsets 2..7)
    const { md, selStart, selEnd } = toggleBold("**hello** world", 2, 7);
    expect(md).toBe("hello world");
    expect(selStart).toBe(0);
    expect(selEnd).toBe(5);
  });

  test("wraps selection in middle of string", () => {
    const { md, selStart, selEnd } = toggleBold("hello world", 6, 11);
    expect(md).toBe("hello **world**");
    expect(selStart).toBe(8);
    expect(selEnd).toBe(13);
  });

  test("empty selection still wraps", () => {
    const { md, selStart, selEnd } = toggleBold("hello", 2, 2);
    expect(md).toBe("he****llo");
    expect(selStart).toBe(4);
    expect(selEnd).toBe(4);
  });

  test("wraps entire string", () => {
    const { md, selStart, selEnd } = toggleBold("hello", 0, 5);
    expect(md).toBe("**hello**");
    expect(selStart).toBe(2);
    expect(selEnd).toBe(7);
  });
});

describe("toggleItalic", () => {
  test("wraps plain text selection with *", () => {
    const { md, selStart, selEnd } = toggleItalic("hello world", 0, 5);
    expect(md).toBe("*hello* world");
    expect(selStart).toBe(1);
    expect(selEnd).toBe(6);
  });

  test("unwraps already-italic text", () => {
    const { md, selStart, selEnd } = toggleItalic("*hello* world", 1, 6);
    expect(md).toBe("hello world");
    expect(selStart).toBe(0);
    expect(selEnd).toBe(5);
  });

  test("does not false-trigger on ** (bold boundary)", () => {
    // Selection at 2..7 in "**hello**" — boundaries are **, not *
    // toggleItalic should still wrap (there's no italic at boundaries, only bold)
    const { md } = toggleItalic("**hello** world", 2, 7);
    // Should add italic markers inside the bold
    expect(md).toContain("*hello*");
  });

  test("does not unwrap italic when inside **bold**", () => {
    // "**hello**" — positions 2..7 surrounded by ** (bold), not * (italic)
    // So italic toggle-off should NOT trigger
    const { md } = toggleItalic("**hello**", 2, 7);
    // It should wrap with *, not strip (since the outer is ** not *)
    expect(md).toBe("***hello***");
  });
});

describe("toggleStrikethrough", () => {
  test("wraps with ~~", () => {
    const { md, selStart, selEnd } = toggleStrikethrough("hello", 0, 5);
    expect(md).toBe("~~hello~~");
    expect(selStart).toBe(2);
    expect(selEnd).toBe(7);
  });

  test("unwraps ~~", () => {
    const { md, selStart, selEnd } = toggleStrikethrough("~~hello~~", 2, 7);
    expect(md).toBe("hello");
    expect(selStart).toBe(0);
    expect(selEnd).toBe(5);
  });
});

describe("toggleHighlight", () => {
  test("wraps with ==", () => {
    const { md, selStart, selEnd } = toggleHighlight("hello", 0, 5);
    expect(md).toBe("==hello==");
    expect(selStart).toBe(2);
    expect(selEnd).toBe(7);
  });

  test("unwraps ==", () => {
    const { md, selStart, selEnd } = toggleHighlight("==hello==", 2, 7);
    expect(md).toBe("hello");
    expect(selStart).toBe(0);
    expect(selEnd).toBe(5);
  });
});

describe("clearInlineFormats", () => {
  test("strips bold markers from selection", () => {
    const src = "**bold** text";
    const { md, selStart, selEnd } = clearInlineFormats(src, 0, 8);
    expect(md).toBe("bold text");
    expect(selStart).toBe(0);
    expect(selEnd).toBe(4);
  });

  test("strips mixed markers", () => {
    const src = "**bold** and *italic* and ~~strike~~";
    const { md, selStart, selEnd } = clearInlineFormats(src, 0, src.length);
    expect(md).toBe("bold and italic and strike");
    expect(selStart).toBe(0);
    expect(selEnd).toBe("bold and italic and strike".length);
  });

  test("no-op on plain text", () => {
    const src = "plain text";
    const { md, selStart, selEnd } = clearInlineFormats(src, 0, src.length);
    expect(md).toBe("plain text");
    expect(selStart).toBe(0);
    expect(selEnd).toBe(10);
  });

  test("only strips within selection range", () => {
    const src = "hello **world** foo";
    const { md } = clearInlineFormats(src, 6, 15);
    // "**world**" stripped → "world"
    expect(md).toBe("hello world foo");
  });

  test("strips == (highlight)", () => {
    const { md } = clearInlineFormats("==hi==", 0, 6);
    expect(md).toBe("hi");
  });

  test("strips backtick (inline code)", () => {
    const { md } = clearInlineFormats("`code`", 0, 6);
    expect(md).toBe("code");
  });
});

describe("toggleHeading", () => {
  test("adds H1 to plain text line", () => {
    const { md, selStart } = toggleHeading("hello", 0, 1);
    expect(md).toBe("# hello");
    expect(selStart).toBe(2); // cursor shifts by 2 (len of "# ")
  });

  test("adds H2 to plain text line", () => {
    const { md } = toggleHeading("hello", 0, 2);
    expect(md).toBe("## hello");
  });

  test("changes H1 to H2", () => {
    const { md, selStart } = toggleHeading("# hello", 2, 2);
    expect(md).toBe("## hello");
    // Cursor was at 2 (after "# "), existing prefix "# " len=2, new "## " len=3, delta=1
    expect(selStart).toBe(3);
  });

  test("removes heading if same level clicked again", () => {
    const { md, selStart } = toggleHeading("# hello", 2, 1);
    expect(md).toBe("hello");
    // cursor was at 2, prefix removed (delta=-2), new pos=0
    expect(selStart).toBe(0);
  });

  test("works on second line when cursor is there", () => {
    const { md } = toggleHeading("first\nsecond", 6, 1);
    expect(md).toBe("first\n# second");
  });

  test("removes H3 when H3 clicked again", () => {
    const { md } = toggleHeading("### heading", 4, 3);
    expect(md).toBe("heading");
  });
});

describe("toggleCodeFence", () => {
  test("wraps selection with code fence", () => {
    const src = "line one\nline two\nline three";
    const { md, selStart, selEnd } = toggleCodeFence(src, 0, 8);
    expect(md).toBe("```\nline one\n```\nline two\nline three");
    expect(selStart).toBe(4); // shifted by "```\n" = 4 chars
    expect(selEnd).toBe(12);
  });

  test("wraps multi-line selection", () => {
    const src = "line one\nline two";
    const { md } = toggleCodeFence(src, 0, src.length);
    expect(md).toBe("```\nline one\nline two\n```");
  });

  test("unwraps existing code fence", () => {
    const src = "```\nsome code\n```";
    // Select the inner content at offset 4..13 ("some code")
    const { md, selStart, selEnd } = toggleCodeFence(src, 4, 13);
    expect(md).toBe("some code");
    expect(selStart).toBe(0);
    expect(selEnd).toBe(9);
  });
});

describe("shiftIndent", () => {
  test("indents a single line", () => {
    const { md, selStart, selEnd } = shiftIndent("hello", 0, 5, false);
    expect(md).toBe("\thello");
    expect(selStart).toBe(1);
    expect(selEnd).toBe(6);
  });

  test("dedents a single indented line", () => {
    const { md, selStart, selEnd } = shiftIndent("\thello", 0, 6, true);
    expect(md).toBe("hello");
    expect(selStart).toBe(0);
    expect(selEnd).toBe(5);
  });

  test("dedent no-op when no leading tab", () => {
    const { md } = shiftIndent("hello", 0, 5, true);
    expect(md).toBe("hello");
  });

  test("indents multiple lines", () => {
    const src = "line one\nline two";
    const { md } = shiftIndent(src, 0, src.length, false);
    expect(md).toBe("\tline one\n\tline two");
  });

  test("dedents multiple lines", () => {
    const src = "\tline one\n\tline two";
    const { md } = shiftIndent(src, 0, src.length, true);
    expect(md).toBe("line one\nline two");
  });

  test("dedent partially indented lines only removes where tab exists", () => {
    const src = "\tline one\nline two";
    const { md } = shiftIndent(src, 0, src.length, true);
    expect(md).toBe("line one\nline two");
  });

  test("selStart stays within document bounds after dedent", () => {
    const { selStart } = shiftIndent("\thello", 0, 6, true);
    expect(selStart).toBeGreaterThanOrEqual(0);
  });
});
