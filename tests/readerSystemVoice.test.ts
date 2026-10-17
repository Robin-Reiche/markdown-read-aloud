import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

// media/reader.js runs in the webview and is not bundled, so the test lifts the
// system-voice block out of the file and drives speak() with fake voice lists.
// The bundled test sits in .test-dist/, one level below the repo root.
const src = fs.readFileSync(path.join(__dirname, '..', 'media', 'reader.js'), 'utf8');
const start = src.indexOf('  /* browser engine fallback */');
const end = src.indexOf('  function restartUtterance()');
assert.ok(start >= 0 && end > start, 'system-voice block not found in media/reader.js');
const block = src.slice(start, end);

type Voice = { name: string; lang: string; default: boolean };
const V = (name: string, lang: string): Voice => ({ name, lang, default: false });

class FakeSynth {
  spoken: any[] = [];
  listeners = new Set<() => void>();
  constructor(public voices: Voice[]) {}
  getVoices() { return this.voices; }
  cancel() {}
  speak(u: any) { this.spoken.push(u); }
  addEventListener(_t: string, f: () => void) { this.listeners.add(f); }
  removeEventListener(_t: string, f: () => void) { this.listeners.delete(f); }
  setVoices(v: Voice[]) { this.voices = v; for (const f of [...this.listeners]) f(); }
}
class FakeUtterance {
  voice: Voice | null = null;
  lang = '';
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  constructor(public text: string) {}
}

function reader(voices: Voice[], locale = 'en-US', segs: [string, string][] = [['Hello there.', 'en'], ['Second one.', 'en']], autoLang = false) {
  const synth = new FakeSynth(voices);
  const state = { autoLang, idx: 0, rate: 1, volume: 1, muted: false, playing: true, engine: 'browser' };
  const posts: any[] = [];
  const advanced: number[] = [];
  const env: Record<string, unknown> = {
    state, vu: { locale }, SEGMENTS: segs.map(([text, lang]) => ({ text, lang })),
    speechSynthesis: synth, SpeechSynthesisUtterance: FakeUtterance,
    activate() {}, finishAll() {}, post: (m: any) => posts.push(m),
    setPlaying: (p: boolean) => { state.playing = p; },
    advance: () => { advanced.push(state.idx); state.idx++; },
  };
  const names = Object.keys(env);
  const api = new Function(...names, block + '\nreturn { speak, initSynthVoices };')(...names.map((k) => env[k]));
  api.initSynthVoices();
  return { speak: api.speak as (i: number) => void, synth, state, posts, advanced };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lastSpoken = (s: FakeSynth) => s.spoken[s.spoken.length - 1];

const deOnly = [V('Hedda', 'de-DE'), V('Katja', 'de-DE')];
const deEn = [V('Hedda', 'de-DE'), V('George', 'en-GB'), V('Zira', 'en-US')];

test('an English document never gets a German voice: it pauses and says why (issue #5)', () => {
  const r = reader(deOnly);
  r.speak(0);
  assert.equal(r.synth.spoken.length, 0);
  assert.equal(r.state.playing, false);
  assert.deepEqual(r.posts, [{ type: 'noSystemVoice', lang: 'en', anyVoices: true }]);
});

test('prefers the exact locale over the same base language', () => {
  const r = reader(deEn);
  r.speak(0);
  assert.equal(lastSpoken(r.synth).voice.name, 'Zira');
  assert.equal(lastSpoken(r.synth).lang, 'en-US');
});

test('matches base languages, not prefixes: Finnish does not get a Filipino voice', () => {
  const r = reader([V('Angelo', 'fil-PH')], 'fi-FI', [['Hei.', 'fi']]);
  r.speak(0);
  assert.equal(r.synth.spoken.length, 0);
  assert.equal(r.posts[0].lang, 'fi');
});

test('auto-language: a heading guessed as English in a German document keeps the German voice', () => {
  const r = reader(deOnly, 'de-DE', [['Installation', 'en'], ['Das ist ein Satz.', 'de']], true);
  r.speak(0);
  assert.equal(lastSpoken(r.synth).voice.name, 'Hedda');
  assert.deepEqual(r.posts, []);
});

test('waits for voices that arrive late instead of speaking without one', async () => {
  const r = reader([]);
  r.speak(0);
  r.synth.setVoices([]); // Chromium can report an empty list first
  assert.equal(r.synth.spoken.length, 0);
  r.synth.setVoices(deEn);
  await sleep(10);
  assert.equal(lastSpoken(r.synth).voice.name, 'Zira');
});

test('a stop during the voice wait wins: nothing is spoken when the voices arrive', async () => {
  const r = reader([]);
  r.speak(0);
  r.state.playing = false;
  r.synth.setVoices(deEn);
  await sleep(10);
  assert.equal(r.synth.spoken.length, 0);
  assert.deepEqual(r.posts, []);
});

test('without any system voice it pauses and says so instead of hanging', async () => {
  const r = reader([]);
  r.speak(0);
  await sleep(1700);
  assert.equal(r.synth.spoken.length, 0);
  assert.equal(r.state.playing, false);
  assert.deepEqual(r.posts, [{ type: 'noSystemVoice', lang: 'en', anyVoices: false }]);
});

test('a failed utterance skips once and pauses on the second failure in a row', () => {
  const r = reader(deEn);
  r.speak(0);
  lastSpoken(r.synth).onerror({ error: 'interrupted' });
  assert.deepEqual(r.advanced, []);
  lastSpoken(r.synth).onerror({ error: 'synthesis-failed' });
  assert.deepEqual(r.advanced, [0]);
  r.speak(1);
  lastSpoken(r.synth).onerror({ error: 'synthesis-failed' });
  assert.equal(r.state.playing, false);
  assert.equal(r.state.idx, 0, 'play should retry the first failed sentence, not lose it');
  assert.equal(r.posts[0].error, 'synthesis-failed');
});

test('a cancel between two failures means they were not in a row', () => {
  const r = reader(deEn, 'en-US', [['One.', 'en'], ['Two.', 'en'], ['Three.', 'en']]);
  r.speak(0);
  lastSpoken(r.synth).onerror({ error: 'synthesis-failed' });
  r.speak(1);
  lastSpoken(r.synth).onerror({ error: 'interrupted' });
  r.state.idx = 2;
  r.speak(2);
  lastSpoken(r.synth).onerror({ error: 'synthesis-failed' });
  assert.equal(r.state.playing, true);
  assert.deepEqual(r.posts, []);
});
