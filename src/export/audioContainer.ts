/**
 * Container-level joining of the per-sentence buffers an engine produces, plus a
 * minimal ID3 tag so the exported file shows a real title on a phone.
 *
 * MP3 (Edge): the service returns a stream of constant-bitrate frames, and MP3
 * frames are self-contained — plain concatenation yields a valid, seekable file.
 *
 * WAV (Supertonic): a RIFF file has exactly one header, so the parts have to be
 * unwrapped: keep the first `fmt ` chunk, concatenate every `data` payload, and
 * re-emit one header with the combined length.
 */

interface WavParts {
  fmt: Buffer;
  data: Buffer;
}

/** Split a RIFF/WAVE buffer into its `fmt ` chunk (header included) and raw `data` payload. */
function parseWav(buf: Buffer): WavParts {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE buffer');
  }
  let fmt: Buffer | undefined;
  const data: Buffer[] = [];
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = buf.subarray(pos + 8, Math.min(buf.length, pos + 8 + size));
    if (id === 'fmt ' && !fmt) fmt = buf.subarray(pos, pos + 8 + size);
    else if (id === 'data') data.push(body);
    pos += 8 + size + (size % 2); // RIFF chunks are word-aligned
  }
  if (!fmt || !data.length) throw new Error('WAVE buffer has no fmt/data chunk');
  return { fmt, data: Buffer.concat(data) };
}

/** Join WAV parts into a single WAV file. All parts must share one `fmt ` chunk. */
export function joinWav(parts: Buffer[]): Buffer {
  const parsed = parts.map(parseWav);
  const fmt = parsed[0].fmt;
  for (const p of parsed) {
    if (!p.fmt.equals(fmt)) throw new Error('WAV parts have different audio formats');
  }
  const data = Buffer.concat(parsed.map((p) => p.data));
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(4 + fmt.length + 8 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  const dataHeader = Buffer.alloc(8);
  dataHeader.write('data', 0, 'ascii');
  dataHeader.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, fmt, dataHeader, data]);
}

/** ID3v2.3 text frame: UTF-16LE with BOM, which every player we care about reads. */
function textFrame(id: string, value: string): Buffer {
  const body = Buffer.concat([
    Buffer.from([0x01]), // encoding: UTF-16 with BOM
    Buffer.from([0xff, 0xfe]),
    Buffer.from(value, 'utf16le'),
    Buffer.from([0x00, 0x00]), // terminator
  ]);
  const header = Buffer.alloc(10);
  header.write(id, 0, 'ascii');
  header.writeUInt32BE(body.length, 4); // v2.3 frame sizes are plain big-endian
  return Buffer.concat([header, body]);
}

/** Synchsafe integer: 7 bits per byte, as ID3v2 tag sizes require. */
function synchsafe(n: number): Buffer {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}

/** Prepend an ID3v2.3 tag (title/artist/album) to an MP3 buffer. */
export function withId3(mp3: Buffer, tags: { title: string; artist: string; album?: string }): Buffer {
  const frames = [textFrame('TIT2', tags.title), textFrame('TPE1', tags.artist)];
  if (tags.album) frames.push(textFrame('TALB', tags.album));
  const body = Buffer.concat(frames);
  const header = Buffer.concat([
    Buffer.from('ID3', 'ascii'),
    Buffer.from([0x03, 0x00]), // version 2.3.0
    Buffer.from([0x00]), // flags
    synchsafe(body.length),
  ]);
  return Buffer.concat([header, body, mp3]);
}
