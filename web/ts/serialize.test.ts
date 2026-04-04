import { setupDOM, assertEqual, assertContains } from './test-helper.ts';
const cleanup = setupDOM();

import { domToMarkdown } from './serialize.ts';

function html(content: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = content;
  return el;
}

// Heading serialization
assertEqual(domToMarkdown(html('<h1>Title</h1>')), '# Title', 'h1');
assertEqual(domToMarkdown(html('<h2>Sub</h2>')), '## Sub', 'h2');
assertEqual(domToMarkdown(html('<h3>Deep</h3>')), '### Deep', 'h3');
assertEqual(domToMarkdown(html('<h6>H6</h6>')), '###### H6', 'h6');

// Paragraph
assertEqual(domToMarkdown(html('<p>Hello world</p>')), 'Hello world', 'paragraph');

// Multiple blocks
assertEqual(
  domToMarkdown(html('<h1>Title</h1><p>Body</p>')),
  '# Title\n\nBody',
  'heading + paragraph'
);

// Bold / italic / strikethrough / mark / code
assertEqual(domToMarkdown(html('<p><strong>bold</strong></p>')), '**bold**', 'bold');
assertEqual(domToMarkdown(html('<p><b>bold</b></p>')), '**bold**', 'b tag');
assertEqual(domToMarkdown(html('<p><em>italic</em></p>')), '*italic*', 'italic');
assertEqual(domToMarkdown(html('<p><i>italic</i></p>')), '*italic*', 'i tag');
assertEqual(domToMarkdown(html('<p><del>deleted</del></p>')), '~~deleted~~', 'strikethrough del');
assertEqual(domToMarkdown(html('<p><s>deleted</s></p>')), '~~deleted~~', 'strikethrough s');
assertEqual(domToMarkdown(html('<p><mark>marked</mark></p>')), '==marked==', 'highlight');
assertEqual(domToMarkdown(html('<p><code>code</code></p>')), '`code`', 'inline code');

// Links
assertEqual(
  domToMarkdown(html('<p><a href="http://example.com">click</a></p>')),
  '[click](http://example.com)',
  'link'
);

// Wiki-links
assertEqual(
  domToMarkdown(html('<p><a class="wiki-link" data-target="My Note">My Note</a></p>')),
  '[[My Note]]',
  'wiki-link same display'
);
assertEqual(
  domToMarkdown(html('<p><a class="wiki-link" data-target="target">display</a></p>')),
  '[[target|display]]',
  'wiki-link different display'
);

// Images
assertEqual(
  domToMarkdown(html('<p><img src="photo.png" alt="desc"></p>')),
  '![desc](photo.png)',
  'image'
);

// Wiki-images
assertEqual(
  domToMarkdown(html('<p><img data-wiki-image="photo.webp" src="/z-images/photo.webp" alt="photo.webp"></p>')),
  '![[photo.webp]]',
  'wiki-image'
);

// HR
assertEqual(domToMarkdown(html('<hr>')), '---', 'hr');

// Unordered list
assertEqual(
  domToMarkdown(html('<ul><li>one</li><li>two</li></ul>')),
  '- one\n- two',
  'ul'
);

// Ordered list
assertEqual(
  domToMarkdown(html('<ol><li>first</li><li>second</li></ol>')),
  '1. first\n2. second',
  'ol'
);

// Task list — build DOM programmatically to avoid happy-dom querySelector issue
{
  const root = document.createElement('div');
  const ul = document.createElement('ul');
  const li1 = document.createElement('li');
  const cb1 = document.createElement('input');
  cb1.type = 'checkbox';
  li1.appendChild(cb1);
  li1.appendChild(document.createTextNode('todo'));
  const li2 = document.createElement('li');
  const cb2 = document.createElement('input');
  cb2.type = 'checkbox';
  cb2.checked = true;
  li2.appendChild(cb2);
  li2.appendChild(document.createTextNode('done'));
  ul.append(li1, li2);
  root.appendChild(ul);
  assertEqual(domToMarkdown(root), '- [ ] todo\n- [x] done', 'task list');
}

// Code block
assertEqual(
  domToMarkdown(html('<pre><code class="language-js">const x = 1;</code></pre>')),
  '```js\nconst x = 1;\n```',
  'code block with lang'
);

assertEqual(
  domToMarkdown(html('<pre><code>plain code</code></pre>')),
  '```\nplain code\n```',
  'code block no lang'
);

// Blockquote
assertContains(
  domToMarkdown(html('<blockquote><p>quoted</p></blockquote>')),
  '> quoted',
  'blockquote'
);

// Table
const tableHtml = '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>';
const tableMd = domToMarkdown(html(tableHtml));
assertContains(tableMd, '| A | B |', 'table header');
assertContains(tableMd, '| --- | --- |', 'table separator');
assertContains(tableMd, '| 1 | 2 |', 'table row');

// Callout
const calloutHtml = `<div class="callout callout-warning" data-callout="warning">
  <div class="callout-title">\u26a0\ufe0f Be careful</div>
  <div class="callout-body"><p>This is important</p></div>
</div>`;
const calloutMd = domToMarkdown(html(calloutHtml));
assertContains(calloutMd, '> [!warning]', 'callout type');
assertContains(calloutMd, 'Be careful', 'callout title');
assertContains(calloutMd, '> This is important', 'callout body');

// Nested inline
assertEqual(
  domToMarkdown(html('<p><strong><em>bold italic</em></strong></p>')),
  '***bold italic***',
  'nested bold italic'
);

// BR becomes newline
assertContains(
  domToMarkdown(html('<p>line1<br>line2</p>')),
  'line1\nline2',
  'br to newline'
);

// Empty
assertEqual(domToMarkdown(html('')), '', 'empty');

// DIV treated as paragraph
assertEqual(domToMarkdown(html('<div>text</div>')), 'text', 'div as paragraph');

cleanup();
console.log('All serialize tests passed');
