import * as http from 'node:http';
import type { TtsEngine } from '../types';

/** Fixed loopback address. Ollama listens on 127.0.0.1:11434 unless told otherwise. */
const OLLAMA_HOST = '127.0.0.1';
export const OLLAMA_DEFAULT_PORT = 11434;
export const OLLAMA_DEFAULT_MODEL = 'phonon';

/**
 * Ollama refuses speech input over 4,096 characters. It counts code points and
 * `string.length` counts UTF-16 units, so this check is never more lenient.
 */
export const OLLAMA_MAX_INPUT_LENGTH = 4096;

/** 16-bit mono 24 kHz is 48 KB per second: 32 MB is over ten minutes of one sentence. */
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT = 5_000;
const DEFAULT_TOTAL_TIMEOUT = 45_000;
const SHOW_TIMEOUT = 3_000;
/** `/api/show` carries the license and Modelfile text, so it is larger than a health ping. */
const SHOW_MAX_RESPONSE_BYTES = 1024 * 1024;

const WAV_MIMES = new Set(['audio/wav', 'audio/x-wav', 'audio/wave']);

/** `name`, `name:tag`, `namespace/name:tag` or `host/namespace/name:tag`. */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._\-/:]{0,199}$/;

export interface OllamaOptions {
  /** Loopback port. Only tests change it, the extension always uses the default. */
  port?: number;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxResponseBytes?: number;
}

/** The configured model name, or the default when the setting is empty. */
export function ollamaModel(configured: string | undefined): string {
  return (configured || '').trim() || OLLAMA_DEFAULT_MODEL;
}

/** Ollama's own clients treat a `cloud` tag or a `-cloud` suffix as a cloud model. */
function isCloudName(model: string): boolean {
  const tag = model.includes(':') ? model.slice(model.lastIndexOf(':') + 1) : '';
  return tag === 'cloud' || model.endsWith('-cloud');
}

/** Same wording as Supertonic for the same transport failures, with Ollama named. */
function describeTransportError(e: NodeJS.ErrnoException): Error {
  if (e.code === 'ECONNREFUSED') return new Error('Ollama is not running');
  if (e.code === 'ECONNRESET' || e.code === 'EPIPE') return new Error('Ollama stopped mid-request');
  return e;
}

interface ShowInfo {
  capabilities?: unknown;
  remote_host?: unknown;
  remote_model?: unknown;
}

/**
 * Offline TTS through a local Ollama server and one of its speech models (Phonon).
 * Speaks Ollama's OpenAI-compatible `POST /v1/audio/speech` and returns WAV audio.
 *
 * For this engine the `voice` argument carries the Ollama model name. Every Phonon
 * tag is one language, and the request names no voice, so the model's own default
 * voice speaks. The locale is not sent: Ollama rejects options it does not know.
 *
 * Fail-closed like Supertonic. Before the first sentence for a model, `/api/show`
 * must confirm the model is installed, can speak and runs on this machine. Ollama
 * forwards cloud models to ollama.com, which would send the document text there.
 */
export class OllamaEngine implements TtsEngine {
  readonly id = 'ollama';
  readonly mime = 'audio/wav';

