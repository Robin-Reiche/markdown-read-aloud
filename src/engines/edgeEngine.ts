import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import type { TtsEngine } from '../types';

const FORMAT = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;
const SYNTH_TIMEOUT = 30000;

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Microsoft Edge neural TTS via the (free, key-less) read-aloud endpoint.
 * Runs in the Node extension host. Synthesis is serialized through a queue and
 * the WebSocket is transparently re-opened if it has dropped.
 */
export class EdgeEngine implements TtsEngine {
  readonly id = 'edge';
  readonly mime = 'audio/mpeg';

  private tts: MsEdgeTTS | null = null;
  private voice = '';
  private queue: Promise<unknown> = Promise.resolve();

  async setVoice(voiceShortName: string): Promise<void> {
    if (voiceShortName === this.voice && this.tts) return;
    this.voice = voiceShortName;
    await this.connect();
  }

  private async connect(): Promise<void> {
    this.dispose();
    const tts = new MsEdgeTTS();
    await tts.setMetadata(this.voice, FORMAT);
    this.tts = tts;
  }

  synth(text: string): Promise<Buffer> {
    const run = () => this.synthOnce(text);
    // serialize: one synthesis at a time over the shared WebSocket
    const p = this.queue.then(run, run);
    this.queue = p.then(
      () => undefined,
      () => undefined
    );
    return p;
  }

  private async synthOnce(text: string, retry = true): Promise<Buffer> {
    const escaped = xmlEscape(text);
    if (!escaped.trim()) return Buffer.alloc(0);
    if (!this.tts) await this.connect();

    try {
      return await this.streamToBuffer(escaped);
    } catch (err) {
      if (retry) {
        // WebSocket likely went idle/closed — reconnect once and retry.
        await this.connect();
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

  dispose(): void {
    if (this.tts) {
      try {
        this.tts.close();
      } catch {
        /* ignore */
      }
      this.tts = null;
    }
  }
}
