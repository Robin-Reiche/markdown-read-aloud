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
 * IMPORTANT: every operation that touches the shared WebSocket — both `setVoice`
 * (which reconnects) and `synth` — is funneled through a single serial queue, so
 * a reconnect can NEVER tear down the socket while a synthesis is mid-stream.
 * That race previously produced truncated audio and spurious "offline" fallbacks.
 */
export class EdgeEngine implements TtsEngine {
  readonly id = 'edge';
  readonly mime = 'audio/mpeg';

  private tts: MsEdgeTTS | null = null;
  private voice = '';
  private locale = '';
  private targetVoice = '';
  private targetLocale = '';
  private tail: Promise<unknown> = Promise.resolve();

  setVoice(voiceShortName: string, locale?: string): Promise<void> {
    this.targetVoice = voiceShortName;
    this.targetLocale = locale || localeFromVoice(voiceShortName);
    return this.enqueue(async () => {
      if (this.voice === this.targetVoice && this.locale === this.targetLocale && this.tts) return;
      await this.connect(this.targetVoice, this.targetLocale);
    });
  }

  synth(text: string): Promise<Buffer> {
    return this.enqueue(() => this.synthOnce(text));
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
    // voiceLocale sets the SSML xml:lang, which pins the language a multilingual
    // voice speaks in (so a German doc isn't occasionally read as French, etc.).
    await tts.setMetadata(voice, FORMAT, { voiceLocale: locale });
    this.tts = tts;
    this.voice = voice;
    this.locale = locale;
  }

  private async synthOnce(text: string, retry = true): Promise<Buffer> {
    const escaped = xmlEscape(text);
    if (!escaped.trim()) return Buffer.alloc(0);
    if (!this.tts) await this.connect(this.targetVoice || this.voice, this.targetLocale || this.locale);

    try {
      const buf = await this.streamToBuffer(escaped);
      // A mid-stream socket close ends the readable cleanly with truncated/empty
      // bytes (no 'error'). Treat an empty result for real text as a failure and
      // retry once on a fresh connection.
      if (buf.length === 0 && retry) {
        await this.connect(this.voice, this.locale);
        return this.synthOnce(text, false);
      }
      return buf;
    } catch (err) {
      if (retry) {
        await this.connect(this.voice, this.locale);
        return this.synthOnce(text, false);
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
