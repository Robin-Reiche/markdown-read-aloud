import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { processMarkdown } from '../src/markdown/processor';

const DOC = 'Before.\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n```js\nlet x = 1;\n```\n';

function spoken(codeBlocks: 'skip' | 'announce' | 'read', lang = 'en') {
  return processMarkdown(DOC, { codeBlocks, tables: 'skip', announceHeadings: false, lang })
    .blocks.map((b) => b.text);
}

// The audio export builds its speech from processMarkdown.
test('export: a mermaid block is announced as a diagram, a code block as code', () => {
  assert.deepEqual(spoken('announce'), ['Before.', 'Diagram.', 'Code block.']);
});

test('export: read mode reads code but still only announces the diagram', () => {
  assert.deepEqual(spoken('read'), ['Before.', 'Diagram.', 'let x = 1;']);
});

test('export: skip mode skips the diagram too', () => {
  assert.deepEqual(spoken('skip'), ['Before.']);
});

test('export: the phrase follows the document language', () => {
  assert.deepEqual(spoken('announce', 'de'), ['Before.', 'Diagramm.', 'Codeblock.']);
});

// media/reader.js runs in the webview and is not bundled, so the test lifts
// handlePre() out of the file and drives it with fake <pre> elements.
// The bundled test sits in .test-dist/, one level below the repo root.
const src = fs.readFileSync(path.join(__dirname, '..', 'media', 'reader.js'), 'utf8');
const start = src.indexOf('  function handlePre(pre) {');
const end = src.indexOf('\n  }\n', start);
assert.ok(start >= 0 && end > start, 'handlePre not found in media/reader.js');

function readerSegments(codeBlocks: string, lang: string) {
  const SEGMENTS: { text: string }[] = [];
  const run = new Function('state', 'SEGMENTS', 'L',
    `let SEG_SEQ = 0;\n${src.slice(start, end + 4)}\nreturn handlePre;`);
  const handlePre = run({ settings: { codeBlocks } }, SEGMENTS, { codeBlock: 'Code block', diagram: 'Diagram' });
  const pre = {
    textContent: 'flowchart LR\n  A --> B\n',
    querySelector: (sel: string) => (sel === `code.language-${lang}` ? {} : null),
  };
  handlePre(pre);
  return SEGMENTS.map((s) => s.text);
}

test('reader: a mermaid block is announced as a diagram', () => {
  assert.deepEqual(readerSegments('announce', 'mermaid'), ['Diagram']);
  assert.deepEqual(readerSegments('announce', 'js'), ['Code block']);
});

test('reader: read mode does not read diagram source', () => {
  assert.deepEqual(readerSegments('read', 'mermaid'), ['Diagram']);
});

test('reader: skip mode skips the diagram', () => {
  assert.deepEqual(readerSegments('skip', 'mermaid'), []);
});
