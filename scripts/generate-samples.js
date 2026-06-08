/**
 * Dev tool: generate voice samples with Microsoft Edge neural voices so we can
 * A/B compare them before committing. Outputs MP3s + an index.html into ../voice_samples.
 *
 *   node scripts/generate-samples.js
 */
const fs = require('fs');
const path = require('path');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const OUT = path.join(__dirname, '..', 'voice_samples');
fs.mkdirSync(OUT, { recursive: true });

const DE = 'Hallo Robin! Schön, dass du reinhörst. Ich lese dir deine Markdown-Dateien vor — mit Betonung, echten Pausen und natürlicher Sprachmelodie. Klingt das monoton? Ich finde: ganz und gar nicht. Übrigens — Großtransformatoren haben heute rund 128 Wochen Lieferzeit. Wahnsinn, oder?';
const EN = "Hi Robin! Glad you're listening. I read your Markdown files out loud — with real intonation, natural pauses, and genuine expressiveness. Does this sound robotic to you? I really don't think so. By the way, large transformers now have about 128 weeks of lead time. Pretty wild, right?";

// label = human label; multilingual = the newest, most expressive tier
const SAMPLES = [
  // German — the user's primary language
  { lang: 'Deutsch', voice: 'de-DE-SeraphinaMultilingualNeural', gender: '♀ weiblich', tier: 'Multilingual (Top)', text: DE },
  { lang: 'Deutsch', voice: 'de-DE-FlorianMultilingualNeural',   gender: '♂ männlich', tier: 'Multilingual (Top)', text: DE },
  { lang: 'Deutsch', voice: 'de-DE-KatjaNeural',                 gender: '♀ weiblich', tier: 'Standard (Klassiker)', text: DE },
  { lang: 'Deutsch', voice: 'de-DE-ConradNeural',                gender: '♂ männlich', tier: 'Standard (Klassiker)', text: DE },
  { lang: 'Deutsch', voice: 'de-DE-AmalaNeural',                 gender: '♀ weiblich', tier: 'Standard', text: DE },
  { lang: 'Deutsch', voice: 'de-DE-KillianNeural',               gender: '♂ männlich', tier: 'Standard', text: DE },
  // English (US)
  { lang: 'English (US)', voice: 'en-US-AvaMultilingualNeural',    gender: '♀ female', tier: 'Multilingual (Flagship)', text: EN },
  { lang: 'English (US)', voice: 'en-US-AndrewMultilingualNeural', gender: '♂ male',   tier: 'Multilingual (Flagship)', text: EN },
  { lang: 'English (US)', voice: 'en-US-EmmaMultilingualNeural',   gender: '♀ female', tier: 'Multilingual', text: EN },
  { lang: 'English (US)', voice: 'en-US-BrianMultilingualNeural',  gender: '♂ male',   tier: 'Multilingual', text: EN },
  // English (GB)
  { lang: 'English (GB)', voice: 'en-GB-SoniaNeural', gender: '♀ female', tier: 'Standard', text: EN },
  { lang: 'English (GB)', voice: 'en-GB-RyanNeural',  gender: '♂ male',   tier: 'Standard', text: EN },
  // Cross-test: a multilingual English voice reading German (to hear accent)
  { lang: 'Multilingual-Test', voice: 'en-US-AvaMultilingualNeural', voiceLocale: 'de-DE', gender: '♀ Ava liest Deutsch', tier: 'Multilingual cross', text: DE },
];

function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function synth(voice, text, outPath, voiceLocale) {
  return new Promise(async (resolve, reject) => {
    const tts = new MsEdgeTTS();
    const timer = setTimeout(() => reject(new Error('timeout')), 30000);
    try {
      await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3,
        voiceLocale ? { voiceLocale } : undefined);
      const { audioStream } = tts.toStream(xmlEscape(text), { rate: '+0%', pitch: '+0Hz', volume: 100 });
      const chunks = [];
      audioStream.on('data', (c) => chunks.push(c));
      audioStream.on('end', () => {
        clearTimeout(timer);
        const buf = Buffer.concat(chunks);
        fs.writeFileSync(outPath, buf);
        try { tts.close(); } catch (_) {}
        resolve(buf.length);
      });
      audioStream.on('error', (e) => { clearTimeout(timer); reject(e); });
    } catch (e) { clearTimeout(timer); reject(e); }
  });
}

(async () => {
  const done = [];
  for (const s of SAMPLES) {
    const file = `${s.voice}${s.voiceLocale ? '_' + s.voiceLocale : ''}.mp3`;
    process.stdout.write(`Synthesizing ${s.voice}${s.voiceLocale ? ' ('+s.voiceLocale+')' : ''} ... `);
    try {
      const bytes = await synth(s.voice, s.text, path.join(OUT, file), s.voiceLocale);
      console.log(`ok (${(bytes/1024).toFixed(0)} KB)`);
      done.push({ ...s, file, bytes });
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
    }
  }

  // Build a comparison index.html
  const groups = {};
  for (const d of done) (groups[d.lang] ??= []).push(d);
  const sectionHtml = Object.entries(groups).map(([lang, items]) => `
    <h2>${lang}</h2>
    <div class="grid">
      ${items.map((d) => `
        <div class="card">
          <div class="row"><span class="g">${d.gender}</span><span class="tier">${d.tier}</span></div>
          <code>${d.voice}${d.voiceLocale ? ' @ ' + d.voiceLocale : ''}</code>
          <audio controls preload="none" src="${d.file}"></audio>
        </div>`).join('')}
    </div>`).join('');

  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Markdown-TTS · Stimmen-Vergleich</title>
<style>
  body{font:15px/1.5 system-ui,Segoe UI,sans-serif;max-width:920px;margin:24px auto;padding:0 16px;color:#1c1c1c;background:#fafafa}
  h1{font-size:22px} h2{margin-top:28px;border-bottom:1px solid #ddd;padding-bottom:6px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
  .card{background:#fff;border:1px solid #e3e3e3;border-radius:10px;padding:12px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
  .row{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
  .g{font-weight:600} .tier{font-size:12px;color:#666;background:#f0f0f0;border-radius:99px;padding:2px 8px}
  code{display:block;font-size:12px;color:#444;margin-bottom:8px;word-break:break-all}
  audio{width:100%}
  .text{background:#fff;border:1px solid #e3e3e3;border-radius:10px;padding:12px 16px;margin:12px 0;color:#333}
  .text small{color:#888}
</style></head><body>
<h1>🎧 Stimmen-Vergleich — Microsoft Edge Neural Voices (gratis)</h1>
<p>Klick auf ▶︎. Die <b>Multilingual</b>-Stimmen (Ava, Andrew, Seraphina, Florian, Emma, Brian) sind die neueste, ausdrucksstärkste Generation — bewusst <i>nicht</i> die alten robotischen SAPI-Stimmen.</p>
<div class="text">
  <small>Deutscher Beispieltext:</small><br>${DE}
  <br><br><small>English sample:</small><br>${EN}
</div>
${sectionHtml}
<p style="margin-top:28px;color:#888;font-size:13px">Generiert ${done.length}/${SAMPLES.length} Samples · Format MP3 24kHz · ohne API-Key, kostenlos über den Edge-Read-Aloud-Endpoint.</p>
</body></html>`;
  fs.writeFileSync(path.join(OUT, 'index.html'), html);
  console.log(`\nDone. ${done.length}/${SAMPLES.length} samples + index.html written to:\n  ${OUT}`);
})();
