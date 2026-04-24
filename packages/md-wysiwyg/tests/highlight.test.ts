import { highlightCode } from "../src/highlight.ts";

describe("unknown language", () => {
  it("unknown lang escapes html", () => {
    expect(highlightCode("<div>", "unknown")).toContain("&lt;div&gt;");
  });
  it("unknown lang no spans", () => {
    expect(highlightCode("<div>", "unknown")).not.toContain("<span");
  });
});

describe("keywords", () => {
  it("js keyword", () => {
    expect(highlightCode("const x = 1;", "js")).toContain('<span class="hl-kw">const</span>');
  });
  it("rust keyword", () => {
    expect(highlightCode("fn main() {}", "rust")).toContain('<span class="hl-kw">fn</span>');
  });
  it("python keyword", () => {
    expect(highlightCode("def foo():", "python")).toContain('<span class="hl-kw">def</span>');
  });
  it("go keyword", () => {
    expect(highlightCode("func main() {}", "go")).toContain('<span class="hl-kw">func</span>');
  });
});

describe("types", () => {
  it("ts type", () => {
    expect(highlightCode('let x: string = ""', "ts")).toContain(
      '<span class="hl-type">string</span>',
    );
  });
  it("python type", () => {
    expect(highlightCode("None", "python")).toContain('<span class="hl-type">None</span>');
  });
});

describe("strings", () => {
  it("js string", () => {
    expect(highlightCode('let s = "hello"', "js")).toContain(
      '<span class="hl-str">&quot;hello&quot;</span>',
    );
  });
  it("js single-quote string", () => {
    expect(highlightCode("let s = 'hello'", "js")).toContain(
      "<span class=\"hl-str\">'hello'</span>",
    );
  });
});

describe("numbers", () => {
  it("js number", () => {
    expect(highlightCode("let x = 42", "js")).toContain('<span class="hl-num">42</span>');
  });
  it("js float", () => {
    expect(highlightCode("let x = 3.14", "js")).toContain('<span class="hl-num">3.14</span>');
  });
  it("js hex", () => {
    expect(highlightCode("let x = 0xFF", "js")).toContain('<span class="hl-num">0xFF</span>');
  });
});

describe("comments", () => {
  it("js line comment", () => {
    expect(highlightCode("// comment", "js")).toContain('<span class="hl-cmt">// comment</span>');
  });
  it("python comment", () => {
    expect(highlightCode("# comment", "python")).toContain('<span class="hl-cmt"># comment</span>');
  });
  it("js block comment", () => {
    expect(highlightCode("/* block */", "js")).toContain('<span class="hl-cmt">/* block */</span>');
  });
});

describe("function calls", () => {
  it("js function call", () => {
    expect(highlightCode("foo()", "js")).toContain('<span class="hl-fn">foo</span>');
  });
});

describe("rust macros", () => {
  it("rust macro", () => {
    expect(highlightCode('println!("hi")', "rust")).toContain(
      '<span class="hl-macro">println!</span>',
    );
  });
});

describe("constants", () => {
  it("constant", () => {
    expect(highlightCode("MAX_SIZE", "js")).toContain('<span class="hl-const">MAX_SIZE</span>');
  });
});

describe("operators", () => {
  it("js operator", () => {
    expect(highlightCode("a && b", "js")).toContain('<span class="hl-op">&amp;&amp;</span>');
  });
  it("js strict eq", () => {
    expect(highlightCode("a === b", "js")).toContain('<span class="hl-op">===</span>');
  });
  it("js arrow", () => {
    expect(highlightCode("x => x", "js")).toContain('<span class="hl-op">=&gt;</span>');
  });
});

describe("brackets", () => {
  it("brackets", () => {
    expect(highlightCode("()", "js")).toContain('<span class="hl-brk">()</span>');
  });
});

describe("HTML escaping", () => {
  it("html escape lt", () => {
    expect(highlightCode("x < y && z > 0", "js")).toContain("&lt;");
  });
  it("html escape gt", () => {
    expect(highlightCode("x < y && z > 0", "js")).toContain("&gt;");
  });
});

