/// Tests for pure source-text format operations in format-ops.ts.

import {
  toggleBold,
  toggleItalic,
  toggleStrikethrough,
  toggleHighlight,
  clearInlineFormats,
  toggleHeading,
  toggleCodeFence,
  shiftIndent,
} from "@joshuarli98/md-wysiwyg";

describe("toggleBold", () => {
  it("wraps plain text selection with **", () => {
    const { md, selStart, selEnd } = toggleBold("hello world", 0, 5);
    expect(md).toBe("**hello** world");
    expect(selStart).toBe(2);
    expect(selEnd).toBe(7);
  });

  it("unwraps already-bold text", () => {
    // "**hello** world" — select inside the bold (offsets 2..7)
    const { md, selStart, selEnd } = toggleBold("**hello** world", 2, 7);
    expect(md).toBe("hello world");
    expect(selStart).toBe(0);
    expect(selEnd).toBe(5);
  });

  it("wraps selection in middle of string", () => {
    const { md, selStart, selEnd } = toggleBold("hello world", 6, 11);
    expect(md).toBe("hello **world**");
    expect(selStart).toBe(8);
    expect(selEnd).toBe(13);
  });

  it("empty selection still wraps", () => {
    const { md, selStart, selEnd } = toggleBold("hello", 2, 2);
    expect(md).toBe("he****llo");
    expect(selStart).toBe(4);
    expect(selEnd).toBe(4);
  });

  it("wraps entire string", () => {
    const { md, selStart, selEnd } = toggleBold("hello", 0, 5);
    expect(md).toBe("**hello**");
    expect(selStart).toBe(2);
    expect(selEnd).toBe(7);
  });

  it("wraps each block independently across paragraphs", () => {
    const { md, selStart, selEnd } = toggleBold("foo\n\nbar", 0, 8);
    expect(md).toBe("**foo**\n\n**bar**");
    expect(selStart).toBe(0);
    expect(selEnd).toBe(16);
  });

  it("unwraps each block independently across paragraphs", () => {
    const { md, selStart, selEnd } = toggleBold("**foo**\n\n**bar**", 0, 16);
    expect(md).toBe("foo\n\nbar");
    expect(selStart).toBe(0);
    expect(selEnd).toBe(8);
  });
});

describe("toggleItalic", () => {
  it("wraps plain text selection with *", () => {
    const { md, selStart, selEnd } = toggleItalic("hello world", 0, 5);
    expect(md).toBe("*hello* world");
    expect(selStart).toBe(1);
    expect(selEnd).toBe(6);
  });

  it("unwraps already-italic text", () => {
    const { md, selStart, selEnd } = toggleItalic("*hello* world", 1, 6);
    expect(md).toBe("hello world");
    expect(selStart).toBe(0);
    expect(selEnd).toBe(5);
  });

  it("does not false-trigger on ** (bold boundary)", () => {
    // Selection at 2..7 in "**hello**" — boundaries are **, not *
    // toggleItalic should still wrap (there's no italic at boundaries, only bold)
    const { md } = toggleItalic("**hello** world", 2, 7);
    // Should add italic markers inside the bold
    expect(md).toContain("*hello*");
  });

  it("does not unwrap italic when inside **bold**", () => {
    // "**hello**" — positions 2..7 surrounded by ** (bold), not * (italic)
    // So italic toggle-off should NOT trigger
    const { md } = toggleItalic("**hello**", 2, 7);
    // It should wrap with *, not strip (since the outer is ** not *)
    expect(md).toBe("***hello***");
  });

  it("wraps each block independently across paragraphs", () => {
    const { md, selStart, selEnd } = toggleItalic("foo\n\nbar", 0, 8);
    expect(md).toBe("*foo*\n\n*bar*");
    expect(selStart).toBe(0);
    expect(selEnd).toBe(12);
  });

  it("unwraps each block independently across paragraphs", () => {
    const { md, selStart, selEnd } = toggleItalic("*foo*\n\n*bar*", 0, 12);
    expect(md).toBe("foo\n\nbar");
    expect(selStart).toBe(0);
    expect(selEnd).toBe(8);
  });
});

