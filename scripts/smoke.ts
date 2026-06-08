import * as fs from 'fs';
import * as path from 'path';
import { processMarkdown } from '../src/markdown/processor';
import { chunkBlocks } from '../src/segmenter';
import { detectLocale } from '../src/languageDetector';
import { pickVoice, displayName } from '../src/voices';
import { EdgeEngine } from '../src/engines/edgeEngine';

(async () => {
  const root = path.join(__dirname, '..');
  const src = fs.readFileSync(path.join(root, 'test_data', 'prd.md'), 'utf8');

  const det = detectLocale(src, 'en-US');
  console.log('Detected locale:', det);

  const res = processMarkdown(src, {
    codeBlocks: 'announce',
    tables: 'skip',
    announceHeadings: false,
    lang: det.locale.split('-')[0],
  });
  console.log('Blocks:', res.blocks.length, '| frontmatterLang:', res.frontmatterLang);

  const chunks = chunkBlocks(res.blocks, det.locale);
  console.log('Chunks:', chunks.length);
  console.log('--- first 8 chunks ---');
  for (const c of chunks.slice(0, 8)) {
    console.log(`[${c.index}] (${c.kind}${c.headingLevel ? ' h' + c.headingLevel : ''}) ${JSON.stringify(c.text.slice(0, 110))}`);
  }

  // Did any markdown artifacts leak into speakable text?
  const artifacts = chunks.filter((c) => /(^|[^\w])[#*`]|\]\(|!\[|\|.*\|/.test(c.text));
  console.log(`\nChunks with possible markdown artifacts: ${artifacts.length}/${chunks.length}`);
  for (const c of artifacts.slice(0, 6)) console.log('  !', JSON.stringify(c.text.slice(0, 90)));

  // Synthesize the first few chunks to prove the full path produces real audio.
  const voice = pickVoice(det.locale, 'female');
  console.log(`\nSynthesizing with voice: ${voice} (${displayName(voice)})`);
  const eng = new EdgeEngine();
  const text = chunks.slice(0, 4).map((c) => c.text).join(' ');
  const buf = await eng.synth(text, voice, det.locale);
  fs.mkdirSync(path.join(root, 'voice_samples'), { recursive: true });
  fs.writeFileSync(path.join(root, 'voice_samples', 'smoke-prd.mp3'), buf);
  console.log(`Wrote voice_samples/smoke-prd.mp3 (${(buf.length / 1024).toFixed(0)} KB)`);
  eng.dispose();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
