import { describe, test, expect } from "vitest";

import { highlightCode } from "../src/highlight.ts";

describe("unknown language", () => {
  test("unknown lang escapes html", () => {
    expect(highlightCode("<div>", "unknown")).toContain("&lt;div&gt;");
  });
  test("unknown lang no spans", () => {
    expect(highlightCode("<div>", "unknown")).not.toContain("<span");
  });
});

describe("keywords", () => {
  test("js keyword", () => {
    expect(highlightCode("const x = 1;", "js")).toContain('<span class="hl-kw">const</span>');
  });
  test("rust keyword", () => {
    expect(highlightCode("fn main() {}", "rust")).toContain('<span class="hl-kw">fn</span>');
  });
  test("python keyword", () => {
    expect(highlightCode("def foo():", "python")).toContain('<span class="hl-kw">def</span>');
  });
  test("go keyword", () => {
    expect(highlightCode("func main() {}", "go")).toContain('<span class="hl-kw">func</span>');
  });
});

describe("types", () => {
  test("ts type", () => {
    expect(highlightCode('let x: string = ""', "ts")).toContain(
      '<span class="hl-type">string</span>',
    );
  });
  test("python type", () => {
    expect(highlightCode("None", "python")).toContain('<span class="hl-type">None</span>');
  });
});

describe("strings", () => {
  test("js string", () => {
    expect(highlightCode('let s = "hello"', "js")).toContain(
      '<span class="hl-str">&quot;hello&quot;</span>',
    );
  });
  test("js single-quote string", () => {
    expect(highlightCode("let s = 'hello'", "js")).toContain(
      "<span class=\"hl-str\">'hello'</span>",
    );
  });
});

describe("numbers", () => {
  test("js number", () => {
    expect(highlightCode("let x = 42", "js")).toContain('<span class="hl-num">42</span>');
  });
  test("js float", () => {
    expect(highlightCode("let x = 3.14", "js")).toContain('<span class="hl-num">3.14</span>');
  });
  test("js hex", () => {
    expect(highlightCode("let x = 0xFF", "js")).toContain('<span class="hl-num">0xFF</span>');
  });
});

describe("comments", () => {
  test("js line comment", () => {
    expect(highlightCode("// comment", "js")).toContain('<span class="hl-cmt">// comment</span>');
  });
  test("python comment", () => {
    expect(highlightCode("# comment", "python")).toContain('<span class="hl-cmt"># comment</span>');
  });
  test("js block comment", () => {
    expect(highlightCode("/* block */", "js")).toContain('<span class="hl-cmt">/* block */</span>');
  });
});

describe("function calls", () => {
  test("js function call", () => {
    expect(highlightCode("foo()", "js")).toContain('<span class="hl-fn">foo</span>');
  });
});

describe("rust macros", () => {
  test("rust macro", () => {
    expect(highlightCode('println!("hi")', "rust")).toContain(
      '<span class="hl-macro">println!</span>',
    );
  });
});

describe("constants", () => {
  test("constant", () => {
    expect(highlightCode("MAX_SIZE", "js")).toContain('<span class="hl-const">MAX_SIZE</span>');
  });
});

describe("operators", () => {
  test("js operator", () => {
    expect(highlightCode("a && b", "js")).toContain('<span class="hl-op">&amp;&amp;</span>');
  });
  test("js strict eq", () => {
    expect(highlightCode("a === b", "js")).toContain('<span class="hl-op">===</span>');
  });
  test("js arrow", () => {
    expect(highlightCode("x => x", "js")).toContain('<span class="hl-op">=&gt;</span>');
  });
});

describe("brackets", () => {
  test("brackets", () => {
    expect(highlightCode("()", "js")).toContain('<span class="hl-brk">()</span>');
  });
});

describe("HTML escaping", () => {
  test("html escape lt", () => {
    expect(highlightCode("x < y && z > 0", "js")).toContain("&lt;");
  });
  test("html escape gt", () => {
    expect(highlightCode("x < y && z > 0", "js")).toContain("&gt;");
  });
});

