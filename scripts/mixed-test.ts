import { processMarkdown } from '../src/markdown/processor';
import { chunkBlocks } from '../src/segmenter';
import { detectLocale, detectReliableLocale } from '../src/languageDetector';

const md = `# Überblick über das System

Dies ist ein deutscher Absatz über die Architektur des Systems und seine wichtigsten Komponenten und Schnittstellen.

This is an English paragraph that describes exactly the same architecture, but written entirely in English with several full sentences.

Und nun wieder auf Deutsch: die Engine verarbeitet jeden Absatz einzeln und erkennt die Sprache zuverlässig je Absatz.

A final English note: the per-paragraph detection should switch the voice back to an English one here.
`;

const dom = detectLocale(md, 'en-US').locale;
const res = processMarkdown(md, { codeBlocks: 'announce', tables: 'skip', announceHeadings: false, lang: dom.split('-')[0] });
let last = dom;
for (const b of res.blocks) { b.locale = detectReliableLocale(b.text) || last; last = b.locale; }
const chunks = chunkBlocks(res.blocks, dom);
console.log('dominant:', dom);
for (const c of chunks) console.log('  ' + c.locale.padEnd(6) + JSON.stringify(c.text.slice(0, 64)));
console.log('distinct languages:', [...new Set(chunks.map(c => c.locale))].join(', '));
