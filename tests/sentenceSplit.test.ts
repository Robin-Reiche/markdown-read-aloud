import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { joinFalseBreaks } from '../media/sentenceBreaks.js';
import { chunkBlocks } from '../src/segmenter';
import { applyPronunciations } from '../src/markdown/normalize';
import type { Block } from '../src/types';

const split = (text: string, locale = 'en') =>
  joinFalseBreaks([...new Intl.Segmenter(locale, { granularity: 'sentence' }).segment(text)]).map(
    (s) => s.segment
  );

// Intl.Segmenter cuts every one of these in two (issue #12).
const KEEP_WHOLE: [string, string][] = [
  ['en', 'Hello from a suite of .NET Core microservices.'],
  ['en', 'Open file.README now.'],
  ['en', 'Mr. Smith and Dr. Brown came.'],
  ['en', 'Use e.g. Python or i.e. Ruby.'],
  ['en', 'The U.S. Army is big.'],
  ['en', 'J. K. Rowling wrote it.'],
  ['en', 'See Fig. 3 and No. 5.'],
  ['de', 'Das ist z. B. Der Fall.'],
  ['de', 'Am 3. Oktober ist frei.'],
  ['de', 'Im 19. Jahrhundert war es so.'],
  ['de', 'Das kostet ca. 5 Euro.'],
  ['de', 'Siehe S. 12 und Nr. 3.'],
  ['de', 'Hr. Müller kommt.'],
  ['ja', '私は.NETを使います。'],
];

// Real sentence ends, which must stay cut.
const KEEP_SPLIT: [string, string, string[]][] = [
  ['en', 'First one. Second one.', ['First one. ', 'Second one.']],
  ['en', 'It ended in 2024. Then we left.', ['It ended in 2024. ', 'Then we left.']],
  ['en', 'We shipped version 1.2. Then we rested.', ['We shipped version 1.2. ', 'Then we rested.']],
  ['en', 'The answer is No. Then we left.', ['The answer is No. ', 'Then we left.']],
  ['en', 'Bring pens, paper etc. Then sit down.', ['Bring pens, paper etc. ', 'Then sit down.']],
  ['de', 'Das ist usw. Ganz klar.', ['Das ist usw. ', 'Ganz klar.']],
  ['ja', '日本語です。次の文。', ['日本語です。', '次の文。']],
];

test('false cuts at dots inside a sentence are glued back (issue #12)', () => {
  for (const [locale, text] of KEEP_WHOLE) assert.deepEqual(split(text, locale), [text], text);
});

test('real sentence ends stay cut', () => {
  for (const [locale, text, parts] of KEEP_SPLIT) assert.deepEqual(split(text, locale), parts, text);
});

test('glued pieces still cover the text without gaps, so reader offsets stay valid', () => {
  const text = 'Install .NET 8 today. Ask Dr. Brown. Then run it.';
  const segs = joinFalseBreaks([...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)]);
  let at = 0;
  for (const s of segs) {
    assert.equal(s.index, at);
    assert.equal(text.slice(s.index, s.index + s.segment.length), s.segment);
    at += s.segment.length;
  }
  assert.equal(at, text.length);
  assert.equal(segs.length, 3);
});

// media/reader.js runs in the webview and is not bundled, so the test lifts
// sentencesOf() out of the file and hands it the shared rules as `window`.
test('the reader cuts sentences with the shared rules', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'media', 'reader.js'), 'utf8');
  const start = src.indexOf('  function sentencesOf(');
  const end = src.indexOf('  function buildSegments(');
  assert.ok(start >= 0 && end > start, 'sentencesOf() not found in media/reader.js');
  const window = { MRASentenceBreaks: { joinFalseBreaks } };
  const sentencesOf = new Function('window', src.slice(start, end) + '\nreturn sentencesOf;')(window) as (
    text: string,
    base: string
  ) => { segment: string }[];
  assert.deepEqual(
    sentencesOf('Hello from a suite of .NET Core microservices. Bye.', 'en').map((s) => s.segment),
    ['Hello from a suite of .NET Core microservices. ', 'Bye.']
  );
});

test('the audio export keeps ".NET" whole, so a pronunciation for it matches (issue #12)', () => {
  const text = 'Hello from a suite of .NET Core microservices.';
  const block: Block = { kind: 'para', text, startOffset: 0, endOffset: text.length };
  const chunks = chunkBlocks([block], 'en-US').map((c) => c.text);
  assert.deepEqual(chunks, [text]);
  assert.equal(
    applyPronunciations(chunks[0], { '.NET': 'dot net' }),
    'Hello from a suite of dot net Core microservices.'
  );
});
