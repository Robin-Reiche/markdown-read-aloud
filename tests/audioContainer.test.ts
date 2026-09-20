import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { joinWav, withId3 } from '../src/export/audioContainer';

/** Minimal 16-bit PCM WAV with the given payload. */
function wav(data: Buffer, sampleRate = 24000, channels = 1): Buffer {
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); // PCM
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * channels * 2, 16); // byte rate
  fmt.writeUInt16LE(channels * 2, 20); // block align
  fmt.writeUInt16LE(16, 22); // bits per sample

  const dataHeader = Buffer.alloc(8);
  dataHeader.write('data', 0, 'ascii');
  dataHeader.writeUInt32LE(data.length, 4);

  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(4 + fmt.length + 8 + data.length, 4);
  riff.write('WAVE', 8, 'ascii');
  return Buffer.concat([riff, fmt, dataHeader, data]);
}

test('joins WAV parts into one file with the combined payload', () => {
  const a = Buffer.from([1, 2, 3, 4]);
  const b = Buffer.from([5, 6]);
  const out = joinWav([wav(a), wav(b)]);

  assert.equal(out.toString('ascii', 0, 4), 'RIFF');
  assert.equal(out.toString('ascii', 8, 12), 'WAVE');
  assert.equal(out.readUInt32LE(4), out.length - 8, 'RIFF size counts everything after the size field');

  const dataAt = out.indexOf('data', 12, 'ascii');
  const size = out.readUInt32LE(dataAt + 4);
  assert.equal(size, a.length + b.length);
  assert.deepEqual(out.subarray(dataAt + 8, dataAt + 8 + size), Buffer.concat([a, b]));
});

test('skips a LIST chunk sitting between fmt and data', () => {
  const base = wav(Buffer.from([7, 8]));
  const list = Buffer.alloc(8 + 4);
  list.write('LIST', 0, 'ascii');
  list.writeUInt32LE(4, 4);
  list.write('INFO', 8, 'ascii');
  const fmtEnd = base.indexOf('data', 12, 'ascii');
  const withList = Buffer.concat([base.subarray(0, fmtEnd), list, base.subarray(fmtEnd)]);

  const out = joinWav([withList]);
  const dataAt = out.indexOf('data', 12, 'ascii');
  assert.deepEqual(out.subarray(dataAt + 8), Buffer.from([7, 8]));
});

test('refuses to join parts recorded in different formats', () => {
  assert.throws(
    () => joinWav([wav(Buffer.from([1]), 24000), wav(Buffer.from([2]), 48000)]),
    /different audio formats/
  );
});

test('rejects a buffer that is not RIFF/WAVE', () => {
  assert.throws(() => joinWav([Buffer.from('not audio at all')]), /not a RIFF\/WAVE buffer/);
});

test('prepends a well-formed ID3v2.3 tag and keeps the audio intact', () => {
  const audio = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
  const out = withId3(audio, { title: 'Meeting Notes', artist: 'Markdown Read Aloud' });

  assert.equal(out.toString('ascii', 0, 3), 'ID3');
  assert.equal(out[3], 3, 'major version 2.3');
  assert.equal(out[4], 0);
  assert.equal(out[5], 0, 'no tag flags');

  const tagSize = (out[6] << 21) | (out[7] << 14) | (out[8] << 7) | out[9];
  for (const b of out.subarray(6, 10)) assert.ok(b < 0x80, 'tag size bytes are synchsafe');
  assert.deepEqual(out.subarray(10 + tagSize), audio, 'audio follows the tag byte-for-byte');

  // first frame: TIT2, UTF-16 with BOM
  assert.equal(out.toString('ascii', 10, 14), 'TIT2');
  const frameSize = out.readUInt32BE(14);
  const body = out.subarray(20, 20 + frameSize);
  assert.equal(body[0], 0x01, 'UTF-16 encoding byte');
  assert.deepEqual(body.subarray(1, 3), Buffer.from([0xff, 0xfe]), 'little-endian BOM');
  assert.equal(body.subarray(3, body.length - 2).toString('utf16le'), 'Meeting Notes');

  assert.ok(out.includes(Buffer.from('TPE1', 'ascii')), 'artist frame present');
});

test('tag size stays synchsafe for a title long enough to need the second byte', () => {
  const out = withId3(Buffer.alloc(0), { title: 'x'.repeat(200), artist: 'Markdown Read Aloud' });
  for (const b of out.subarray(6, 10)) assert.ok(b < 0x80);
  const tagSize = (out[6] << 21) | (out[7] << 14) | (out[8] << 7) | out[9];
  assert.equal(out.length, 10 + tagSize);
});
