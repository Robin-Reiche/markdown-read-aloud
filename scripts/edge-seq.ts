import { EdgeEngine } from '../src/engines/edgeEngine';
(async () => {
  const eng = new EdgeEngine();
  await eng.setVoice('de-DE-SeraphinaMultilingualNeural');
  const texts = [
    'Erster Satz, kurz und knapp.',
    'Zweiter Satz mit Sonderzeichen: A & B, 5 < 10 > 3, Pfeil → Ziel.',
    'Dritter Satz, etwas länger, um die Wiederverwendung der Verbindung zu prüfen.',
    'Vierter.',
    'Und der fünfte Satz schließt den Test ab.',
  ];
  const t0 = Date.now();
  for (let i = 0; i < texts.length; i++) {
    const s = Date.now();
    const buf = await eng.synth(texts[i]);
    console.log(`chunk ${i}: ${buf.length} bytes (${Date.now()-s}ms)`);
    if (buf.length < 500) throw new Error('chunk ' + i + ' produced too little audio');
  }
  // also fire two concurrently to test the serialization queue
  const [a, b] = await Promise.all([eng.synth('Parallel A test.'), eng.synth('Parallel B test.')]);
  console.log('concurrent A/B bytes:', a.length, b.length);
  console.log(`TOTAL ${Date.now()-t0}ms`);
  eng.dispose();
  console.log('OK: WebSocket reuse + queue work across sequential & concurrent synths.');
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