describe("multiline", () => {
  test("multiline block comment start", () => {
    const multiBlock = highlightCode("/* start\ncontinued\nend */", "js");
    expect(multiBlock).toContain('<span class="hl-cmt">/* start</span>');
  });
  test("multiline block comment middle", () => {
    const multiBlock = highlightCode("/* start\ncontinued\nend */", "js");
    expect(multiBlock).toContain('<span class="hl-cmt">continued</span>');
  });
  test("multiline block comment end", () => {
    const multiBlock = highlightCode("/* start\ncontinued\nend */", "js");
    expect(multiBlock).toContain('<span class="hl-cmt">end */</span>');
  });
  test("python triple-quote open", () => {
    const multiStr = highlightCode('x = """\nhello\n"""', "python");
    expect(multiStr).toContain('<span class="hl-str">&quot;&quot;&quot;</span>');
  });
  test("python triple-quote middle", () => {
    const multiStr = highlightCode('x = """\nhello\n"""', "python");
    expect(multiStr).toContain('<span class="hl-str">hello</span>');
  });
  test("template literal start", () => {
    const tmpl = highlightCode("let s = `line1\nline2`", "js");
    expect(tmpl).toContain('<span class="hl-str">`line1</span>');
  });
  test("template literal end", () => {
    const tmpl = highlightCode("let s = `line1\nline2`", "js");
    expect(tmpl).toContain('<span class="hl-str">line2`</span>');
  });
});

describe("string escapes", () => {
  test("escaped quote in string", () => {
    expect(highlightCode('let s = "a\\"b"', "js")).toContain(
      '<span class="hl-str">&quot;a\\&quot;b&quot;</span>',
    );
  });
});

describe("partial keyword match", () => {
  test("no partial keyword match", () => {
    expect(highlightCode("constant", "js")).not.toContain("hl-kw");
  });
});

describe("JSON", () => {
  test("json key string", () => {
    expect(highlightCode('{"key": "value"}', "json")).toContain(
      '<span class="hl-str">&quot;key&quot;</span>',
    );
  });
  test("json number", () => {
    expect(highlightCode('{"n": 123}', "json")).toContain('<span class="hl-num">123</span>');
  });
  test("json true", () => {
    expect(highlightCode('{"b": true}', "json")).toContain('<span class="hl-type">true</span>');
  });
  test("json null", () => {
    expect(highlightCode('{"b": null}', "json")).toContain('<span class="hl-type">null</span>');
  });
});

describe("YAML", () => {
  test("yaml comment", () => {
    expect(highlightCode("key: value # comment", "yaml")).toContain(
      '<span class="hl-cmt"># comment</span>',
    );
  });
  test("yaml bool", () => {
    expect(highlightCode("enabled: true", "yaml")).toContain('<span class="hl-type">true</span>');
  });
  test("yaml number", () => {
    expect(highlightCode("count: 42", "yaml")).toContain('<span class="hl-num">42</span>');
  });
});

describe("TOML", () => {
  test("toml comment", () => {
    expect(highlightCode("# comment", "toml")).toContain('<span class="hl-cmt"># comment</span>');
  });
  test("toml string", () => {
    expect(highlightCode('key = "value"', "toml")).toContain(
      '<span class="hl-str">&quot;value&quot;</span>',
    );
  });
});

describe("shell aliases", () => {
  test("sh keyword", () => {
    expect(highlightCode("if true; then echo hi; fi", "sh")).toContain(
      '<span class="hl-kw">if</span>',
    );
  });
  test("zsh keyword", () => {
    expect(highlightCode("export FOO=bar", "zsh")).toContain('<span class="hl-kw">export</span>');
  });
  test("shell keyword", () => {
    expect(highlightCode("export FOO=bar", "shell")).toContain('<span class="hl-kw">export</span>');
  });
});

describe("language aliases", () => {
  test("rs alias", () => {
    expect(highlightCode("fn main() {}", "rs")).toContain('<span class="hl-kw">fn</span>');
  });
  test("py alias", () => {
    expect(highlightCode("def f(): pass", "py")).toContain('<span class="hl-kw">def</span>');
  });
  test("golang alias", () => {
    expect(highlightCode("package main", "golang")).toContain('<span class="hl-kw">package</span>');
  });
});

describe("C/C++", () => {
  test("c type", () => {
    expect(highlightCode("int main() {}", "c")).toContain('<span class="hl-type">int</span>');
  });
  test("cpp keyword", () => {
    expect(highlightCode("return 0;", "cpp")).toContain('<span class="hl-kw">return</span>');
  });
});

describe("edge cases", () => {
  test("empty input", () => {
    expect(highlightCode("", "js")).toBe("");
  });
  test("no lang passthrough", () => {
    expect(highlightCode("hello", "")).toBe("hello");
  });
});
