import * as fs from 'fs';
import * as path from 'path';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const VOICE = 'de-DE-SeraphinaMultilingualNeural';
const OUT = path.join(__dirname, '..', 'voice_samples');
fs.mkdirSync(OUT, { recursive: true });

function rawSsml(voice: string, locale: string, text: string, useLang: boolean) {
  const inner = useLang
    ? `<lang xml:lang="${locale}">${esc(text)}</lang>`
    : esc(text);
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${locale}"><voice name="${voice}"><prosody pitch="+0Hz" rate="+0%" volume="100">${inner}</prosody></voice></speak>`;
}

async function synth(ssml: string, file: string | null, label: string): Promise<number> {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioStream } = tts.rawToStream(ssml);
  const chunks: Buffer[] = [];
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), 20000);
    audioStream.on('data', (c: Buffer) => chunks.push(c));
    audioStream.on('end', () => { clearTimeout(t); res(); });
    audioStream.on('error', (e: Error) => { clearTimeout(t); rej(e); });
  });
  const buf = Buffer.concat(chunks);
  if (file) fs.writeFileSync(path.join(OUT, file), buf);
  console.log(`${label.padEnd(36)} ${buf.length} bytes${buf.length === 0 ? '  <-- REJECTED' : ''}`);
  tts.close();
  return buf.length;
}

(async () => {
  const EN = 'The quick brown fox jumps over the lazy dog near the river bank.';
  const DE = 'Der schnelle braune Fuchs springt über den faulen Hund am Flussufer.';

  console.log('--- does the endpoint accept <lang>, and does it change output? ---');
  await synth(rawSsml(VOICE, 'en-US', EN, false), 'en_no-lang.mp3', 'EN text, no <lang>');
  await synth(rawSsml(VOICE, 'en-US', EN, true), 'en_lang-en.mp3', 'EN text, <lang en-US>');
  await synth(rawSsml(VOICE, 'de-DE', EN, true), 'en_lang-de.mp3', 'EN text, <lang de-DE> (force German)');
  console.log('');
  await synth(rawSsml(VOICE, 'de-DE', DE, false), 'de_no-lang.mp3', 'DE text, no <lang>');
  await synth(rawSsml(VOICE, 'de-DE', DE, true), 'de_lang-de.mp3', 'DE text, <lang de-DE>');
  await synth(rawSsml(VOICE, 'fr-FR', DE, true), 'de_lang-fr.mp3', 'DE text, <lang fr-FR> (force French)');

  console.log('\nIf the <lang en-US> vs <lang de-DE> byte counts differ, the language tag IS applied.');
  console.log('Listen in voice_samples/: en_lang-en vs en_lang-de should sound clearly different.');
})().catch((e) => { console.error(e); process.exit(1); });
