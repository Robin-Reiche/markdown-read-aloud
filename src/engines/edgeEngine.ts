import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import type { TtsEngine } from '../types';

const FORMAT = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;
const SYNTH_TIMEOUT = 30000;

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
    this.closeSocket();
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, FORMAT, { voiceLocale: locale });
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
      const { audioStream } = this.tts!.toStream(escaped, { rate: '+0%', pitch: '+0Hz', volume: 100 });
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => reject(new Error('Edge TTS timeout')), SYNTH_TIMEOUT);
      audioStream.on('data', (c: Buffer) => chunks.push(c));
      audioStream.on('end', () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks));
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