describe("toggleStrikethrough", () => {
  it("wraps with ~~", () => {
    const { md, selStart, selEnd } = toggleStrikethrough("hello", 0, 5);
    expect(md).toBe("~~hello~~");
    expect(selStart).toBe(2);
    expect(selEnd).toBe(7);
  });

  it("unwraps ~~", () => {
    const { md, selStart, selEnd } = toggleStrikethrough("~~hello~~", 2, 7);
    expect(md).toBe("hello");
    expect(selStart).toBe(0);
    expect(selEnd).toBe(5);
  });

  it("wraps each block independently across paragraphs", () => {
    const { md, selStart, selEnd } = toggleStrikethrough("foo\n\nbar", 0, 8);
    expect(md).toBe("~~foo~~\n\n~~bar~~");
    expect(selStart).toBe(0);
    expect(selEnd).toBe(16);
  });

  it("unwraps each block independently across paragraphs", () => {
    const { md, selStart, selEnd } = toggleStrikethrough("~~foo~~\n\n~~bar~~", 0, 16);
    expect(md).toBe("foo\n\nbar");
    expect(selStart).toBe(0);
    expect(selEnd).toBe(8);
  });
});

describe("toggleHighlight", () => {
  it("wraps with ==", () => {
    const { md, selStart, selEnd } = toggleHighlight("hello", 0, 5);
    expect(md).toBe("==hello==");
    expect(selStart).toBe(2);
    expect(selEnd).toBe(7);
  });

  it("unwraps ==", () => {
    const { md, selStart, selEnd } = toggleHighlight("==hello==", 2, 7);
    expect(md).toBe("hello");
    expect(selStart).toBe(0);
    expect(selEnd).toBe(5);
  });

  it("wraps each block independently across paragraphs", () => {
    const { md, selStart, selEnd } = toggleHighlight("foo\n\nbar", 0, 8);
    expect(md).toBe("==foo==\n\n==bar==");
    expect(selStart).toBe(0);
    expect(selEnd).toBe(16);
  });

  it("unwraps each block independently across paragraphs", () => {
    const { md, selStart, selEnd } = toggleHighlight("==foo==\n\n==bar==", 0, 16);
    expect(md).toBe("foo\n\nbar");
    expect(selStart).toBe(0);
    expect(selEnd).toBe(8);
  });

  it("wraps only non-empty blocks when selection spans a blank line", () => {
    const { md } = toggleHighlight("foo\n\n\n\nbar", 0, 10);
    expect(md).toBe("==foo==\n\n\n\n==bar==");
  });
});

describe("clearInlineFormats", () => {
  it("strips bold markers from selection", () => {
    const src = "**bold** text";
    const { md, selStart, selEnd } = clearInlineFormats(src, 0, 8);
    expect(md).toBe("bold text");
    expect(selStart).toBe(0);
    expect(selEnd).toBe(4);
  });

  it("strips mixed markers", () => {
    const src = "**bold** and *italic* and ~~strike~~";
    const { md, selStart, selEnd } = clearInlineFormats(src, 0, src.length);
    expect(md).toBe("bold and italic and strike");
    expect(selStart).toBe(0);
    expect(selEnd).toBe("bold and italic and strike".length);
  });

  it("no-op on plain text", () => {
    const src = "plain text";
    const { md, selStart, selEnd } = clearInlineFormats(src, 0, src.length);
    expect(md).toBe("plain text");
    expect(selStart).toBe(0);
    expect(selEnd).toBe(10);
  });

  it("only strips within selection range", () => {
    const src = "hello **world** foo";
    const { md } = clearInlineFormats(src, 6, 15);
    // "**world**" stripped → "world"
    expect(md).toBe("hello world foo");
  });

  it("strips == (highlight)", () => {
    const { md } = clearInlineFormats("==hi==", 0, 6);
    expect(md).toBe("hi");
  });

  it("strips backtick (inline code)", () => {
    const { md } = clearInlineFormats("`code`", 0, 6);
    expect(md).toBe("code");
  });
});

