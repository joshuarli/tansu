import {
  matchPattern,
  patterns,
  checkInlineTransform,
  computeReplaceRange,
  buildReplacementHtml,
  type InlinePattern,
} from "../src/inline-transforms.ts";
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
  it("bold basic", () => {
    expect(m("**bold**", 8, bold)?.content).toBe("bold");
  });
  it("bold start", () => {
    expect(m("**bold**", 8, bold)?.start).toBe(0);
  });
  it("bold mid-text", () => {
    expect(m("hello **world**", 15, bold)?.content).toBe("world");
  });
  it("bold single char", () => {
    expect(m("**a**", 5, bold)?.content).toBe("a");
  });
  it("bold empty content", () => {
    expect(m("****", 4, bold)).toBeNull();
  });
  it("bold leading space", () => {
    expect(m("** bold**", 9, bold)).toBeNull();
  });
  it("bold trailing space", () => {
    expect(m("**bold **", 9, bold)).toBeNull();
  });
  it("bold no opening pair", () => {
    expect(m("*bold**", 7, bold)).toBeNull();
  });
});

describe("italic (*text*)", () => {
  it("italic basic", () => {
    expect(m("*italic*", 8, em)?.content).toBe("italic");
  });
  it("italic single char", () => {
    expect(m("*a*", 3, em)?.content).toBe("a");
  });
  it("italic rejects ** closing", () => {
    expect(m("**bold**", 8, em)).toBeNull();
  });
  it("italic rejects ** opening", () => {
    expect(m("**bold*", 7, em)).toBeNull();
  });
  it("italic mid-text", () => {
    expect(m("hello *world*", 13, em)?.content).toBe("world");
  });
  it("italic leading space", () => {
    expect(m("* italic*", 9, em)).toBeNull();
  });
  it("italic trailing space", () => {
    expect(m("*italic *", 9, em)).toBeNull();
  });
});

describe("code (`text`)", () => {
  it("code basic (space trigger)", () => {
    expect(m("`code` ", 7, code)?.content).toBe("code");
  });
  it("code single char (space trigger)", () => {
    expect(m("hello `x` ", 10, code)?.content).toBe("x");
  });
  it("code nbsp trigger", () => {
    expect(m("`code`\u00A0", 7, code)?.content).toBe("code");
  });
  it("code no trailing space", () => {
    expect(m("`code`", 6, code)).toBeNull();
  });
  it("code empty", () => {
    expect(m("`` ", 3, code)).toBeNull();
  });
  it("triple backtick not matched as code", () => {
    expect(m("``` ", 4, code)).toBeNull();
  });
});

describe("strikethrough (~~text~~)", () => {
  it("del basic", () => {
    expect(m("~~strike~~", 10, del_)?.content).toBe("strike");
  });
  it("del empty", () => {
    expect(m("~~~~", 4, del_)).toBeNull();
  });
});

describe("highlight (==text==)", () => {
  it("mark basic", () => {
    expect(m("==mark==", 8, mark)?.content).toBe("mark");
  });
});

describe("cross-pattern", () => {
  it("no italic inside bold markers", () => {
    expect(m("**bold**", 8, em)).toBeNull();
  });

  it("bold matches before italic", () => {
    let matched = false;
    for (const pat of patterns) {
      const result = matchPattern("**bold**", 8, pat);
      if (result) {
        expect(pat.tag).toBe("strong");
        matched = true;
        break;
      }
    }
    expect(matched).toBeTruthy();
  });

  it("italic after bold text", () => {
    expect(m("**bold** then *italic*", 22, em)?.content).toBe("italic");
  });
});

describe("edge cases", () => {
  it("bold with trailing text", () => {
    expect(m("**bold** more", 8, bold)?.content).toBe("bold");
  });
  it("bold nearest match", () => {
    expect(m("a **b** c **d**", 15, bold)?.content).toBe("d");
  });
});

describe("computeReplaceRange", () => {
  it("non-trailingSpace: range ends at cursor", () => {
    const r = computeReplaceRange(bold, 5, 15);
    expect(r.start).toBe(5);
    expect(r.end).toBe(15);
  });

  it("trailingSpace: range ends one before cursor (excludes trailing space)", () => {
    const r = computeReplaceRange(code, 3, 10);
    expect(r.start).toBe(3);
    expect(r.end).toBe(9);
  });

  it("italic range", () => {
    const r = computeReplaceRange(em, 0, 8);
    expect(r.start).toBe(0);
    expect(r.end).toBe(8);
  });

  it("strikethrough range", () => {
    const r = computeReplaceRange(del_, 2, 12);
    expect(r.start).toBe(2);
    expect(r.end).toBe(12);
  });
});

describe("buildReplacementHtml", () => {
  it("bold wraps in strong with ZWS suffix", () => {
    const html = buildReplacementHtml(bold, "hello");
    expect(html).toBe("<strong>hello</strong>\u200B");
  });

  it("italic wraps in em with ZWS suffix", () => {
    const html = buildReplacementHtml(em, "world");
    expect(html).toBe("<em>world</em>\u200B");
  });

  it("code wraps in code without ZWS (trailingSpace)", () => {
    const html = buildReplacementHtml(code, "fn()");
    expect(html).toBe("<code>fn()</code>");
  });

  it("strikethrough wraps in del with ZWS", () => {
    const html = buildReplacementHtml(del_, "removed");
    expect(html).toBe("<del>removed</del>\u200B");
  });

  it("highlight wraps in mark with ZWS", () => {
    const html = buildReplacementHtml(mark, "important");
    expect(html).toBe("<mark>important</mark>\u200B");
  });

  it("escapes HTML in content", () => {
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

  it("returns null when no selection exists", () => {
    const result = checkInlineTransform();
    expect(result).toBeNull();
  });

  it("clamps stale selection offsets after DOM mutation", () => {
    const host = document.createElement("div");
    const text = document.createTextNode("plain");
    host.append(text);
    document.body.append(host);

    const sel = window.getSelection()!;
    const range = document.createRange();
    range.setStart(text, text.length);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);

    Object.defineProperty(sel, "anchorOffset", {
      configurable: true,
      get: () => 999,
    });

    expect(() => checkInlineTransform()).not.toThrow();
    expect(checkInlineTransform()).toBeNull();

    host.remove();
  });
});