describe("multiline", () => {
  it("multiline block comment start", () => {
    const multiBlock = highlightCode("/* start\ncontinued\nend */", "js");
    expect(multiBlock).toContain('<span class="hl-cmt">/* start</span>');
  });
  it("multiline block comment middle", () => {
    const multiBlock = highlightCode("/* start\ncontinued\nend */", "js");
    expect(multiBlock).toContain('<span class="hl-cmt">continued</span>');
  });
  it("multiline block comment end", () => {
    const multiBlock = highlightCode("/* start\ncontinued\nend */", "js");
    expect(multiBlock).toContain('<span class="hl-cmt">end */</span>');
  });
  it("python triple-quote open", () => {
    const multiStr = highlightCode('x = """\nhello\n"""', "python");
    expect(multiStr).toContain('<span class="hl-str">&quot;&quot;&quot;</span>');
  });
  it("python triple-quote middle", () => {
    const multiStr = highlightCode('x = """\nhello\n"""', "python");
    expect(multiStr).toContain('<span class="hl-str">hello</span>');
  });
  it("template literal start", () => {
    const tmpl = highlightCode("let s = `line1\nline2`", "js");
    expect(tmpl).toContain('<span class="hl-str">`line1</span>');
  });
  it("template literal end", () => {
    const tmpl = highlightCode("let s = `line1\nline2`", "js");
    expect(tmpl).toContain('<span class="hl-str">line2`</span>');
  });
});

describe("string escapes", () => {
  it("escaped quote in string", () => {
    expect(highlightCode(String.raw`let s = "a\"b"`, "js")).toContain(
      String.raw`<span class="hl-str">&quot;a\&quot;b&quot;</span>`,
    );
  });
});

describe("partial keyword match", () => {
  it("no partial keyword match", () => {
    expect(highlightCode("constant", "js")).not.toContain("hl-kw");
  });
});

describe("JSON", () => {
  it("json key string", () => {
    expect(highlightCode('{"key": "value"}', "json")).toContain(
      '<span class="hl-str">&quot;key&quot;</span>',
    );
  });
  it("json number", () => {
    expect(highlightCode('{"n": 123}', "json")).toContain('<span class="hl-num">123</span>');
  });
  it("json true", () => {
    expect(highlightCode('{"b": true}', "json")).toContain('<span class="hl-type">true</span>');
  });
  it("json null", () => {
    expect(highlightCode('{"b": null}', "json")).toContain('<span class="hl-type">null</span>');
  });
});

describe("YAML", () => {
  it("yaml comment", () => {
    expect(highlightCode("key: value # comment", "yaml")).toContain(
      '<span class="hl-cmt"># comment</span>',
    );
  });
  it("yaml bool", () => {
    expect(highlightCode("enabled: true", "yaml")).toContain('<span class="hl-type">true</span>');
  });
  it("yaml number", () => {
    expect(highlightCode("count: 42", "yaml")).toContain('<span class="hl-num">42</span>');
  });
});

describe("TOML", () => {
  it("toml comment", () => {
    expect(highlightCode("# comment", "toml")).toContain('<span class="hl-cmt"># comment</span>');
  });
  it("toml string", () => {
    expect(highlightCode('key = "value"', "toml")).toContain(
      '<span class="hl-str">&quot;value&quot;</span>',
    );
  });
});

describe("shell aliases", () => {
  it("sh keyword", () => {
    expect(highlightCode("if true; then echo hi; fi", "sh")).toContain(
      '<span class="hl-kw">if</span>',
    );
  });
  it("zsh keyword", () => {
    expect(highlightCode("export FOO=bar", "zsh")).toContain('<span class="hl-kw">export</span>');
  });
  it("shell keyword", () => {
    expect(highlightCode("export FOO=bar", "shell")).toContain('<span class="hl-kw">export</span>');
  });
});

describe("language aliases", () => {
  it("rs alias", () => {
    expect(highlightCode("fn main() {}", "rs")).toContain('<span class="hl-kw">fn</span>');
  });
  it("py alias", () => {
    expect(highlightCode("def f(): pass", "py")).toContain('<span class="hl-kw">def</span>');
  });
  it("golang alias", () => {
    expect(highlightCode("package main", "golang")).toContain('<span class="hl-kw">package</span>');
  });
});

describe("C/C++", () => {
  it("c type", () => {
    expect(highlightCode("int main() {}", "c")).toContain('<span class="hl-type">int</span>');
  });
  it("cpp keyword", () => {
    expect(highlightCode("return 0;", "cpp")).toContain('<span class="hl-kw">return</span>');
  });
});

describe("edge cases", () => {
  it("empty input", () => {
    expect(highlightCode("", "js")).toBe("");
  });
  it("no lang passthrough", () => {
    expect(highlightCode("hello", "")).toBe("hello");
  });
});