describe("toggleHeading", () => {
  it("adds H1 to plain text line", () => {
    const { md, selStart } = toggleHeading("hello", 0, 1);
    expect(md).toBe("# hello");
    expect(selStart).toBe(2); // cursor shifts by 2 (len of "# ")
  });

  it("adds H2 to plain text line", () => {
    const { md } = toggleHeading("hello", 0, 2);
    expect(md).toBe("## hello");
  });

  it("changes H1 to H2", () => {
    const { md, selStart } = toggleHeading("# hello", 2, 2);
    expect(md).toBe("## hello");
    // Cursor was at 2 (after "# "), existing prefix "# " len=2, new "## " len=3, delta=1
    expect(selStart).toBe(3);
  });

  it("removes heading if same level clicked again", () => {
    const { md, selStart } = toggleHeading("# hello", 2, 1);
    expect(md).toBe("hello");
    // cursor was at 2, prefix removed (delta=-2), new pos=0
    expect(selStart).toBe(0);
  });

  it("works on second line when cursor is there", () => {
    const { md } = toggleHeading("first\nsecond", 6, 1);
    expect(md).toBe("first\n# second");
  });

  it("removes H3 when H3 clicked again", () => {
    const { md } = toggleHeading("### heading", 4, 3);
    expect(md).toBe("heading");
  });
});

describe("toggleCodeFence", () => {
  it("wraps selection with code fence", () => {
    const src = "line one\nline two\nline three";
    const { md, selStart, selEnd } = toggleCodeFence(src, 0, 8);
    expect(md).toBe("```\nline one\n```\nline two\nline three");
    expect(selStart).toBe(4); // shifted by "```\n" = 4 chars
    expect(selEnd).toBe(12);
  });

  it("wraps multi-line selection", () => {
    const src = "line one\nline two";
    const { md } = toggleCodeFence(src, 0, src.length);
    expect(md).toBe("```\nline one\nline two\n```");
  });

  it("unwraps existing code fence", () => {
    const src = "```\nsome code\n```";
    // Select the inner content at offset 4..13 ("some code")
    const { md, selStart, selEnd } = toggleCodeFence(src, 4, 13);
    expect(md).toBe("some code");
    expect(selStart).toBe(0);
    expect(selEnd).toBe(9);
  });
});

describe("shiftIndent", () => {
  it("indents a single line", () => {
    const { md, selStart, selEnd } = shiftIndent("hello", 0, 5, false);
    expect(md).toBe("\thello");
    expect(selStart).toBe(1);
    expect(selEnd).toBe(6);
  });

  it("dedents a single indented line", () => {
    const { md, selStart, selEnd } = shiftIndent("\thello", 0, 6, true);
    expect(md).toBe("hello");
    expect(selStart).toBe(0);
    expect(selEnd).toBe(5);
  });

  it("dedent no-op when no leading tab", () => {
    const { md } = shiftIndent("hello", 0, 5, true);
    expect(md).toBe("hello");
  });

  it("indents multiple lines", () => {
    const src = "line one\nline two";
    const { md } = shiftIndent(src, 0, src.length, false);
    expect(md).toBe("\tline one\n\tline two");
  });

  it("dedents multiple lines", () => {
    const src = "\tline one\n\tline two";
    const { md } = shiftIndent(src, 0, src.length, true);
    expect(md).toBe("line one\nline two");
  });

  it("dedent partially indented lines only removes where tab exists", () => {
    const src = "\tline one\nline two";
    const { md } = shiftIndent(src, 0, src.length, true);
    expect(md).toBe("line one\nline two");
  });

  it("selStart stays within document bounds after dedent", () => {
    const { selStart } = shiftIndent("\thello", 0, 6, true);
    expect(selStart).toBeGreaterThanOrEqual(0);
  });

  it("dedents nested list items by one list level, not all leading spaces", () => {
    const src = "- 1\n  - 2\n    - 3";
    const thirdLineStart = src.lastIndexOf("    - 3");
    const { md } = shiftIndent(src, thirdLineStart, src.length, true);
    expect(md).toBe("- 1\n  - 2\n  - 3");
  });

  it("dedents each selected nested list line by exactly one level", () => {
    const src = "- 1\n  - 2\n    - 3\n      - 4";
    const secondLineStart = src.indexOf("  - 2");
    const { md } = shiftIndent(src, secondLineStart, src.length, true);
    expect(md).toBe("- 1\n- 2\n  - 3\n    - 4");
  });

  it("dedent is a no-op for top-level list items", () => {
    const src = "- 1\n- 2";
    const secondLineStart = src.indexOf("- 2");
    const { md } = shiftIndent(src, secondLineStart, src.length, true);
    expect(md).toBe("- 1\n- 2");
  });
});
