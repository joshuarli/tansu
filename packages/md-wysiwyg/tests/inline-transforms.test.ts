import { describe, test, expect, beforeAll, afterAll } from "bun:test";

import {
  matchPattern,
  patterns,
  checkInlineTransform,
  computeReplaceRange,
  buildReplacementHtml,
} from "../src/inline-transforms.ts";
import type { InlinePattern } from "../src/inline-transforms.ts";
import { setupDOM } from "./test-helper.ts";

const bold = patterns[0]!;
const del_ = patterns[1]!;
const mark = patterns[2]!;
const code = patterns[3]!;
const em = patterns[4]!;

function m(text: string, pos: number, pat: InlinePattern) {
  return matchPattern(text, pos, pat);
}

describe("bold (**text**)", () => {
  test("bold basic", () => {
    expect(m("**bold**", 8, bold)?.content).toBe("bold");
  });
  test("bold start", () => {
    expect(m("**bold**", 8, bold)?.start).toBe(0);
  });
  test("bold mid-text", () => {
    expect(m("hello **world**", 15, bold)?.content).toBe("world");
  });
  test("bold single char", () => {
    expect(m("**a**", 5, bold)?.content).toBe("a");
  });
  test("bold empty content", () => {
    expect(m("****", 4, bold)).toBe(null);
  });
  test("bold leading space", () => {
    expect(m("** bold**", 9, bold)).toBe(null);
  });
  test("bold trailing space", () => {
    expect(m("**bold **", 9, bold)).toBe(null);
  });
  test("bold no opening pair", () => {
    expect(m("*bold**", 7, bold)).toBe(null);
  });
});

describe("italic (*text*)", () => {
  test("italic basic", () => {
    expect(m("*italic*", 8, em)?.content).toBe("italic");
  });
  test("italic single char", () => {
    expect(m("*a*", 3, em)?.content).toBe("a");
  });
  test("italic rejects ** closing", () => {
    expect(m("**bold**", 8, em)).toBe(null);
  });
  test("italic rejects ** opening", () => {
    expect(m("**bold*", 7, em)).toBe(null);
  });
  test("italic mid-text", () => {
    expect(m("hello *world*", 13, em)?.content).toBe("world");
  });
  test("italic leading space", () => {
    expect(m("* italic*", 9, em)).toBe(null);
  });
  test("italic trailing space", () => {
    expect(m("*italic *", 9, em)).toBe(null);
  });
});

describe("code (`text`)", () => {
  test("code basic (space trigger)", () => {
    expect(m("`code` ", 7, code)?.content).toBe("code");
  });
  test("code single char (space trigger)", () => {
    expect(m("hello `x` ", 10, code)?.content).toBe("x");
  });
  test("code nbsp trigger", () => {
    expect(m("`code`\u00A0", 7, code)?.content).toBe("code");
  });
  test("code no trailing space", () => {
    expect(m("`code`", 6, code)).toBe(null);
  });
  test("code empty", () => {
    expect(m("`` ", 3, code)).toBe(null);
  });
  test("triple backtick not matched as code", () => {
    expect(m("``` ", 4, code)).toBe(null);
  });
});

describe("strikethrough (~~text~~)", () => {
  test("del basic", () => {
    expect(m("~~strike~~", 10, del_)?.content).toBe("strike");
  });
  test("del empty", () => {
    expect(m("~~~~", 4, del_)).toBe(null);
  });
});

describe("highlight (==text==)", () => {
  test("mark basic", () => {
    expect(m("==mark==", 8, mark)?.content).toBe("mark");
  });
});

describe("cross-pattern", () => {
  test("no italic inside bold markers", () => {
    expect(m("**bold**", 8, em)).toBe(null);
  });

  test("bold matches before italic", () => {
    let matched = false;
    for (const pat of patterns) {
      const result = matchPattern("**bold**", 8, pat);
      if (result) {
        expect(pat.tag).toBe("strong");
        matched = true;
        break;
      }
    }
    expect(matched).toBe(true);
  });

  test("italic after bold text", () => {
    expect(m("**bold** then *italic*", 22, em)?.content).toBe("italic");
  });
});

describe("edge cases", () => {
  test("bold with trailing text", () => {
    expect(m("**bold** more", 8, bold)?.content).toBe("bold");
  });
  test("bold nearest match", () => {
    expect(m("a **b** c **d**", 15, bold)?.content).toBe("d");
  });
});

describe("computeReplaceRange", () => {
  test("non-trailingSpace: range ends at cursor", () => {
    const r = computeReplaceRange(bold, 5, 15);
    expect(r.start).toBe(5);
    expect(r.end).toBe(15);
  });

  test("trailingSpace: range ends one before cursor (excludes trailing space)", () => {
    const r = computeReplaceRange(code, 3, 10);
    expect(r.start).toBe(3);
    expect(r.end).toBe(9);
  });

  test("italic range", () => {
    const r = computeReplaceRange(em, 0, 8);
    expect(r.start).toBe(0);
    expect(r.end).toBe(8);
  });

  test("strikethrough range", () => {
    const r = computeReplaceRange(del_, 2, 12);
    expect(r.start).toBe(2);
    expect(r.end).toBe(12);
  });
});

describe("buildReplacementHtml", () => {
  test("bold wraps in strong with ZWS suffix", () => {
    const html = buildReplacementHtml(bold, "hello");
    expect(html).toBe("<strong>hello</strong>\u200B");
  });

  test("italic wraps in em with ZWS suffix", () => {
    const html = buildReplacementHtml(em, "world");
    expect(html).toBe("<em>world</em>\u200B");
  });

  test("code wraps in code without ZWS (trailingSpace)", () => {
    const html = buildReplacementHtml(code, "fn()");
    expect(html).toBe("<code>fn()</code>");
  });

  test("strikethrough wraps in del with ZWS", () => {
    const html = buildReplacementHtml(del_, "removed");
    expect(html).toBe("<del>removed</del>\u200B");
  });

  test("highlight wraps in mark with ZWS", () => {
    const html = buildReplacementHtml(mark, "important");
    expect(html).toBe("<mark>important</mark>\u200B");
  });

  test("escapes HTML in content", () => {
    const html = buildReplacementHtml(bold, "<script>&</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
    expect(html).not.toContain("<script>");
  });
});

describe("checkInlineTransform", () => {
  let cleanup: () => void;

  beforeAll(() => {
    cleanup = setupDOM();
  });

  afterAll(() => {
    cleanup();
  });

  test("returns false when no selection exists", () => {
    const result = checkInlineTransform();
    expect(result).toBe(false);
  });
});
