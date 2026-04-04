import { renderMarkdown } from './markdown.ts';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function assertContains(html: string, substr: string, msg: string) {
  assert(html.includes(substr), `${msg}: expected "${substr}" in "${html}"`);
}

function assertNotContains(html: string, substr: string, msg: string) {
  assert(!html.includes(substr), `${msg}: unexpected "${substr}" in "${html}"`);
}

// Headings
assert(renderMarkdown('# Hello').includes('<h1>Hello</h1>'), 'h1');
assert(renderMarkdown('## Sub').includes('<h2>Sub</h2>'), 'h2');
assert(renderMarkdown('###### Deep').includes('<h6>Deep</h6>'), 'h6');

// Paragraphs
assertContains(renderMarkdown('Hello world'), '<p>Hello world</p>', 'paragraph');

// Multiple paragraphs
const twoPara = renderMarkdown('First\n\nSecond');
assertContains(twoPara, '<p>First</p>', 'para 1');
assertContains(twoPara, '<p>Second</p>', 'para 2');

// Bold
assertContains(renderMarkdown('**bold**'), '<strong>bold</strong>', 'bold');

// Italic
assertContains(renderMarkdown('*italic*'), '<em>italic</em>', 'italic');

// Inline code
assertContains(renderMarkdown('use `foo` here'), '<code>foo</code>', 'inline code');

// Strikethrough
assertContains(renderMarkdown('~~deleted~~'), '<del>deleted</del>', 'strikethrough');

// Highlight
assertContains(renderMarkdown('==marked=='), '<mark>marked</mark>', 'highlight');

// Wiki-link
const wl = renderMarkdown('See [[my note]]');
assertContains(wl, 'class="wiki-link"', 'wiki-link class');
assertContains(wl, 'data-target="my note"', 'wiki-link target');

// Wiki-link with display text
const wld = renderMarkdown('See [[target|display]]');
assertContains(wld, 'data-target="target"', 'wiki-link pipe target');
assertContains(wld, '>display</a>', 'wiki-link pipe display');

// Wiki-image
const wi = renderMarkdown('![[photo.webp]]');
assertContains(wi, '<img', 'wiki-image tag');
assertContains(wi, 'data-wiki-image="photo.webp"', 'wiki-image data');
assertContains(wi, '/z-images/', 'wiki-image src');

// Standard link
const link = renderMarkdown('[text](http://url)');
assertContains(link, '<a href="http://url">text</a>', 'link');

// Standard image
const img = renderMarkdown('![alt](src.png)');
assertContains(img, '<img', 'image');
assertContains(img, 'alt="alt"', 'image alt');

// Fenced code block
const code = renderMarkdown('```js\nconst x = 1;\n```');
assertContains(code, '<pre><code class="language-js">', 'code block lang');
assertContains(code, 'const x = 1;', 'code block content');

// Code block without language
const codeNoLang = renderMarkdown('```\nhello\n```');
assertContains(codeNoLang, '<pre><code>', 'code no lang');

// Unordered list
const ul = renderMarkdown('- one\n- two\n- three');
assertContains(ul, '<ul>', 'ul tag');
assertContains(ul, '<li>one</li>', 'ul item');

// Ordered list
const ol = renderMarkdown('1. first\n2. second');
assertContains(ol, '<ol>', 'ol tag');
assertContains(ol, '<li>first</li>', 'ol item');

// Task list
const task = renderMarkdown('- [ ] todo\n- [x] done');
assertContains(task, 'type="checkbox"', 'task checkbox');
assertContains(task, 'checked', 'task checked');
assertContains(task, 'todo', 'task unchecked text');

// Blockquote
const bq = renderMarkdown('> quoted text');
assertContains(bq, '<blockquote>', 'blockquote');
assertContains(bq, 'quoted text', 'blockquote text');

// Callout
const callout = renderMarkdown('> [!warning] Be careful\n> This is important');
assertContains(callout, 'callout-warning', 'callout type');
assertContains(callout, 'Be careful', 'callout title');
assertContains(callout, 'This is important', 'callout body');

// Callout with default title
const calloutDefault = renderMarkdown('> [!note]\n> Body here');
assertContains(calloutDefault, 'Note', 'callout default title');

// Table
const table = renderMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |');
assertContains(table, '<table>', 'table');
assertContains(table, '<th>A</th>', 'table header');
assertContains(table, '<td>1</td>', 'table cell');

// HR
assertContains(renderMarkdown('---'), '<hr>', 'hr dashes');
assertContains(renderMarkdown('***'), '<hr>', 'hr stars');

// Escaped characters
assertNotContains(renderMarkdown('\\*not italic\\*'), '<em>', 'escaped not italic');
assertContains(renderMarkdown('\\*not italic\\*'), '*', 'escaped shows literal');

// Nested inline: bold inside italic (or vice versa)
const nested = renderMarkdown('**bold *and italic***');
assertContains(nested, '<strong>', 'nested bold');

// HTML escaping in paragraphs
const escaped = renderMarkdown('<script>alert("xss")</script>');
assertNotContains(escaped, '<script>', 'no raw script tag');
assertContains(escaped, '&lt;script&gt;', 'escaped script');

// Line break within paragraph
const br = renderMarkdown('line1\nline2');
assertContains(br, '<br>', 'line break');

// Empty input
assert(renderMarkdown('') === '', 'empty input');

// Code block escapes HTML
const codeEsc = renderMarkdown('```\n<div>test</div>\n```');
assertContains(codeEsc, '&lt;div&gt;', 'code escapes html');

console.log('All markdown tests passed');
