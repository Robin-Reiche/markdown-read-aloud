import * as fs from 'fs'; import * as path from 'path';
import { processMarkdown } from '../src/markdown/processor';
import { chunkBlocks } from '../src/segmenter';
import { detectLocale, detectReliableLocale } from '../src/languageDetector';
import { pickVoice, displayName } from '../src/voices';
import { EdgeEngine } from '../src/engines/edgeEngine';

const md = `# Überblick über das System

Dies ist ein deutscher Absatz über die Architektur des Systems und seine wichtigsten Komponenten.

This is an English paragraph that describes exactly the same architecture, written entirely in English.

Und nun wieder auf Deutsch: die Engine verarbeitet jeden Absatz einzeln und erkennt die Sprache je Absatz.

A final English note: the per-paragraph detection switches the voice back to an English one here.`;

(async () => {
  const dom = detectLocale(md, 'en-US').locale;
  const res = processMarkdown(md, { codeBlocks: 'announce', tables: 'skip', announceHeadings: false, lang: dom.split('-')[0] });
  let last = dom;
  for (const b of res.blocks) { b.locale = detectReliableLocale(b.text) || last; last = b.locale; }
  const chunks = chunkBlocks(res.blocks, dom);
  const eng = new EdgeEngine();
  const parts: Buffer[] = [];
  for (const c of chunks) {
    const voice = pickVoice(c.locale, 'female');
    const buf = await eng.synth(c.text, voice, c.locale);
    console.log(`${c.locale.padEnd(6)} ${displayName(voice).padEnd(10)} ${buf.length} bytes  ${JSON.stringify(c.text.slice(0,48))}`);
    parts.push(buf);
  }
  eng.dispose();
  const out = path.join(__dirname, '..', 'voice_samples', 'mixed-perparagraph.mp3');
  fs.writeFileSync(out, Buffer.concat(parts));
  console.log('\nWrote voice_samples/mixed-perparagraph.mp3 — listen: DE parts = Seraphina, EN parts = Ava.');
})().catch(e => { console.error(e); process.exit(1); });
