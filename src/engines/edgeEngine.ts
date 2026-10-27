import { randomUUID } from 'node:crypto';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import type { TtsEngine } from '../types';
import { secMsGecV2 } from './edgeToken';

const FORMAT = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;
const SYNTH_TIMEOUT = 30000;

/** In FORMAT (MPEG-2 Layer III, 24 kHz, 48 kbit/s) every frame is 144 bytes and 24 ms long. */
const FRAME_BYTES = 144;
const FRAME_SEC = 0.024;
/** A normal Edge sentence ends with about 0.35 s of silence. Padded clips keep the same. */
const TAIL_SEC = 0.35;
/** Less extra silence than this is left alone, so ordinary sentences stay byte for byte. */
const MIN_TRIM_SEC = 0.3;

/**
 * Microsoft has two ways into the read-aloud service and keeps closing them:
 * in October 2026 speech.platform.bing.com started to refuse the v1 token.
 * Since 23 October api.msedgeservices.com no longer opens the socket either.
 * Edge itself synthesizes on the old host with the v2 token of rany2/edge-tts,
 * so the route starts there. msedge-tts 2.1.0 only knows the new host, so its
 * URL builder is swapped for one that can take either way. The new host stays
 * as the reserve. The route is shared by all engines, so after one switch the
 * player and the export both stay on the way that works. Exported for
 * tests/edgeEngine.test.ts and the daily check in scripts/edge-probe.ts.
 */
export const edgeRoute = {
  current: 'bing' as 'msedgeservices' | 'bing',
  bingUrl: 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1',
};
const BING_TOKEN_VERSION = '2-143.0.3650.75';
// msedge-tts declares these private. tests/edgeEngine.test.ts fails when a new
// version stops building its URL through getSynthUrl.
const lib = MsEdgeTTS as unknown as {
  getSynthUrl(): Promise<string>;
  TRUSTED_CLIENT_TOKEN: string;
  _clockOffsetMs: number;
};
const libSynthUrl = lib.getSynthUrl;
lib.getSynthUrl = async () => {
  if (edgeRoute.current === 'msedgeservices') return libSynthUrl.call(MsEdgeTTS);
  const gec = secMsGecV2((Date.now() + (lib._clockOffsetMs || 0)) / 1000);
  const id = randomUUID().replace(/-/g, '');
  return (
    `${edgeRoute.bingUrl}?TrustedClientToken=${lib.TRUSTED_CLIENT_TOKEN}&ConnectionId=${id}` +
    `&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${BING_TOKEN_VERSION}`
  );
};

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * End of the last spoken word in seconds, from Edge's word boundary messages
 * (offsets and durations in 100 ns ticks). 0 when there is none or one does not
 * parse, which leaves the audio untouched.
 */
export function speechEndSec(messages: string[]): number {
  let end = 0;
  for (const m of messages) {
    try {
      for (const e of JSON.parse(m).Metadata ?? []) {
        const d = e?.Data;
        if (typeof d?.Offset === 'number' && typeof d?.Duration === 'number') {
          end = Math.max(end, (d.Offset + d.Duration) / 1e7);
        }
      }
    } catch {
      return 0;
    }
  }
  return end;
}

/**
 * Edge pads many short clips with silence up to 1.872 s, so a one-word heading
 * such as "Usage" ends with over a second of silence where a sentence has 0.35 s
 * (#5). Cut whole frames after the last word plus that usual tail. Anything that
 * does not look like the expected frame layout is returned unchanged.
 */
export function trimPadding(mp3: Buffer, speechEnd: number): Buffer {
  if (!(speechEnd > 0) || mp3.length % FRAME_BYTES !== 0) return mp3;
  const frames = mp3.length / FRAME_BYTES;
  const keep = Math.ceil((speechEnd + TAIL_SEC) / FRAME_SEC);
  if ((frames - keep) * FRAME_SEC < MIN_TRIM_SEC) return mp3;
  for (let i = 0; i <= keep; i++) {
    const o = i * FRAME_BYTES;
    if (mp3[o] !== 0xff || (mp3[o + 1] & 0xe0) !== 0xe0) return mp3;
  }
  return mp3.subarray(0, keep * FRAME_BYTES);
}

/** Derive a BCP-47 locale from a voice short name, e.g. "de-DE-Seraphina…" -> "de-DE". */
function localeFromVoice(voice: string): string {
  const m = voice.match(/^[a-z]{2,3}-[A-Za-z]{2,}/);
  return m ? m[0] : 'en-US';
}

