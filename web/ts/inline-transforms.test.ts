import { matchPattern, patterns } from "./inline-transforms.ts";
import type { InlinePattern } from "./inline-transforms.ts";
import { assertEqual } from "./test-helper.ts";

const bold = patterns[0]!;
const del_ = patterns[1]!;
const mark = patterns[2]!;
const code = patterns[3]!;
const em = patterns[4]!;

function m(text: string, pos: number, pat: InlinePattern) {
  return matchPattern(text, pos, pat);
}

// Bold: **text**
assertEqual(m("**bold**", 8, bold)?.content, "bold", "bold basic");
assertEqual(m("**bold**", 8, bold)?.start, 0, "bold start");
assertEqual(m("hello **world**", 15, bold)?.content, "world", "bold mid-text");
assertEqual(m("**a**", 5, bold)?.content, "a", "bold single char");
assertEqual(m("****", 4, bold), null, "bold empty content");
assertEqual(m("** bold**", 9, bold), null, "bold leading space");
assertEqual(m("**bold **", 9, bold), null, "bold trailing space");
assertEqual(m("*bold**", 7, bold), null, "bold no opening pair");

// Italic: *text*
assertEqual(m("*italic*", 8, em)?.content, "italic", "italic basic");
assertEqual(m("*a*", 3, em)?.content, "a", "italic single char");
assertEqual(m("**bold**", 8, em), null, "italic rejects ** closing");
assertEqual(m("**bold*", 7, em), null, "italic rejects ** opening");
assertEqual(m("hello *world*", 13, em)?.content, "world", "italic mid-text");
assertEqual(m("* italic*", 9, em), null, "italic leading space");
assertEqual(m("*italic *", 9, em), null, "italic trailing space");

// Code: `text` (requires trailing space)
assertEqual(m("`code` ", 7, code)?.content, "code", "code basic (space trigger)");
assertEqual(m("hello `x` ", 10, code)?.content, "x", "code single char (space trigger)");
assertEqual(m("`code`\u00A0", 7, code)?.content, "code", "code nbsp trigger");
assertEqual(m("`code`", 6, code), null, "code no trailing space");
assertEqual(m("`` ", 3, code), null, "code empty");
assertEqual(m("``` ", 4, code), null, "triple backtick not matched as code");

// Strikethrough: ~~text~~
assertEqual(m("~~strike~~", 10, del_)?.content, "strike", "del basic");
assertEqual(m("~~~~", 4, del_), null, "del empty");

// Highlight: ==text==
assertEqual(m("==mark==", 8, mark)?.content, "mark", "mark basic");

// Cross-pattern: ** should not match as two separate *
assertEqual(m("**bold**", 8, em), null, "no italic inside bold markers");

// Pattern order: bold takes priority over italic
let matched = false;
for (const pat of patterns) {
  const result = matchPattern("**bold**", 8, pat);
  if (result) {
    assertEqual(pat.tag, "strong", "bold matches before italic");
    matched = true;
    break;
  }
}
assertEqual(matched, true, "some pattern matched **bold**");

// Nested scenario: *italic* after **bold** text
assertEqual(m("**bold** then *italic*", 22, em)?.content, "italic", "italic after bold text");

// Edge: cursor not at end of match
assertEqual(m("**bold** more", 8, bold)?.content, "bold", "bold with trailing text");

// Edge: marker appears multiple times — match closest
assertEqual(m("a **b** c **d**", 15, bold)?.content, "d", "bold nearest match");

console.log("All inline-transforms tests passed");