  private readonly port: number;
  private readonly connectTimeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly verified = new Map<string, Promise<void>>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: OllamaOptions = {}) {
    this.port = options.port ?? OLLAMA_DEFAULT_PORT;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT;
    this.totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  synth(text: string, model: string, _locale: string): Promise<Buffer> {
    if (!text.trim()) return Promise.resolve(Buffer.alloc(0));
    if (text.length > OLLAMA_MAX_INPUT_LENGTH) {
      return Promise.reject(new Error(`Ollama input exceeds ${OLLAMA_MAX_INPUT_LENGTH} characters`));
    }
    const body = JSON.stringify({ model, input: text, response_format: 'wav' });
    return this.enqueue(async () => {
      await this.ensureLocal(model);
      return this.request(body);
    });
  }

  /** Availability probe: `/api/show` for the model. Never sends document text. */
  warm(model: string, _locale: string): Promise<void> {
    return this.ensureLocal(model);
  }

  /** Checked once per model and engine. A failed check is forgotten, so Retry checks again. */
  private ensureLocal(model: string): Promise<void> {
    let check = this.verified.get(model);
    if (!check) {
      check = this.checkModel(model);
      this.verified.set(model, check);
      check.catch(() => this.verified.delete(model));
    }
    return check;
  }

  private async checkModel(model: string): Promise<void> {
    if (!MODEL_NAME.test(model)) throw new Error('Ollama model name is not valid');
    if (isCloudName(model)) throw new Error(`Ollama model "${model}" runs in the cloud, not on this machine`);
    const { status, raw } = await this.show(model);
    if (status === 404) throw new Error(`Ollama model "${model}" is not installed`);
    if (status !== 200) throw new Error(`Ollama returned HTTP ${status} for the model check`);
    let info: ShowInfo;
    try {
      info = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new Error('Ollama returned an unexpected model check response');
    }
    if (info.remote_host || info.remote_model) {
      throw new Error(`Ollama model "${model}" runs in the cloud, not on this machine`);
    }
    if (!Array.isArray(info.capabilities) || !info.capabilities.includes('speech')) {
      throw new Error(`Ollama model "${model}" is not a speech model`);
    }
  }

  private show(model: string): Promise<{ status: number; raw: Buffer }> {
    const body = JSON.stringify({ model });
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: OLLAMA_HOST,
          port: this.port,
          path: '/api/show',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
          timeout: SHOW_TIMEOUT,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let received = 0;
          res.on('data', (c: Buffer) => {
            received += c.length;
            if (received > SHOW_MAX_RESPONSE_BYTES) {
              req.destroy(new Error('Ollama model check response is too large'));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, raw: Buffer.concat(chunks) }));
          res.on('error', (e: NodeJS.ErrnoException) => reject(describeTransportError(e)));
        }
      );
      req.on('timeout', () => req.destroy(new Error('Ollama model check timed out')));
      req.on('error', (e: NodeJS.ErrnoException) => reject(describeTransportError(e)));
      req.end(body);
    });
  }

  /** One request at a time, FIFO, like Supertonic: a local model speaks one sentence at a time. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run as Promise<T>;
  }

  private request(body: string): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      let settled = false;
      const chunks: Buffer[] = [];
      let received = 0;

      const req = http.request({
        host: OLLAMA_HOST,
        port: this.port,
        path: '/v1/audio/speech',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          accept: 'audio/wav',
        },
        // Socket idle timeout for the connect phase only, as in the Supertonic engine.
        // Ollama may load the model before the first byte, the total timer covers that.
        timeout: this.connectTimeoutMs,
      });

      req.on('socket', (socket) => {
        if (socket.connecting) socket.once('connect', () => req.setTimeout(0));
        else req.setTimeout(0);
      });

      const totalTimer = setTimeout(() => fail(new Error('Ollama synthesis timed out')), this.totalTimeoutMs);

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(totalTimer);
        req.destroy();
        reject(err);
      };
      const succeed = (buf: Buffer) => {
        if (settled) return;
        settled = true;
        clearTimeout(totalTimer);
        resolve(buf);
      };

      req.on('timeout', () => fail(new Error('Ollama connection timed out')));
      req.on('error', (e: NodeJS.ErrnoException) => fail(describeTransportError(e)));

      req.on('response', (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          return fail(new Error('Ollama sent a redirect, which is not allowed'));
        }
        if (status !== 200) {
          return fail(new Error(`Ollama returned HTTP ${status}`));
        }
        const mime = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (!WAV_MIMES.has(mime)) {
          return fail(new Error('Ollama returned an unexpected content-type'));
        }
        res.on('data', (c: Buffer) => {
          received += c.length;
          if (received > this.maxResponseBytes) {
            return fail(new Error('Ollama response is too large'));
          }
          chunks.push(c);
        });
        res.on('end', () => {
          try {
            succeed(finishStreamedWav(Buffer.concat(chunks)));
          } catch (err: any) {
            fail(err);
          }
        });
        // Ollama closes the connection when synthesis fails after the first audio,
        // so a stream that ends without completing is partial audio, not a sentence.
        res.on('close', () => {
          if (!res.complete) fail(new Error('Ollama stopped mid-request'));
        });
        res.on('error', (e: NodeJS.ErrnoException) => fail(describeTransportError(e)));
      });

      req.end(body);
    });
  }

  dispose(): void {
    // Nothing to release. Sockets live per request and are bounded by the total timeout.
  }
}

/**
 * Ollama streams WAV and writes the header before the length is known, so both size
 * fields hold 0xFFFFFFFF. Write the real sizes, so the reader and the export see an
 * ordinary WAV file. The header is the fixed 44-byte PCM layout Ollama always sends.
 */
export function finishStreamedWav(buf: Buffer): Buffer {
  if (
    buf.length < 44 ||
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 16) !== 'WAVEfmt ' ||
    buf.readUInt32LE(16) !== 16 ||
    buf.toString('ascii', 36, 40) !== 'data'
  ) {
    throw new Error('Ollama response is not valid WAV audio');
  }
  buf.writeUInt32LE(buf.length - 8, 4);
  buf.writeUInt32LE(buf.length - 44, 40);
  return buf;
}