/**
 * Microsoft Edge neural TTS via the (free, key-less) read-aloud endpoint.
 * Runs in the Node extension host.
 *
 * Every operation goes through one serial queue, and each `synth` call atomically
 * (re)connects to the requested voice if needed and then streams — so the player's
 * concurrent prefetch (and per-paragraph voice switching) can never tear the
 * WebSocket down mid-synthesis or synthesize a chunk with the wrong voice.
 */
export class EdgeEngine implements TtsEngine {
  readonly id = 'edge';
  readonly mime = 'audio/mpeg';

  private tts: MsEdgeTTS | null = null;
  private voice = '';
  private locale = '';
  private tail: Promise<unknown> = Promise.resolve();

  synth(text: string, voice: string, locale: string): Promise<Buffer> {
    const loc = locale || localeFromVoice(voice);
    return this.enqueue(() => this.synthOnce(text, voice, loc, true));
  }

  warm(voice: string, locale: string): Promise<void> {
    const loc = locale || localeFromVoice(voice);
    return this.enqueue(async () => {
      if (voice !== this.voice || loc !== this.locale || !this.tts) await this.connect(voice, loc);
    });
  }

  /** Serialize all socket-touching work; one operation at a time, FIFO. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run as Promise<T>;
  }

  private async connect(voice: string, locale: string): Promise<void> {
    const tried = edgeRoute.current;
    try {
      await this.open(voice, locale);
    } catch (err) {
      // Refused or unreachable: try the other way in and keep it only when it
      // connects, so one hiccup cannot strand every engine on a blocked host.
      // A timeout would most likely hit that way too and only delay the
      // switch to system voices. Offline, both fail fast and nothing changes.
      if (err instanceof Error && /timed out/i.test(err.message)) throw err;
      const other = tried === 'bing' ? 'msedgeservices' : 'bing';
      edgeRoute.current = other;
      try {
        await this.open(voice, locale);
      } catch (otherErr) {
        if (edgeRoute.current === other) edgeRoute.current = tried;
        throw otherErr;
      }
    }
  }

  private async open(voice: string, locale: string): Promise<void> {
    this.closeSocket();
    const tts = new MsEdgeTTS();
    // Word boundaries tell where speech ends, so trimPadding can cut the padding.
    await tts.setMetadata(voice, FORMAT, { voiceLocale: locale, wordBoundaryEnabled: true });
    this.tts = tts;
    this.voice = voice;
    this.locale = locale;
  }

  private async synthOnce(text: string, voice: string, locale: string, retry: boolean): Promise<Buffer> {
    const escaped = xmlEscape(text);
    if (!escaped.trim()) return Buffer.alloc(0);
    if (voice !== this.voice || locale !== this.locale || !this.tts) {
      await this.connect(voice, locale);
    }

    try {
      const buf = await this.streamToBuffer(escaped);
      // A mid-stream socket close ends the readable cleanly with truncated/empty
      // bytes (no 'error'). Treat an empty result for real text as a failure and
      // retry once on a fresh connection.
      if (buf.length === 0 && retry) {
        await this.connect(voice, locale);
        return this.synthOnce(text, voice, locale, false);
      }
      return buf;
    } catch (err) {
      if (retry) {
        await this.connect(voice, locale);
        return this.synthOnce(text, voice, locale, false);
      }
      throw err;
    }
  }

  private streamToBuffer(escaped: string): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const { audioStream, metadataStream } = this.tts!.toStream(escaped, { rate: '+0%', pitch: '+0Hz', volume: 100 });
      const chunks: Buffer[] = [];
      // Attached right away, so every message arrives as its own chunk. Edge sends
      // them before the turn ends, so all are in when the audio ends.
      const metadata: string[] = [];
      metadataStream?.on('data', (c: Buffer) => metadata.push(c.toString('utf8')));
      const timer = setTimeout(() => reject(new Error('Edge TTS timeout')), SYNTH_TIMEOUT);
      audioStream.on('data', (c: Buffer) => chunks.push(c));
      audioStream.on('end', () => {
        clearTimeout(timer);
        resolve(trimPadding(Buffer.concat(chunks), speechEndSec(metadata)));
      });
      audioStream.on('error', (e: Error) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  private closeSocket(): void {
    if (this.tts) {
      try {
        this.tts.close();
      } catch {
        /* ignore */
      }
      this.tts = null;
    }
  }

  dispose(): void {
    this.closeSocket();
    this.voice = '';
    this.locale = '';
  }
}
