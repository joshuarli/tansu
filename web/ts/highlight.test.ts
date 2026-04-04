import { highlightCode } from './highlight.ts';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function assertContains(html: string, substr: string, msg: string) {
  assert(html.includes(substr), `${msg}: expected "${substr}" in "${html}"`);
}

function assertNotContains(html: string, substr: string, msg: string) {
  assert(!html.includes(substr), `${msg}: unexpected "${substr}" in "${html}"`);
}

// Unknown language returns escaped plaintext
const plain = highlightCode('<div>', 'unknown');
assertContains(plain, '&lt;div&gt;', 'unknown lang escapes html');
assertNotContains(plain, '<span', 'unknown lang no spans');

// Keywords
assertContains(highlightCode('const x = 1;', 'js'), '<span class="hl-kw">const</span>', 'js keyword');
assertContains(highlightCode('fn main() {}', 'rust'), '<span class="hl-kw">fn</span>', 'rust keyword');
assertContains(highlightCode('def foo():', 'python'), '<span class="hl-kw">def</span>', 'python keyword');
assertContains(highlightCode('func main() {}', 'go'), '<span class="hl-kw">func</span>', 'go keyword');

// Types
assertContains(highlightCode('let x: string = ""', 'ts'), '<span class="hl-type">string</span>', 'ts type');
assertContains(highlightCode('None', 'python'), '<span class="hl-type">None</span>', 'python type');

// Strings
assertContains(highlightCode('let s = "hello"', 'js'), '<span class="hl-str">&quot;hello&quot;</span>', 'js string');
assertContains(highlightCode("let s = 'hello'", 'js'), "<span class=\"hl-str\">'hello'</span>", 'js single-quote string');

// Numbers
assertContains(highlightCode('let x = 42', 'js'), '<span class="hl-num">42</span>', 'js number');
assertContains(highlightCode('let x = 3.14', 'js'), '<span class="hl-num">3.14</span>', 'js float');
assertContains(highlightCode('let x = 0xFF', 'js'), '<span class="hl-num">0xFF</span>', 'js hex');

// Line comments
assertContains(highlightCode('// comment', 'js'), '<span class="hl-cmt">// comment</span>', 'js line comment');
assertContains(highlightCode('# comment', 'python'), '<span class="hl-cmt"># comment</span>', 'python comment');

// Block comments
assertContains(highlightCode('/* block */', 'js'), '<span class="hl-cmt">/* block */</span>', 'js block comment');

// Function calls
assertContains(highlightCode('foo()', 'js'), '<span class="hl-fn">foo</span>', 'js function call');

// Rust macros
assertContains(highlightCode('println!("hi")', 'rust'), '<span class="hl-macro">println!</span>', 'rust macro');

// UPPER_SNAKE_CASE constants
assertContains(highlightCode('MAX_SIZE', 'js'), '<span class="hl-const">MAX_SIZE</span>', 'constant');

// Operators
assertContains(highlightCode('a && b', 'js'), '<span class="hl-op">&amp;&amp;</span>', 'js operator');
assertContains(highlightCode('a === b', 'js'), '<span class="hl-op">===</span>', 'js strict eq');
assertContains(highlightCode('x => x', 'js'), '<span class="hl-op">=&gt;</span>', 'js arrow');

// Brackets
assertContains(highlightCode('()', 'js'), '<span class="hl-brk">()</span>', 'brackets');

// HTML escaping inside highlighted code
assertContains(highlightCode('x < y && z > 0', 'js'), '&lt;', 'html escape lt');
assertContains(highlightCode('x < y && z > 0', 'js'), '&gt;', 'html escape gt');

// Multiline block comment
const multiBlock = highlightCode('/* start\ncontinued\nend */', 'js');
assertContains(multiBlock, '<span class="hl-cmt">/* start</span>', 'multiline block comment start');
assertContains(multiBlock, '<span class="hl-cmt">continued</span>', 'multiline block comment middle');
assertContains(multiBlock, '<span class="hl-cmt">end */</span>', 'multiline block comment end');

// Multiline string (Python triple-quote)
const multiStr = highlightCode('x = """\nhello\n"""', 'python');
assertContains(multiStr, '<span class="hl-str">&quot;&quot;&quot;</span>', 'python triple-quote open');
assertContains(multiStr, '<span class="hl-str">hello</span>', 'python triple-quote middle');

// JS template literal (multiline)
const tmpl = highlightCode('let s = `line1\nline2`', 'js');
assertContains(tmpl, '<span class="hl-str">`line1</span>', 'template literal start');
assertContains(tmpl, '<span class="hl-str">line2`</span>', 'template literal end');

// String with escape
assertContains(highlightCode('let s = "a\\"b"', 'js'), '<span class="hl-str">&quot;a\\&quot;b&quot;</span>', 'escaped quote in string');

// Keyword not matched inside identifier
assertNotContains(highlightCode('constant', 'js'), 'hl-kw', 'no partial keyword match');

// JSON
assertContains(highlightCode('{"key": "value"}', 'json'), '<span class="hl-str">&quot;key&quot;</span>', 'json key string');
assertContains(highlightCode('{"n": 123}', 'json'), '<span class="hl-num">123</span>', 'json number');
assertContains(highlightCode('{"b": true}', 'json'), '<span class="hl-type">true</span>', 'json true');
assertContains(highlightCode('{"b": null}', 'json'), '<span class="hl-type">null</span>', 'json null');

// YAML
assertContains(highlightCode('key: value # comment', 'yaml'), '<span class="hl-cmt"># comment</span>', 'yaml comment');
assertContains(highlightCode('enabled: true', 'yaml'), '<span class="hl-type">true</span>', 'yaml bool');
assertContains(highlightCode('count: 42', 'yaml'), '<span class="hl-num">42</span>', 'yaml number');

// TOML
assertContains(highlightCode('# comment', 'toml'), '<span class="hl-cmt"># comment</span>', 'toml comment');
assertContains(highlightCode('key = "value"', 'toml'), '<span class="hl-str">&quot;value&quot;</span>', 'toml string');

// Shell aliases
assertContains(highlightCode('if true; then echo hi; fi', 'sh'), '<span class="hl-kw">if</span>', 'sh keyword');
assertContains(highlightCode('export FOO=bar', 'zsh'), '<span class="hl-kw">export</span>', 'zsh keyword');
assertContains(highlightCode('export FOO=bar', 'shell'), '<span class="hl-kw">export</span>', 'shell keyword');

// Language aliases
assertContains(highlightCode('fn main() {}', 'rs'), '<span class="hl-kw">fn</span>', 'rs alias');
assertContains(highlightCode('def f(): pass', 'py'), '<span class="hl-kw">def</span>', 'py alias');
assertContains(highlightCode('package main', 'golang'), '<span class="hl-kw">package</span>', 'golang alias');

// C
assertContains(highlightCode('int main() {}', 'c'), '<span class="hl-type">int</span>', 'c type');
assertContains(highlightCode('return 0;', 'cpp'), '<span class="hl-kw">return</span>', 'cpp keyword');

// Empty input
assert(highlightCode('', 'js') === '', 'empty input');

// No language
assert(highlightCode('hello', '') === 'hello', 'no lang passthrough');

console.log('All highlight tests passed');
