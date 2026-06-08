import * as fs from 'fs'; import * as path from 'path';
import { EdgeEngine } from '../src/engines/edgeEngine';
const OUT = path.join(__dirname, '..', 'voice_samples'); fs.mkdirSync(OUT, { recursive: true });
const AVA = 'en-US-AvaMultilingualNeural';
const SERA = 'de-DE-SeraphinaMultilingualNeural';
const EN = 'Reading your documents out loud should feel natural and easy to follow, even across different sections.';
const DE = 'Das Vorlesen deiner Dokumente sollte sich natürlich anfühlen und leicht zu verfolgen sein.';
const MIX = 'Der Reliever besitzt echte Pricing Power, weil es im Bottleneck keine Alternative gibt. Das ist der eigentliche Edge der gesamten Value Chain, und deshalb ist die Aktie kein klassischer Value Trap.';
(async () => {
  const e = new EdgeEngine();
  const jobs: [string,string,string,string][] = [
    [EN, AVA, 'en-US', 'av_en_native.mp3'],         // gold English
    [EN, SERA, 'de-DE', 'sv_en.mp3'],               // English read by the German voice (single-voice case)
    [DE, SERA, 'de-DE', 'sv_de_native.mp3'],        // gold German
    [MIX, SERA, 'de-DE', 'mix_seraphina.mp3'],      // realistic mixed paragraph, ONE German voice
    [MIX, AVA, 'en-US', 'mix_ava.mp3'],             // same mixed paragraph, ONE English voice
  ];
  for (const [text, voice, loc, file] of jobs) {
    const buf = await e.synth(text, voice, loc);
    fs.writeFileSync(path.join(OUT, file), buf);
    console.log(file.padEnd(22), buf.length, 'bytes');
  }
  e.dispose();
  const html = `<!doctype html><meta charset=utf-8><title>Single-voice A/B</title>
<style>body{font:15px/1.6 system-ui,Segoe UI,sans-serif;max-width:720px;margin:24px auto;padding:0 16px}
.c{border:1px solid #ddd;border-radius:10px;padding:12px;margin:10px 0}h2{margin:18px 0 4px;font-size:16px}
audio{width:100%;margin-top:6px}b.q{color:#1a73e8}small{color:#666}</style>
<h1>🔊 Eine Stimme statt Umschalten — klingt es gut genug?</h1>
<p>Frage: Reicht <b>eine</b> multilinguale Stimme fürs ganze Dokument (konsistent, leicht zu folgen) — auch wenn englische Stellen drin sind?</p>
<h2>1) Referenz: gutes Englisch (Ava, native)</h2><div class=c><audio controls src="av_en_native.mp3"></audio></div>
<h2>2) <b class=q>Schlüssel:</b> derselbe englische Satz, gelesen von der deutschen Stimme Seraphina</h2>
<div class=c><small>Klingt das wie ordentliches Englisch (≈ wie Ava oben) oder deutsch-akzentuiert/falsch?</small><audio controls src="sv_en.mp3"></audio></div>
<h2>3) Referenz: Deutsch (Seraphina)</h2><div class=c><audio controls src="sv_de_native.mp3"></audio></div>
<h2>4) <b class=q>Dein echter Fall:</b> gemischter Absatz (Deutsch + englische Begriffe) — NUR Seraphina</h2>
<div class=c><small>Eine konsistente Stimme, kein Umschalten. Gut genug?</small><audio controls src="mix_seraphina.mp3"></audio></div>
<h2>5) Gegenprobe: derselbe gemischte Absatz — NUR Ava (englische Stimme)</h2>
<div class=c><small>Wie klingt der deutsche Teil, wenn eine englische Stimme alles liest?</small><audio controls src="mix_ava.mp3"></audio></div>
<p style="margin-top:20px;color:#555">Wenn #2 ordentlich klingt → <b>eine Seraphina fürs ganze Dokument</b> ist die beste Lösung (konsistent + korrekt). Wenn nicht → eine Stimme in der Hauptsprache, fremdsprachige Stellen leicht akzentuiert (konsistent, dein gewählter Kompromiss).</p>`;
  fs.writeFileSync(path.join(OUT, 'single-voice-ab.html'), html);
  console.log('Wrote single-voice-ab.html');
})().catch(e => { console.error(e); process.exit(1); });
