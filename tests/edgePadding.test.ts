import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { speechEndSec, trimPadding } from '../src/engines/edgeEngine';

/** Edge's MP3 layout: 144-byte frames of 24 ms, each starting with the MPEG sync word. */
function frames(n: number): Buffer {
  const buf = Buffer.alloc(n * 144);
  for (let i = 0; i < n; i++) {
    buf[i * 144] = 0xff;
    buf[i * 144 + 1] = 0xf3;
    buf[i * 144 + 2] = i % 256; // tells frames apart
  }
  return buf;
}

/** One word boundary message as Edge sends it (times in 100 ns ticks). */
function boundary(word: string, offset: number, duration: number): string {
  return JSON.stringify({
    Metadata: [{ Type: 'WordBoundary', Data: { Offset: offset, Duration: duration, text: { Text: word, Length: word.length } } }],
  });
}

test('cuts the padding after a one-word heading down to the usual tail', () => {
  // Measured: "Usage" is 78 frames (1.872 s) and the word ends at 0.613 s.
  const clip = frames(78);
  const out = trimPadding(clip, speechEndSec([boundary('Usage', 875000, 5250000)]));
  assert.equal(out.length, 41 * 144); // 0.613 s + 0.35 s, rounded up to whole frames
  assert.deepEqual(out, clip.subarray(0, 41 * 144));
});

test('leaves an ordinary sentence untouched', () => {
  // Measured: 128 frames (3.072 s), last word ends at 2.725 s, so 0.35 s of silence.
  const clip = frames(128);
  assert.equal(trimPadding(clip, 2.725), clip);
});

test('leaves the audio untouched without usable word boundaries', () => {
  const clip = frames(78);
  assert.equal(trimPadding(clip, speechEndSec([])), clip);
  assert.equal(speechEndSec(['{"Metadata":[{"Type":"WordBoundary"']), 0);
  assert.equal(speechEndSec(['{"Metadata":[{"Type":"SessionEnd","Data":{}}]}']), 0);
});

test('leaves audio alone that does not have the expected frame layout', () => {
  const odd = Buffer.concat([frames(78), Buffer.alloc(10)]);
  assert.equal(trimPadding(odd, 0.613), odd);
  const broken = frames(78);
  broken[20 * 144] = 0x00; // no sync word inside the part that would be kept
  assert.equal(trimPadding(broken, 0.613), broken);
});

test('takes the end of the last word across several messages', () => {
  const messages = [boundary('Getting', 625000, 2125000), boundary('line', 15125000, 4000000), boundary('started', 2875000, 4500000)];
  assert.equal(speechEndSec(messages), 1.9125);
});
